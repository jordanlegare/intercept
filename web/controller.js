(() => {
  "use strict";

  const script = document.currentScript;
  const sessionId = script && script.dataset.session;
  const upstreamOrigin = script && script.dataset.upstreamOrigin;
  if (!sessionId || !upstreamOrigin) return;

  const sessionPrefix = "/p/" + encodeURIComponent(sessionId);
  const rawFetch = window.fetch.bind(window);
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const queue = [];
  const eventBuffer = [];
  let authorityFrame = null;
  let gateState = "waiting";
  let replaying = false;
  let lastListenerReport = 0;
  let eventFlushInFlight = false;
  const nativeSetAttribute = Element.prototype.setAttribute;
  let toolbarHost = null;
  let toolbarRoot = null;
  let toolbarFallback = null;
  let toolbarObserver = null;
  let observedDocumentElement = null;
  let authorityReady = false;
  let authorityRetryCount = 0;
  let authorityRetryTimer = null;
  let telemetryStarted = false;

  // These are proxy-control-plane diagnostics, not page activity. Excluding
  // them prevents the status poll and iframe lifecycle from filling the event
  // stream with Intercept's own housekeeping.
  const INTERNAL_AUTHORITY_EVENTS = new Set([
    "authority_status_received",
    "authority_frame_load",
    "authority_frame_error",
    "authority_frame_retry",
    "authority_frame_ready",
    "authority_host_removed",
    "controller_loaded"
  ]);

  function record(kind, target, detail) {
    if (INTERNAL_AUTHORITY_EVENTS.has(kind)) return;
    eventBuffer.push({
      kind: String(kind).slice(0, 80),
      target: String(target || "").slice(0, 240),
      detail: String(detail || "").slice(0, 300)
    });
    if (eventBuffer.length > 120) eventBuffer.shift();
  }


  let nativeLocalStorage = null;
  let nativeSessionStorage = null;
  try { nativeLocalStorage = window.localStorage; } catch (_) {}
  try { nativeSessionStorage = window.sessionStorage; } catch (_) {}
  const cookieEndpoint = location.origin + "/_intercept/cookies";
  const cookieToken = String(script.dataset.cookieToken || "");
  script.removeAttribute("data-cookie-token");
  let cookieMirror = String(script.dataset.cookieSeed || "");
  let cookieWriteQueue = Promise.resolve();
  let cookieWritesPending = 0;

  function scopedStorage(nativeStorage, kind) {
    const prefix = "__intercept_v1__:" + kind + ":" + encodeURIComponent(upstreamOrigin) + ":";
    const scopedKeys = () => {
      const keys = [];
      for (let index = 0; index < nativeStorage.length; index++) {
        const key = nativeStorage.key(index);
        if (key && key.startsWith(prefix)) keys.push(key.slice(prefix.length));
      }
      return keys;
    };
    const bridgedStorageEvents = new WeakSet();
    nativeAdd.call(window, "storage", event => {
      if (bridgedStorageEvents.has(event) || event.storageArea !== nativeStorage) return;
      event.stopImmediatePropagation();
      if (!event.key || !event.key.startsWith(prefix)) return;
      const scopedEvent = new StorageEvent("storage", {
        key: event.key.slice(prefix.length),
        oldValue: event.oldValue,
        newValue: event.newValue,
        url: event.url
      });
      bridgedStorageEvents.add(scopedEvent);
      window.dispatchEvent(scopedEvent);
    }, true);
    const target = Object.create(window.Storage ? window.Storage.prototype : Object.prototype);
    Object.defineProperties(target, {
      length: {configurable: true, enumerable: true, get: () => scopedKeys().length},
      key: {configurable: true, value: index => scopedKeys()[Number(index)] ?? null},
      getItem: {configurable: true, value: key => nativeStorage.getItem(prefix + String(key))},
      setItem: {configurable: true, value: (key, value) => nativeStorage.setItem(prefix + String(key), String(value))},
      removeItem: {configurable: true, value: key => nativeStorage.removeItem(prefix + String(key))},
      clear: {configurable: true, value: () => scopedKeys().forEach(key => nativeStorage.removeItem(prefix + key))}
    });
    return new Proxy(target, {
      get(object, property, receiver) {
        if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
        if (typeof property === "string") return nativeStorage.getItem(prefix + property) ?? undefined;
        return undefined;
      },
      set(object, property, value, receiver) {
        if (typeof property !== "string" || Reflect.has(object, property)) {
          return Reflect.set(object, property, value, receiver);
        }
        nativeStorage.setItem(prefix + property, String(value));
        return true;
      },
      deleteProperty(object, property) {
        if (typeof property === "string" && !Reflect.has(object, property)) {
          nativeStorage.removeItem(prefix + property);
          return true;
        }
        return Reflect.deleteProperty(object, property);
      },
      ownKeys(object) {
        return [...new Set([...Reflect.ownKeys(object), ...scopedKeys()])];
      },
      getOwnPropertyDescriptor(object, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
        if (descriptor) return descriptor;
        if (typeof property === "string" && scopedKeys().includes(property)) {
          return {configurable: true, enumerable: true, writable: true, value: nativeStorage.getItem(prefix + property)};
        }
        return undefined;
      }
    });
  }

  function recordStorageShimFailure(error) {
    try { console.warn("Intercept could not install origin-scoped Web Storage", error); } catch (_) {}
  }

  try {
    if (nativeLocalStorage) {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: scopedStorage(nativeLocalStorage, "local")
      });
    }
    if (nativeSessionStorage) {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: scopedStorage(nativeSessionStorage, "session")
      });
    }
  } catch (error) {
    recordStorageShimFailure(error);
  }

  function updateCookieMirror(assignment) {
    const pair = String(assignment).split(";")[0].trim();
    const separator = pair.indexOf("=");
    if (separator <= 0) return;
    const name = pair.slice(0, separator).trim();
    const expires = String(assignment).match(/(?:^|;)\s*expires\s*=\s*([^;]+)/i);
    const maxAge = String(assignment).match(/(?:^|;)\s*max-age\s*=\s*(-?\d+)/i);
    const expired = (maxAge && Number(maxAge[1]) <= 0)
      || (expires && Number.isFinite(Date.parse(expires[1])) && Date.parse(expires[1]) <= Date.now());
    const values = cookieMirror ? cookieMirror.split(/;\s*/) : [];
    const filtered = values.filter(value => value.split("=", 1)[0] !== name);
    if (!expired) filtered.push(pair);
    cookieMirror = filtered.join("; ");
  }

  async function readCookieBridgeResponse(response, operation) {
    const body = await response.text();
    if (!response.ok) {
      // Axum returns a short plain-text reason for rejected bridge requests.
      // Include it in the event stream so HTTP 400s can be diagnosed without
      // logging or exposing the cookie assignment itself.
      const detail = body.replace(/\s+/g, " ").trim().slice(0, 220);
      throw new Error(operation + " returned HTTP " + response.status
        + (detail ? ": " + detail : ""));
    }
    try {
      return body ? JSON.parse(body) : {};
    } catch (_) {
      throw new Error(operation + " returned invalid JSON");
    }
  }

  function queueCookieWrite(assignment) {
    cookieWritesPending++;
    const body = JSON.stringify({target: location.pathname + location.search, cookie: String(assignment)});
    cookieWriteQueue = cookieWriteQueue.then(() => rawFetch(cookieEndpoint, {
      method: "POST",
      headers: {"content-type": "application/json", "X-Intercept-Cookie-Token": cookieToken},
      credentials: "same-origin",
      cache: "no-store",
      body
    })).then(response => readCookieBridgeResponse(response, "Cookie bridge write")).then(data => {
      cookieMirror = String(data.cookie || "");
    }).catch(error => {
      record("cookie_bridge_error", location.pathname, String(error && error.message || error));
      refreshCookieMirror();
    }).finally(() => {
      cookieWritesPending = Math.max(0, cookieWritesPending - 1);
      if (cookieWritesPending === 0) flushCookieDeferredActions();
    });
  }

  function refreshCookieMirror() {
    const target = encodeURIComponent(location.pathname + location.search);
    return cookieWriteQueue.then(() => rawFetch(cookieEndpoint + "?target=" + target, {
      headers: {"X-Intercept-Cookie-Token": cookieToken},
      credentials: "same-origin",
      cache: "no-store"
    })).then(response => readCookieBridgeResponse(response, "Cookie bridge refresh")).then(data => {
      cookieMirror = String(data.cookie || "");
    }).catch(error => {
      record("cookie_bridge_error", location.pathname, String(error && error.message || error));
    });
  }

  try {
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      enumerable: true,
      get() { return cookieMirror; },
      set(value) {
        updateCookieMirror(value);
        queueCookieWrite(value);
      }
    });
  } catch (error) {
    try {
      Object.defineProperty(document, "cookie", {
        configurable: true,
        get() { return cookieMirror; },
        set(value) {
          updateCookieMirror(value);
          queueCookieWrite(value);
        }
      });
    } catch (_) {
      console.warn("Intercept could not install the document.cookie bridge", error);
    }
  }

  ["pushState", "replaceState"].forEach(method => {
    const nativeMethod = history[method];
    if (typeof nativeMethod !== "function") return;
    history[method] = function(...args) {
      const result = nativeMethod.apply(this, args);
      refreshCookieMirror();
      return result;
    };
  });
  nativeAdd.call(window, "popstate", refreshCookieMirror);

  function selectorFor(node) {
    if (!(node instanceof Element)) return String(node && node.nodeName || "unknown");
    const parts = [node.tagName.toLowerCase()];
    if (node.id) parts.push("#" + node.id.slice(0, 80));
    if (node.classList && node.classList.length) {
      parts.push("." + Array.from(node.classList).slice(0, 3).map(v => v.slice(0, 32)).join("."));
    }
    return parts.join("").slice(0, 180);
  }




  // Mount the authority UI before patching page APIs. Upstream applications
  // can expose non-standard or non-configurable browser surfaces; a failure in
  // optional interception must not prevent the authorization controls appearing.
  nativeAdd.call(window, "message", handleAuthorityMessage);

  try {
    initializeToolbar();
  } catch (error) {
    console.error("Intercept authority toolbar initialization failed", error);
  }

  async function flushEvents() {
    if (!eventBuffer.length || eventFlushInFlight) return;
    eventFlushInFlight = true;
    const batch = eventBuffer.splice(0, 100);
    try {
      const response = await rawFetch("/_intercept/events", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(batch),
        keepalive: true
      });
      if (!response.ok) throw new Error("event upload status " + response.status);
    } catch (_) {
      eventBuffer.unshift(...batch);
      if (eventBuffer.length > 120) eventBuffer.length = 120;
    } finally {
      eventFlushInFlight = false;
    }
  }

  function showNotice(message) {
    if (!authorityFrame || !authorityFrame.contentWindow) return;
    authorityFrame.contentWindow.postMessage({
      type: "intercept:notice",
      session_id: sessionId,
      message: String(message).slice(0, 500)
    }, "http://127.0.0.1:5000");
  }

  function routeToProxy(value) {
    let url;
    try {
      url = new URL(value instanceof URL ? value.href : String(value), document.baseURI);
    } catch (_) {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.href;
    const path = url.pathname + url.search + url.hash;
    if (url.origin === location.origin) {
      if (url.pathname === sessionPrefix || url.pathname.startsWith(sessionPrefix + "/")) return url.href;
      if (url.pathname === "/assets/controller.js" || url.pathname === "/assets/intercept.css") return url.href;
      return url.href;
    }
    if (url.origin === upstreamOrigin) return path;
    return sessionPrefix + "/_/" + url.protocol.slice(0, -1) + "/" + url.host + path;
  }

  // YouTube and other modern applications may enforce
  // require-trusted-types-for 'script'. Their dynamic script URL assignments
  // must receive a TrustedScriptURL, not the rewritten string.
  const TRUSTED_SCRIPT_URL_POLICY_NAME = "intercept-proxy";
  let trustedScriptUrlPolicy = null;
  if (window.trustedTypes && typeof window.trustedTypes.createPolicy === "function") {
    try {
      trustedScriptUrlPolicy = window.trustedTypes.createPolicy(TRUSTED_SCRIPT_URL_POLICY_NAME, {
        createScriptURL(value) {
          const url = new URL(String(value), location.href);
          const allowedBlob = url.protocol === "blob:" && url.origin === location.origin;
          const allowedHttp = (url.protocol === "http:" || url.protocol === "https:")
            && url.origin === location.origin;
          if (!allowedBlob && !allowedHttp) {
            throw new TypeError("Intercept only trusts script URLs routed through this session origin.");
          }
          if (url.pathname.startsWith("/_intercept/") || url.pathname.startsWith("/api/sessions/")) {
            throw new TypeError("Intercept control-plane URLs cannot be used as page scripts.");
          }
          return url.href;
        }
      });
    } catch (error) {
      record("trusted_types_policy_error", "document", String(error && error.message || error));
      console.warn("Intercept could not create its Trusted Types script URL policy", error);
    }
  }

  function trustedScriptUrl(value) {
    if (!window.trustedTypes) return value;
    if (!trustedScriptUrlPolicy) {
      throw new TypeError("Intercept's Trusted Types policy is unavailable; refusing an untrusted script URL.");
    }
    return trustedScriptUrlPolicy.createScriptURL(String(value));
  }

  function setInterceptAttribute(element, name, value) {
    const isScriptSource = Boolean(window.HTMLScriptElement
      && element instanceof window.HTMLScriptElement
      && String(name).toLowerCase() === "src");
    const sinkValue = isScriptSource ? trustedScriptUrl(value) : value;
    return nativeSetAttribute.call(element, name, sinkValue);
  }

  function routeSrcset(value) {
    return String(value).split(",").map(candidate => {
      const pieces = candidate.trim().split(/\s+/);
      if (!pieces[0]) return candidate;
      pieces[0] = routeToProxy(pieces[0]) || pieces[0];
      return pieces.join(" ");
    }).join(", ");
  }

  Element.prototype.setAttribute = function(name, value) {
    const key = String(name).toLowerCase();
    if (["href", "src", "action", "formaction", "poster", "data", "cite", "background"].includes(key)) {
      value = routeToProxy(value) || value;
    } else if (key === "srcset") {
      value = routeSrcset(value);
    }
    return setInterceptAttribute(this, name, value);
  };

  function sinkValueString(value) {
    return value instanceof URL ? value.href : String(value);
  }

  function patchUrlSetter(proto, property) {
    if (!proto) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (!descriptor || !descriptor.set || !descriptor.configurable) return;
    Object.defineProperty(proto, property, {
      ...descriptor,
      set(value) {
        const routed = routeToProxy(value) || value;
        const sinkValue = window.HTMLScriptElement
          && proto === window.HTMLScriptElement.prototype && property === "src"
          ? trustedScriptUrl(sinkValueString(routed))
          : routed;
        return descriptor.set.call(this, sinkValue);
      }
    });
  }

  [
    [window.HTMLAnchorElement && HTMLAnchorElement.prototype, "href"],
    [window.HTMLAreaElement && HTMLAreaElement.prototype, "href"],
    [window.HTMLLinkElement && HTMLLinkElement.prototype, "href"],
    [window.HTMLScriptElement && HTMLScriptElement.prototype, "src"],
    [window.HTMLImageElement && HTMLImageElement.prototype, "src"],
    [window.HTMLImageElement && HTMLImageElement.prototype, "srcset"],
    [window.HTMLSourceElement && HTMLSourceElement.prototype, "src"],
    [window.HTMLSourceElement && HTMLSourceElement.prototype, "srcset"],
    [window.HTMLIFrameElement && HTMLIFrameElement.prototype, "src"],
    [window.HTMLFormElement && HTMLFormElement.prototype, "action"],
    [window.HTMLInputElement && HTMLInputElement.prototype, "src"],
    [window.HTMLInputElement && HTMLInputElement.prototype, "formAction"],
    [window.HTMLButtonElement && HTMLButtonElement.prototype, "formAction"],
    [window.HTMLVideoElement && HTMLVideoElement.prototype, "src"],
    [window.HTMLVideoElement && HTMLVideoElement.prototype, "poster"],
    [window.HTMLAudioElement && HTMLAudioElement.prototype, "src"],
    [window.HTMLEmbedElement && HTMLEmbedElement.prototype, "src"],
    [window.HTMLObjectElement && HTMLObjectElement.prototype, "data"]
  ].forEach(([proto, property]) => patchUrlSetter(proto, property));

  function routeCssValue(value) {
    return String(value).replace(/url\(\s*["']?(.*?)["']?\s*\)/gi, (match, url) => {
      const routed = routeToProxy(url.trim());
      return routed ? 'url("' + routed + '")' : match;
    });
  }

  const cssPrototype = window.CSSStyleDeclaration && CSSStyleDeclaration.prototype;
  const nativeSetProperty = cssPrototype && cssPrototype.setProperty;
  if (nativeSetProperty) {
    cssPrototype.setProperty = function(property, value, priority) {
      return nativeSetProperty.call(this, property, routeCssValue(value), priority);
    };
  }
  if (cssPrototype) {
    Object.getOwnPropertyNames(cssPrototype).forEach(property => {
      const descriptor = Object.getOwnPropertyDescriptor(cssPrototype, property);
      if (!descriptor || !descriptor.set || !descriptor.configurable || property === "cssText") return;
      Object.defineProperty(cssPrototype, property, {
        ...descriptor,
        set(value) {
          return descriptor.set.call(this, typeof value === "string" ? routeCssValue(value) : value);
        }
      });
    });
  }

  function rewriteDomElement(element) {
    if (!(element instanceof Element)) return;
    for (const attribute of ["href", "src", "action", "formaction", "poster", "data", "cite", "background"]) {
      const current = element.getAttribute(attribute);
      if (!current) continue;
      const routed = routeToProxy(current);
      if (routed && routed !== current) {
        try {
          setInterceptAttribute(element, attribute, routed);
        } catch (error) {
          // A hostile or incomplete CSP must not abort the entire controller.
          // In particular, one rejected script URL cannot prevent toolbar and
          // request interception initialization for the rest of the document.
          record("dom_rewrite_error", selectorFor(element), attribute + ": " + String(error && error.message || error));
        }
      }
    }
    const srcset = element.getAttribute("srcset");
    if (srcset) {
      const routed = routeSrcset(srcset);
      if (routed !== srcset) {
        try { nativeSetAttribute.call(element, "srcset", routed); }
        catch (error) { record("dom_rewrite_error", selectorFor(element), "srcset: " + String(error && error.message || error)); }
      }
    }
    const style = element.getAttribute("style");
    if (style) {
      const routed = routeCssValue(style);
      if (routed !== style) {
        try { nativeSetAttribute.call(element, "style", routed); }
        catch (error) { record("dom_rewrite_error", selectorFor(element), "style: " + String(error && error.message || error)); }
      }
    }
  }

  function rewriteDomTree(root) {
    if (root instanceof Element) rewriteDomElement(root);
    if (root && root.querySelectorAll) {
      root.querySelectorAll("[href],[src],[action],[formaction],[poster],[data],[cite],[background],[srcset],[style]")
        .forEach(rewriteDomElement);
    }
  }

  if (window.MutationObserver && document.documentElement) {
    const resourceObserver = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "attributes") rewriteDomElement(record.target);
        else for (const node of record.addedNodes) rewriteDomTree(node);
      }
    });
    resourceObserver.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["href", "src", "action", "formaction", "poster", "data", "cite", "background", "srcset", "style"]
    });
  }
  rewriteDomTree(document.documentElement);

  // Observe registrations and trusted user-facing activity without recording form values.
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (["click", "submit", "change", "input", "keydown", "pointerdown"].includes(String(type)) &&
        (this === window || this === document || this instanceof Element)) {
      const now = Date.now();
      if (now - lastListenerReport > 100) {
        lastListenerReport = now;
        record("listener_registered", selectorFor(this), String(type));
      }
    }
    return nativeAdd.call(this, type, listener, options);
  };

  function rememberInputEvent(event) {
    const id = "i" + (++inputEventSequence).toString(36);
    const target = selectorFor(event.target);
    recentInputEvent = {id, target, at: performance.now()};
    return recentInputEvent;
  }

  function currentInputEvent() {
    if (!recentInputEvent ||
        performance.now() - recentInputEvent.at > INPUT_CORRELATION_WINDOW_MS) {
      return null;
    }
    return recentInputEvent;
  }

  function addInputCorrelation(headers) {
    const context = currentInputEvent();
    if (!context) return null;
    headers.set("X-Intercept-Input-Id", context.id);
    headers.set("X-Intercept-Input-Target", encodeURIComponent(context.target).slice(0, 360));
    return context;
  }

  function inputCorrelationDetail(context) {
    return context
      ? " · input_id=" + context.id + " target=" + encodeURIComponent(context.target).slice(0, 120)
      : "";
  }

  function requestBodyDiagnostic(body, provided) {
    if (!provided) return "body_arg=omitted";
    if (body === null) return "body_arg=null";
    if (body === undefined) return "body_arg=undefined";
    if (typeof body === "string") {
      return "body_arg=string body_arg_bytes=" + new TextEncoder().encode(body).byteLength;
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return "body_arg=urlsearchparams body_arg_bytes=" +
        new TextEncoder().encode(body.toString()).byteLength;
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return "body_arg=blob body_arg_bytes=" + body.size;
    }
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
      return "body_arg=arraybuffer body_arg_bytes=" + body.byteLength;
    }
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
      return "body_arg=arraybuffer_view body_arg_bytes=" + body.byteLength;
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      let entries = 0;
      for (const _entry of body.entries()) entries++;
      return "body_arg=formdata body_arg_entries=" + entries;
    }
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      return "body_arg=stream body_arg_bytes=unknown";
    }
    if (typeof Document !== "undefined" && body instanceof Document) {
      return "body_arg=document body_arg_bytes=unknown";
    }
    const type = Object.prototype.toString.call(body).slice(8, -1).slice(0, 40);
    return "body_arg=" + (type || typeof body) + " body_arg_bytes=unknown";
  }

  function fetchEventPath(source) {
    try {
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      // Keep event exports useful without recording URL query parameters.
      return candidate.pathname.slice(0, 180);
    } catch (_) {
      return "unknown";
    }
  }

  function fetchBodyDiagnostic(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, "body") &&
        init.body !== undefined) {
      return requestBodyDiagnostic(init.body, true);
    }
    if (input instanceof Request) {
      return input.body
        ? "body_arg=request_stream body_arg_bytes=unknown"
        : "body_arg=none";
    }
    return "body_arg=none";
  }

  function youtubeSearchEndpointCheck(source) {
    try {
      const upstream = new URL(upstreamOrigin);
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      const isYouTubeHost = host => {
        const normalized = host.toLowerCase();
        return normalized === "youtube.com" || normalized.endsWith(".youtube.com");
      };
      const upstreamHostMatch = isYouTubeHost(upstream.hostname);
      const candidatePathMatch = candidate.pathname === "/youtubei/v1/search";
      const candidatePathLooksLikeSearch = candidate.pathname.includes("/youtubei/v1/search");
      return {
        upstreamHostMatch,
        candidatePathMatch,
        candidatePathLooksLikeSearch,
        candidateIsProxyOrigin: candidate.origin === location.origin,
        candidateIsUpstreamOrigin: candidate.origin === upstream.origin,
        endpointMatch: upstreamHostMatch && candidatePathMatch
      };
    } catch (_) {
      return {
        upstreamHostMatch: false,
        candidatePathMatch: false,
        candidatePathLooksLikeSearch: false,
        candidateIsProxyOrigin: false,
        candidateIsUpstreamOrigin: false,
        endpointMatch: false
      };
    }
  }


  async function buildYouTubeSearchFallbackBody() {
    let context = null;
    let config = null;
    try {
      config = window.ytcfg;
      if (config && typeof config.get === "function") {
        context = config.get("INNERTUBE_CONTEXT");
      }
      if (!context && config && config.data_) {
        context = config.data_.INNERTUBE_CONTEXT;
      }
    } catch (_) {}

    if (!context || typeof context !== "object" || !context.client) {
      return {body: null, reason: "INNERTUBE_CONTEXT unavailable"};
    }

    const configValue = key => {
      try {
        if (config && typeof config.get === "function") {
          const value = config.get(key);
          if (value !== undefined && value !== null) return value;
        }
        if (config && config.data_
            && Object.prototype.hasOwnProperty.call(config.data_, key)) {
          return config.data_[key];
        }
      } catch (_) {}
      return undefined;
    };

    // Locate candidate runtime sources for fields present in captured
    // successful InnerTube requests. This deliberately records paths and
    // value types only; never expose request, visitor, tracking, or ad values.
    const runtimeFieldSources = (() => {
      const fields = {
        lockedSafetyMode: "lockedsafetymode",
        clickTrackingParams: "clicktrackingparams",
        adSignalsInfo: "adsignalsinfo",
        webSearchboxStatsUrl: "websearchboxstatsurl",
        inlineSettingStatus: "inlinesettingstatus"
      };
      const found = Object.fromEntries(Object.keys(fields).map(key => [key, []]));
      const roots = [];
      const addRoot = (name, value) => {
        if (value && typeof value === "object") roots.push([name, value]);
      };

      addRoot("ytcfg.data_", config && config.data_);
      try {
        if (config && typeof config.getAll === "function") {
          addRoot("ytcfg.getAll()", config.getAll());
        }
      } catch (_) {}
      addRoot("ytInitialData", window.ytInitialData);
      try {
        addRoot("ytplayer.config.args", window.ytplayer && window.ytplayer.config
          && window.ytplayer.config.args);
      } catch (_) {}
      try {
        const searchbox = document.querySelector("ytd-searchbox");
        addRoot("ytd-searchbox.data", searchbox && searchbox.data);
      } catch (_) {}
      try {
        const app = document.querySelector("ytd-app");
        addRoot("ytd-app.data", app && app.data);
      } catch (_) {}

      const describe = value => {
        if (value === null) return "null";
        if (Array.isArray(value)) return "array(" + value.length + ")";
        if (typeof value === "string") return "string(" + value.length + ")";
        return typeof value;
      };
      const normalize = value => String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();

      for (const [rootName, rootValue] of roots) {
        const seen = new WeakSet();
        let visited = 0;
        const walk = (value, path, depth) => {
          if (!value || typeof value !== "object" || depth > 8
              || visited >= 1600 || seen.has(value)) return;
          seen.add(value);
          visited++;
          let keys;
          try { keys = Object.keys(value).slice(0, 120); }
          catch (_) { return; }
          for (const key of keys) {
            let child;
            try { child = value[key]; } catch (_) { continue; }
            const normalized = normalize(key);
            for (const [field, alias] of Object.entries(fields)) {
              if (normalized === alias && found[field].length < 3) {
                found[field].push(
                  (rootName + "." + path + (path ? "." : "") + key)
                    .slice(0, 170) + ":" + describe(child)
                );
              }
            }
            if (child && typeof child === "object") {
              const childPath = path ? path + "." + key : key;
              walk(child, childPath, depth + 1);
            }
          }
        };
        walk(rootValue, "", 0);
      }

      return Object.fromEntries(Object.entries(found).map(([field, paths]) => [
        field,
        paths.length ? paths.join(" | ") : "not_found"
      ]));
    })();

    const runtimeValueType = value => {
      if (value === null) return "null";
      if (Array.isArray(value)) return "array(" + value.length + ")";
      if (typeof value === "string") return "string(" + value.length + ")";
      return typeof value;
    };
    const runtimeSourceFor = (field, configKey, value) => {
      if (value !== undefined && value !== null) {
        return "ytcfg:" + configKey + ":" + runtimeValueType(value);
      }
      return runtimeFieldSources[field];
    };

    let query = "";
    let querySource = "";
    if (recentYouTubeSuggestion
        && performance.now() - recentYouTubeSuggestion.at <= YOUTUBE_SUGGESTION_WINDOW_MS) {
      query = recentYouTubeSuggestion.query;
      querySource = "clicked_suggestion";
    }

    if (!query) {
      const selectors = [
        "input.yt-searchbox-input",
        "ytd-searchbox input#search",
        'input[name="search_query"]',
        "input#search"
      ];
      for (const selector of selectors) {
        const input = document.querySelector(selector);
        const value = input && typeof input.value === "string"
          ? input.value.trim()
          : "";
        if (value) {
          query = value;
          querySource = "search_input";
          break;
        }
      }
    }

    if (!query) {
      try {
        const pageUrl = new URL(window.location.href);
        query = pageUrl.searchParams.get("search_query")
          || pageUrl.searchParams.get("q")
          || "";
        if (query) querySource = "page_url";
      } catch (_) {}
    }

    if (!query.trim()) {
      return {body: null, reason: "search query unavailable"};
    }

    try {
      const client = context.client;

      // INNERTUBE_CONTEXT currently bundles client settings together with
      // request-envelope fields. A successful WEB search sends only client
      // under "context" and lifts request/user/clickTracking to the top level.
      // Keep those fields in their observed locations rather than duplicating
      // the whole config object inside context.
      const payload = {context: {client}};
      const contextRequest = context.request;
      if (contextRequest && typeof contextRequest === "object"
          && !Array.isArray(contextRequest)) {
        payload.request = {...contextRequest};
      } else {
        payload.request = {
          useSsl: true,
          internalExperimentFlags: [],
          consistencyTokenJars: []
        };
      }

      // INNERTUBE_CONTEXT already carries these values on current YouTube
      // pages. The successful WEB search envelope sends them again at the
      // top level, so prefer the live nested objects rather than looking only
      // for unrelated top-level ytcfg keys. Keep the config fallbacks in this
      // function scope because the runtime-source diagnostic below uses them.
      const lockedSafetyMode = configValue("LOCKED_SAFETY_MODE");
      const clickTrackingParams = configValue("CLICK_TRACKING_PARAMS");

      const contextUser = context.user;
      if (contextUser && typeof contextUser === "object" && !Array.isArray(contextUser)) {
        payload.user = {...contextUser};
      } else if (typeof lockedSafetyMode === "boolean") {
        payload.user = {lockedSafetyMode};
      }

      const contextClickTracking = context.clickTracking;
      if (contextClickTracking && typeof contextClickTracking === "object"
          && typeof contextClickTracking.clickTrackingParams === "string"
          && contextClickTracking.clickTrackingParams) {
        payload.clickTracking = {...contextClickTracking};
      } else if (typeof clickTrackingParams === "string" && clickTrackingParams) {
        payload.clickTracking = {clickTrackingParams};
      }

      const adSignalsInfo = configValue("AD_SIGNALS_INFO");
      if (adSignalsInfo && typeof adSignalsInfo === "object"
          && Array.isArray(adSignalsInfo.params)) {
        payload.adSignalsInfo = adSignalsInfo;
      }

      payload.query = query.trim();

      const webSearchboxStatsUrl = configValue("WEB_SEARCHBOX_STATS_URL");
      if (typeof webSearchboxStatsUrl === "string" && webSearchboxStatsUrl) {
        payload.webSearchboxStatsUrl = webSearchboxStatsUrl;
      }

      const inlineSettingStatus = configValue("INLINE_SETTING_STATUS");
      if (typeof inlineSettingStatus === "string" && inlineSettingStatus) {
        payload.inlineSettingStatus = inlineSettingStatus;
      }

      const runtimeSources = {
        lockedSafetyMode: runtimeSourceFor("lockedSafetyMode", "LOCKED_SAFETY_MODE", lockedSafetyMode),
        clickTrackingParams: runtimeSourceFor("clickTrackingParams", "CLICK_TRACKING_PARAMS", clickTrackingParams),
        adSignalsInfo: runtimeSourceFor("adSignalsInfo", "AD_SIGNALS_INFO", adSignalsInfo),
        webSearchboxStatsUrl: runtimeSourceFor("webSearchboxStatsUrl", "WEB_SEARCHBOX_STATS_URL", webSearchboxStatsUrl),
        inlineSettingStatus: runtimeSourceFor("inlineSettingStatus", "INLINE_SETTING_STATUS", inlineSettingStatus)
      };

      const headers = {"Content-Type": "application/json"};
      const loggedIn = configValue("LOGGED_IN");
      if (typeof loggedIn === "boolean") {
        headers["X-YouTube-Bootstrap-Logged-In"] = String(loggedIn);
      }
      if (client.clientName === "WEB") {
        headers["X-YouTube-Client-Name"] = "1";
      }
      if (typeof client.clientVersion === "string" && client.clientVersion.trim()) {
        headers["X-YouTube-Client-Version"] = client.clientVersion.trim();
      }
      if (typeof client.visitorData === "string" && client.visitorData.trim()) {
        headers["X-Goog-Visitor-Id"] = client.visitorData.trim();
      }

      // HttpOnly SAPISID cookies are intentionally unavailable to page
      // JavaScript. Pass only the live dataSyncId to the local proxy so it can
      // derive Authorization from its own cookie jar without exposing cookies.
      const dataSyncId = configValue("DATASYNC_ID");
      if (typeof dataSyncId === "string" && dataSyncId.length > 0
          && dataSyncId.length <= 512) {
        headers["X-Intercept-YouTube-DataSync-Id"] = dataSyncId;
      }

      // Restore the request's WEB API origin/client-account headers. The
      // primary session URL can be youtube.com while InnerTube uses www.
      let youtubeOrigin = "https://www.youtube.com";
      const configuredApiHost = configValue("INNERTUBE_HOST");
      if (typeof configuredApiHost === "string" && configuredApiHost.trim()) {
        try {
          const candidate = new URL(
            configuredApiHost.includes("://")
              ? configuredApiHost : "https://" + configuredApiHost
          );
          const host = candidate.hostname.toLowerCase();
          if (candidate.protocol === "https:"
              && (host === "youtube.com" || host.endsWith(".youtube.com"))
              && !candidate.username && !candidate.password
              && !candidate.search && !candidate.hash) {
            youtubeOrigin = candidate.origin;
          }
        } catch (_) {}
      }
      headers["X-Origin"] = youtubeOrigin;
      const sessionIndex = configValue("SESSION_INDEX");
      headers["X-Goog-AuthUser"] = (
        (typeof sessionIndex === "number" && Number.isInteger(sessionIndex)
          && sessionIndex >= 0)
        || (typeof sessionIndex === "string" && /^\d+$/.test(sessionIndex))
      ) ? String(sessionIndex) : "0";

      const authDiagnostic = "authorization=deferred_to_proxy"
        + " · data_sync_id=" + (
          typeof dataSyncId === "string" && dataSyncId.length > 0
            ? "present" : "absent"
        );

      const keys = Object.keys(payload);
      const clientName = typeof client.clientName === "string"
        ? client.clientName.slice(0, 24)
        : "unknown";
      const clientVersion = typeof client.clientVersion === "string"
        ? client.clientVersion.slice(0, 48)
        : "unknown";

      return {
        body: JSON.stringify(payload),
        querySource,
        headers,
        authDiagnostic,
        payloadKeys: keys.join(","),
        clientName,
        clientVersion,
        runtimeFieldSources: runtimeSources
      };
    } catch (error) {
      // Report the failure class without exposing exception text, which may
      // include page data supplied by upstream objects or getters.
      const errorName = String(error && error.name || "unknown").slice(0, 40);
      return {body: null, reason: "fallback_error=" + errorName};
    }
  }

  for (const type of ["pointerdown", "click", "change", "input", "keydown"]) {
    nativeAdd.call(document, type, event => {
      if (type === "pointerdown" && event.target instanceof Element) {
        const suggestion = event.target.closest(".ytSuggestionComponentText");
        const query = suggestion && suggestion.textContent
          ? suggestion.textContent.replace(/\s+/g, " ").trim()
          : "";
        if (query) {
          recentYouTubeSuggestion = {query, at: performance.now()};
        }
      }
      let detail = "";
      if (type === "input" || type === "change" ||
          (type === "keydown" && event.key === "Enter")) {
        const context = rememberInputEvent(event);
        detail = "input_id=" + context.id;
      } else if (type === "keydown") {
        // Do not record literal characters or user-entered text.
        const key = String(event.key || "");
        detail = "key=" + (key.length === 1 ? "character" : key.slice(0, 24));
      }
      record("dom_" + type, selectorFor(event.target), detail);
    }, true);
  }

  function queueAction(action, description) {
    if (queue.length >= 50) {
      showNotice("Cookie synchronization queue is full (50). Try again when it drains.");
      record("queue_full", description, "Action not queued");
      return;
    }
    queue.push(action);
    showNotice(queue.length + " browser action(s) waiting for cookie synchronization.");
    record("action_queued", description, "Deferred until pending cookie writes finish");
  }

  // The Rust request gate owns authorization policy. This browser-side queue
  // exists only to ensure a navigation cannot overtake an upstream cookie write.
  function flushCookieDeferredActions() {
    if (cookieWritesPending !== 0 || !queue.length) return;
    const actions = queue.splice(0);
    showNotice("Cookie synchronization complete. Resuming " + actions.length + " browser action(s).");
    record("actions_released", "cookie synchronization queue", String(actions.length) + " action(s)");
    for (const action of actions) {
      try { action(); } catch (error) { console.error("Intercept could not replay action", error); }
    }
  }

  nativeAdd.call(document, "click", event => {
    if (replaying || cookieWritesPending === 0) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href],area[href]") : null;
    if (!anchor) return;
    const href = anchor.href;
    let parsed;
    try { parsed = new URL(href, document.baseURI); } catch (_) { return; }
    // Leave mailto:, tel:, javascript:, and other browser-native schemes alone.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    const routedHref = routeToProxy(href);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!routedHref) {
      showNotice("Could not route this navigation through the active Intercept session.");
      record("navigation_blocked", selectorFor(anchor), href);
      return;
    }
    queueAction(() => location.assign(routedHref), routedHref);
  }, true);

  nativeAdd.call(document, "submit", event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || replaying || cookieWritesPending === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const routedAction = routeToProxy(form.action);
    if (!routedAction) {
      showNotice("Could not route this form through the active Intercept session.");
      record("form_blocked", selectorFor(form), form.action);
      return;
    }
    const submitter = event.submitter;
    const replaySubmit = () => {
      replaying = true;
      try {
        form.action = routedAction;
        if (submitter && submitter.form === form) form.requestSubmit(submitter);
        else form.requestSubmit();
      } catch (error) {
        console.error("Intercept form replay failed", error);
      } finally {
        window.setTimeout(() => { replaying = false; }, 0);
      }
    };
    queueAction(replaySubmit, form.method.toUpperCase() + " " + form.action);
  }, true);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const source = input instanceof Request ? input.url : input;
    const method = String((init && init.method) || (input instanceof Request && input.method) || "GET").toUpperCase();
    const routed = routeToProxy(source);
    record("fetch", String(source), method);
    if (!routed) return Promise.reject(new TypeError("Intercept only proxies HTTP and HTTPS requests."));
    try {
      // Mark the request explicitly instead of relying on browser-specific
      // Fetch Metadata support. Preserve Request/init overrides and bodies.
      let routedRequest;
      if (input instanceof Request) {
        routedRequest = new Request(routed, input);
        if (init) routedRequest = new Request(routedRequest, init);
      } else {
        routedRequest = new Request(routed, init);
      }
      let bodyDetail = fetchBodyDiagnostic(input, init);
      let youtubeSearchFallbackHeaders = null;
      const youtubeSearchCheck = youtubeSearchEndpointCheck(source);
      const bodyIsNull = routedRequest.body === null;
      if (routedRequest.method === "POST"
          && youtubeSearchCheck.upstreamHostMatch
          && youtubeSearchCheck.candidatePathLooksLikeSearch
          && (bodyIsNull || bodyDetail === "body_arg=none")) {
        record(
          "youtube_search_fallback_gate",
          "youtube search",
          "method_post=true"
            + " · body_null=" + bodyIsNull
            + " · body_diag_none=" + (bodyDetail === "body_arg=none")
            + " · endpoint_match=" + youtubeSearchCheck.endpointMatch
            + " · candidate_path_match=" + youtubeSearchCheck.candidatePathMatch
            + " · candidate_path_looks_like_search=" + youtubeSearchCheck.candidatePathLooksLikeSearch
            + " · candidate_proxy_origin=" + youtubeSearchCheck.candidateIsProxyOrigin
            + " · candidate_upstream_origin=" + youtubeSearchCheck.candidateIsUpstreamOrigin
        );
      }
      // Use the original Fetch arguments as the authority for whether the
      // caller supplied a body. Some browser Request implementations expose
      // a non-null empty stream after Request reconstruction even when the
      // original fetch() call omitted its body.
      if (routedRequest.method === "POST"
          && bodyDetail === "body_arg=none"
          && youtubeSearchCheck.endpointMatch) {
        const fallback = await buildYouTubeSearchFallbackBody();
        if (fallback.body) {
          const replacementRequest = new Request(routedRequest, {body: fallback.body});
          const replacementHeaders = new Headers(replacementRequest.headers);
          const inheritedContentEncoding = replacementHeaders.has("content-encoding");
          // The fallback body above is plain JSON, not the original GZIP byte
          // stream. Never retain an upstream Content-Encoding declaration from
          // the bodyless request when replacing its body.
          replacementHeaders.delete("content-encoding");
          replacementHeaders.delete("content-length");
          replacementHeaders.set("content-type", "application/json");
          routedRequest = new Request(replacementRequest, {headers: replacementHeaders});
          youtubeSearchFallbackHeaders = fallback.headers || {};
          record("youtube_search_auth_synthesis", fetchEventPath(source), fallback.authDiagnostic || "authorization=not_reported");
          bodyDetail = "body_arg=generated_innertube_search body_arg_bytes="
            + new TextEncoder().encode(fallback.body).byteLength;
          record(
            "youtube_search_body_generated",
            routed,
            "Generated InnerTube JSON · query_source=" + fallback.querySource
              + " · payload_keys=" + (fallback.payloadKeys || "unknown")
              + " · body_bytes=" + new TextEncoder().encode(fallback.body).byteLength
          );
          record(
            "youtube_search_payload_shape",
            routed,
            "keys=" + (fallback.payloadKeys || "unknown")
              + " · client=" + (fallback.clientName || "unknown")
              + " · version=" + (fallback.clientVersion || "unknown")
              + " · query_present=true"
          );
          for (const [field, source] of Object.entries(fallback.runtimeFieldSources || {})) {
            record("youtube_search_runtime_source", field, source);
          }
          record(
            "youtube_search_fallback_encoding",
            routed,
            "body_encoding=identity · content_type=application/json"
              + " · inherited_content_encoding=" + (inheritedContentEncoding ? "removed" : "absent")
          );
        } else {
          record("youtube_search_body_unavailable", routed, fallback.reason);
        }
      }
      const headers = new Headers(routedRequest.headers);
      const youtubeHeadersAdded = [];
      if (youtubeSearchFallbackHeaders) {
        for (const [name, value] of Object.entries(youtubeSearchFallbackHeaders)) {
          if (!headers.has(name)) {
            headers.set(name, value);
            youtubeHeadersAdded.push(name.toLowerCase());
          }
        }
        if (youtubeHeadersAdded.length) {
          record(
            "youtube_search_headers_synthesized",
            fetchEventPath(source),
            "Added missing InnerTube headers: " + youtubeHeadersAdded.join(", ")
          );
        }
      }
      headers.set("X-Intercept-Proxy-Mode", "ajax");
      headers.set("X-Intercept-Body-Diagnostic", bodyDetail);
      headers.set("X-Intercept-Transport-Diagnostic", "window-fetch");
      const inputContext = addInputCorrelation(headers);
      const markedRequest = new Request(routedRequest, {headers});
      record(
        "ajax_dispatch",
        routed,
        method + " · " + bodyDetail + inputCorrelationDetail(inputContext)
      );
      const fetchEventTarget = fetchEventPath(source);
      return cookieWriteQueue.then(() => {
        // ajax_dispatch is recorded before cookie synchronization finishes.
        // This marker proves the request has reached the actual native Fetch call.
        if (fetchEventTarget === "/youtubei/v1/search") {
          record(
            "fetch_started",
            fetchEventTarget,
            method + " · " + bodyDetail
          );
        }
        return nativeFetch(markedRequest);
      }).then(response => {
        record(
          "fetch_response",
          fetchEventTarget,
          "status=" + response.status + " · ok=" + response.ok
        );
        if (response.headers.get("X-Intercept-Cookie-Updated") === "1") {
          return refreshCookieMirror().then(() => response);
        }
        return response;
      }, error => {
        // Do not log the error message: browser errors may contain full URLs
        // or other request-specific values. The error class is sufficient to
        // distinguish a rejected Fetch from an HTTP response.
        const errorName = String(error && error.name || "unknown").slice(0, 40);
        record("fetch_error", fetchEventTarget, "error_name=" + errorName);
        throw error;
      });
    } catch (error) {
      record("ajax_route_error", String(source), String(error && error.message || error));
      return Promise.reject(error);
    }
  };

  const xhrMeta = new WeakMap();
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const routed = routeToProxy(url);
    if (!routed) throw new DOMException("Intercept only proxies HTTP and HTTPS requests.", "SecurityError");
    xhrMeta.set(this, {method: String(method).toUpperCase(), url: routed, async: rest[0] !== false});
    return nativeXhrOpen.call(this, method, routed, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const meta = xhrMeta.get(this);
    if (meta) {
      nativeAdd.call(this, "loadend", () => {
        try {
          if (this.getResponseHeader("X-Intercept-Cookie-Updated") === "1") refreshCookieMirror();
        } catch (_) {}
      });
      const inputContext = currentInputEvent();
      const bodyDetail = requestBodyDiagnostic(args[0], args.length > 0);
      try {
        // Add internal metadata last, after page code has configured headers.
        nativeXhrSetRequestHeader.call(this, "X-Intercept-Proxy-Mode", "ajax");
        nativeXhrSetRequestHeader.call(this, "X-Intercept-Body-Diagnostic", bodyDetail);
        nativeXhrSetRequestHeader.call(this, "X-Intercept-Transport-Diagnostic", "window-xhr");
        if (inputContext) {
          nativeXhrSetRequestHeader.call(this, "X-Intercept-Input-Id", inputContext.id);
          nativeXhrSetRequestHeader.call(
            this,
            "X-Intercept-Input-Target",
            encodeURIComponent(inputContext.target).slice(0, 360)
          );
        }
      } catch (error) {
        record("xhr_marker_error", meta.url, String(error && error.message || error));
      }
      record("xhr", meta.url, meta.method + inputCorrelationDetail(inputContext));
      record(
        "ajax_dispatch",
        meta.url,
        meta.method + " · " + bodyDetail + inputCorrelationDetail(inputContext)
      );
    }
    if (meta && meta.async && cookieWriteQueue) {
      cookieWriteQueue.then(() => nativeXhrSend.apply(this, args));
      return;
    }
    return nativeXhrSend.apply(this, args);
  };

  if (navigator.sendBeacon) {
    const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      const routed = routeToProxy(url);
      if (!routed) {
        record("beacon_blocked", String(url), "URL could not be routed");
        return false;
      }
      record(
        "ajax_dispatch",
        routed,
        "POST · " + requestBodyDiagnostic(data, arguments.length > 1) + " · transport=sendBeacon"
      );
      return nativeSendBeacon(routed, data);
    };
  }

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    window.EventSource = function(url, options) {
      const routed = routeToProxy(url);
      if (!routed) throw new DOMException("Intercept only proxies HTTP and HTTPS requests.", "SecurityError");
      record("ajax_dispatch", routed, "GET · body_arg=none · transport=EventSource");
      return new NativeEventSource(routed, options);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }

  if (window.Worker) {
    const NativeWorker = window.Worker;
    window.Worker = function(url, options) {
      const routed = routeToProxy(url);
      if (!routed) throw new DOMException("Intercept only proxies HTTP and HTTPS worker scripts.", "SecurityError");
      return new NativeWorker(routed, options);
    };
    window.Worker.prototype = NativeWorker.prototype;
  }

  if (window.SharedWorker) {
    const NativeSharedWorker = window.SharedWorker;
    window.SharedWorker = function(url, options) {
      const routed = routeToProxy(url);
      if (!routed) throw new DOMException("Intercept only proxies HTTP and HTTPS shared-worker scripts.", "SecurityError");
      return new NativeSharedWorker(routed, options);
    };
    window.SharedWorker.prototype = NativeSharedWorker.prototype;
  }

  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    const nativeRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function(scriptURL, options) {
      const routed = routeToProxy(scriptURL);
      if (!routed) return Promise.reject(new TypeError("Intercept only registers HTTP and HTTPS service workers."));
      record("service_worker_register", routed, "Service worker script routed through this session");
      return nativeRegister(routed, options);
    };
  }

  const nativeOpenWindow = window.open;
  window.open = function(url, ...rest) {
    const routed = routeToProxy(url);
    return nativeOpenWindow.call(this, routed || url, ...rest);
  };

  let inputEventSequence = 0;
  let recentInputEvent = null;
  let recentYouTubeSuggestion = null;
  const INPUT_CORRELATION_WINDOW_MS = 2000;
  const YOUTUBE_SUGGESTION_WINDOW_MS = 3000;

  function authorityUrl(retry) {
    return "http://127.0.0.1:5000/authority/" + encodeURIComponent(sessionId)
      + (retry ? "?_intercept_retry=" + retry : "");
  }

  function scheduleAuthorityRetry() {
    if (authorityRetryTimer) window.clearTimeout(authorityRetryTimer);
    authorityRetryTimer = window.setTimeout(() => {
      if (authorityReady || !authorityFrame) return;
      if (authorityRetryCount >= 2) {
        if (toolbarFallback) {
          toolbarFallback.textContent = "INTERCEPT AUTHORITY · FRAME NOT RESPONDING · check 127.0.0.1:5000";
          toolbarFallback.style.display = "block";
        }
        record("authority_frame_unresponsive", "authority-frame", "No ready handshake received after retries");
        return;
      }
      authorityRetryCount += 1;
      record("authority_frame_retry", "authority-frame", "Attempt " + authorityRetryCount);
      // This is our trusted dashboard iframe, not an upstream resource.
      // Bypass the page's patched iframe.src setter so 127.0.0.1 is not sent
      // through routeToProxy() and rejected by the public-destination guard.
      nativeSetAttribute.call(authorityFrame, "src", authorityUrl(authorityRetryCount));
      scheduleAuthorityRetry();
    }, 9000);
  }

  function installToolbarObserver() {
    if (!window.MutationObserver || toolbarObserver) return;
    toolbarObserver = new MutationObserver(() => {
      if (document.documentElement !== observedDocumentElement) {
        if (observedDocumentElement) {
          try { toolbarObserver.disconnect(); } catch (_) {}
          observedDocumentElement = null;
          toolbarObserver.observe(document, {childList: true});
        }
        if (document.documentElement) {
          observedDocumentElement = document.documentElement;
          toolbarObserver.observe(observedDocumentElement, {childList: true});
        }
      }
      if (toolbarHost && !toolbarHost.isConnected) {
        record("authority_host_removed", "document", "Reattaching the authorization frame host");
        mountToolbar();
      }
    });
    toolbarObserver.observe(document, {childList: true});
    if (document.documentElement) {
      observedDocumentElement = document.documentElement;
      toolbarObserver.observe(observedDocumentElement, {childList: true});
    }
  }

  function mountToolbar() {
    const html = document.documentElement;
    if (!html) return false;

    if (!toolbarHost) {
      toolbarHost = document.createElement("div");
      toolbarHost.id = "intercept-ui-host";
      toolbarHost.className = "intercept-ui-host";
      toolbarHost.setAttribute("aria-label", "Intercept authorization controls");
      // Critical positioning is applied directly as a fallback if the page's
      // Content-Security-Policy or stylesheet loading prevents the CSS asset.
      toolbarHost.style.setProperty("position", "fixed", "important");
      toolbarHost.style.setProperty("inset", "auto 0 0", "important");
      toolbarHost.style.setProperty("display", "block", "important");
      toolbarHost.style.setProperty("height", "148px", "important");
      toolbarHost.style.setProperty("z-index", "2147483647", "important");
      toolbarHost.style.setProperty("pointer-events", "none", "important");
      toolbarHost.style.setProperty("visibility", "visible", "important");
      toolbarHost.style.setProperty("opacity", "1", "important");

      toolbarRoot = toolbarHost.attachShadow({mode: "closed"});
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = "/assets/intercept.css";
      toolbarRoot.appendChild(stylesheet);

      toolbarFallback = document.createElement("div");
      toolbarFallback.textContent = "INTERCEPT AUTHORITY · CONNECTING";
      toolbarFallback.style.cssText = "display:block;position:absolute;inset:auto 0 0;padding:8px 12px;background:#080e16;color:#8ed9ff;font:12px/1.4 ui-monospace,monospace;text-align:center;pointer-events:none";
      toolbarRoot.appendChild(toolbarFallback);

      const frame = document.createElement("iframe");
      frame.className = "intercept-authority-frame";
      frame.title = "Intercept authority controls";
      // The trusted local authority frame needs user-initiated downloads for event export.
      // Do not grant allow-downloads-without-user-activation.
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads");
      frame.referrerPolicy = "no-referrer";
      frame.style.setProperty("display", "block", "important");
      frame.style.setProperty("width", "100%", "important");
      frame.style.setProperty("height", "148px", "important");
      frame.style.setProperty("border", "0", "important");
      frame.style.setProperty("pointer-events", "auto", "important");
      frame.style.setProperty("background", "#080e16", "important");
      frame.addEventListener("load", () => {
        record("authority_frame_load", "authority-frame", "Iframe load event; waiting for authority-ready handshake");
      });
      frame.addEventListener("error", () => {
        record("authority_frame_error", "authority-frame", "Iframe failed to load");
      });
      authorityFrame = frame;
      toolbarRoot.appendChild(frame);
      // The controller patches HTMLIFrameElement.src for upstream page
      // content. The trusted authority frame must stay on the dashboard host.
      nativeSetAttribute.call(frame, "src", authorityUrl(0));
      scheduleAuthorityRetry();
    }

    if (toolbarHost.parentNode !== html) html.appendChild(toolbarHost);
    html.classList.add("intercept-session-page");
    if (document.body) document.body.classList.add("intercept-session-page");
    installToolbarObserver();

    if (!telemetryStarted) {
      telemetryStarted = true;
      record("controller_loaded", "document", "Resilient authority frame mount initialized");
      window.setInterval(flushEvents, 1200);
    }
    return true;
  }

  function handleAuthorityMessage(event) {
    const data = event.data;
    if (event.origin !== "http://127.0.0.1:5000"
        || !authorityFrame
        || event.source !== authorityFrame.contentWindow
        || !data
        || data.session_id !== sessionId) {
      return;
    }

    if (data.type === "intercept:authority-ready") {
      // Acknowledge the handshake so the child frame can stop retrying.
      // event.origin has already been checked against the trusted dashboard
      // origin and event.source against this exact iframe's WindowProxy.
      authorityFrame.contentWindow.postMessage({
        type: "intercept:authority-ack",
        session_id: sessionId
      }, event.origin);
      authorityReady = true;
      if (authorityRetryTimer) window.clearTimeout(authorityRetryTimer);
      if (toolbarFallback) toolbarFallback.style.display = "none";
      record("authority_frame_ready", "authority-frame", "Authority UI and control link initialized");
      return;
    }

    if (data.type === "intercept:authority-resize") {
      const expanded = data.expanded === true;
      const height = expanded ? "50vh" : "148px";
      toolbarHost.style.setProperty("height", height, "important");
      authorityFrame.style.setProperty("height", height, "important");
      const reservedSpace = expanded ? "50vh" : "148px";
      document.documentElement.style.setProperty("scroll-padding-bottom", reservedSpace, "important");
      if (document.body) document.body.style.setProperty("padding-bottom", reservedSpace, "important");
      return;
    }

    if (data.type !== "intercept:authority-status"
        || !["waiting", "running", "released"].includes(data.state)) {
      return;
    }
    gateState = data.state;
    if (gateState === "released") flushCookieDeferredActions();
    record("authority_status_received", "authority-frame", gateState);
  }


  function initializeToolbar() {
    // documentElement exists while the parser is in <head>, so mount now
    // instead of waiting for DOMContentLoaded and losing the UI to page hooks.
    if (!mountToolbar()) {
      const retry = () => {
        if (mountToolbar()) {
          nativeRemove.call(document, "readystatechange", retry);
        }
      };
      nativeAdd.call(document, "readystatechange", retry);
      window.setTimeout(retry, 0);
    }
    nativeAdd.call(window, "pageshow", mountToolbar);
    nativeAdd.call(window, "load", mountToolbar, {once: true});
  }
})();