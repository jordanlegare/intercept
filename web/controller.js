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
  const MAX_EVENT_BUFFER = 2_000;
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

  function isPriorityYouTubeDiagnosticEvent(event) {
    return event && (
      event.kind === "youtube_attestation_rpc"
      || event.kind === "youtube_attestation_resource"
      || event.kind === "youtube_player_state"
      || event.kind === "youtube_player_watchdog"
      || event.kind === "youtube_player_worker"
      || event.kind === "youtube_player_runtime"
      || event.kind === "youtube_sabr_request_gap"
      || event.kind === "youtube_sabr_response_stream_complete"
      || event.kind === "youtube_sabr_attestation_context"
      || event.kind === "youtube_player_media_mutation"
      || event.kind === "youtube_sabr_recovery"
    );
  }

  function trimEventBuffer() {
    while (eventBuffer.length > MAX_EVENT_BUFFER) {
      const discardIndex = eventBuffer.findIndex(event => !isPriorityYouTubeDiagnosticEvent(event));
      eventBuffer.splice(discardIndex >= 0 ? discardIndex : 0, 1);
    }
  }

  function sanitizeEventTarget(target) {
    const value = String(target || "");
    const slashIndex = value.indexOf("/");
    const firstSegment = slashIndex > 0 ? value.slice(0, slashIndex) : "";
    const urlLike = value.startsWith("/")
      || value.includes("://")
      || (slashIndex > 0 && firstSegment.includes("."));
    return urlLike ? value.split(/[?#]/, 1)[0] : value;
  }

  function record(kind, target, detail) {
    if (INTERNAL_AUTHORITY_EVENTS.has(kind)) return;
    const eventKind = String(kind).slice(0, 80);
    const detailLimit = eventKind === "youtube_player_watchdog" || eventKind === "youtube_attestation_rpc"
      || eventKind === "youtube_sabr_recovery" ? 1100
      : eventKind === "youtube_player_state" || eventKind === "youtube_player_media_mutation" ? 900 : 300;
    eventBuffer.push({
      kind: eventKind,
      target: sanitizeEventTarget(target).slice(0, 240),
      detail: String(detail || "").slice(0, detailLimit)
    });
    trimEventBuffer();
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
        headers: {
          "content-type": "application/json",
          "X-Intercept-Playback-Context-Id": playbackContextId
        },
        body: JSON.stringify(batch),
        keepalive: true
      });
      if (!response.ok) throw new Error("event upload status " + response.status);
    } catch (_) {
      eventBuffer.unshift(...batch);
      trimEventBuffer();
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

  function isYouTubeQoeEndpoint(source) {
    try {
      const upstream = new URL(upstreamOrigin);
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      const upstreamHost = upstream.hostname.toLowerCase();
      const candidateHost = candidate.hostname.toLowerCase();
      const youtubeHost = host => host === "youtube.com" || host.endsWith(".youtube.com");
      const hostMatches = youtubeHost(upstreamHost)
        && (youtubeHost(candidateHost) || candidate.origin === location.origin);
      return hostMatches && candidate.pathname.endsWith("/api/stats/qoe");
    } catch (_) {
      return false;
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

  function youtubeSabrEndpointCheck(source) {
    try {
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      let hostname = candidate.hostname.toLowerCase();
      let pathname = candidate.pathname;

      // Page code can pass either the original Googlevideo URL or an already
      // routed Intercept URL. Resolve only the fixed route envelope; never
      // copy the query string into diagnostics.
      if (candidate.origin === location.origin) {
        const routeMarker = sessionPrefix + "/_/https/";
        const routeIndex = pathname.indexOf(routeMarker);
        if (routeIndex >= 0) {
          const target = pathname.slice(routeIndex + routeMarker.length);
          const slash = target.indexOf("/");
          if (slash <= 0) return false;
          hostname = target.slice(0, slash).toLowerCase();
          pathname = target.slice(slash);
        }
      }

      const googleVideoHost = hostname === "googlevideo.com"
        || hostname.endsWith(".googlevideo.com");
      return googleVideoHost
        && pathname === "/videoplayback"
        && candidate.searchParams.has("sabr");
    } catch (_) {
      return false;
    }
  }

  let youtubeAttestationRpcSequence = 0;
  let youtubePlayerTimerSequence = 0;
  let activeYouTubePlayerTimer = null;
  const recentYouTubePlayerTimerFires = [];
  const recentlyFiredSlowYouTubeTimers = new Map();
  const observedYouTubeTimerRegistrations = new Set();
  let latestYouTubePlayerState = null;
  const playbackContextId = (() => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, character => {
      const random = Math.random() * 16 | 0;
      return (character === "x" ? random : (random & 3 | 8)).toString(16);
    });
  })();

  // YouTube base.js calls this narrow telemetry bridge at protection-token
  // recovery boundaries. Only whitelisted booleans/enums/counters are accepted;
  // token strings, video IDs, request bodies, and arbitrary error text cannot
  // enter the event stream through this interface.
  const SABR_RECOVERY_PHASES = new Set([
    "base_instrumentation_status",
    "spsumpreject",
    "content_token_recovery_requested",
    "session_token_recovery_requested",
    "session_token_recovery_waiting",
    "session_token_generation_started",
    "content_token_generation_started",
    "token_provider_ready",
    "token_generated",
    "token_generation_error",
    "token_result_empty",
    "token_release_check",
    "loader_release_requested",
    "loader_gate",
    "token_controller_init_enter",
    "token_controller_start_enter",
    "token_controller_dispose_enter"
  ]);
  const SABR_RECOVERY_BOOLEAN_FIELDS = new Set([
    "spsumpreject_hook", "recovery_request_hook", "session_wait_hook",
    "session_generate_hook", "content_generate_hook", "fallback_token_hook",
    "webpo_token_hook", "k_t_release_hook", "l_t_release_hook",
    "loader_gate_hook", "shared_provider_ready_hook", "provider_ready_hook",
    "controller_init_hook", "controller_start_hook", "controller_dispose_hook",
    "controller_owner_present", "controller_active",
    "rejected", "retry_remaining", "video_data_present", "token_controller_active",
    "token_generation_pending", "content_token_enabled", "session_token_enabled",
    "provider_ready", "provider_present", "fallback_present", "living_room_mode",
    "already_pending", "release_pending", "token_present", "eligible",
    "previous", "next"
  ]);
  const SABR_RECOVERY_ENUM_FIELDS = {
    token_source: new Set(["fallback", "webpo"]),
    path: new Set(["kT", "lT"]),
    provider_source: new Set(["shared", "webpo"])
  };

  function recordSabrRecovery(phase, values) {
    if (!SABR_RECOVERY_PHASES.has(phase)) return;
    const fields = ["observed_at_unix_ms=" + Date.now(), "phase=" + phase];
    if (values && typeof values === "object") {
      for (const [key, value] of Object.entries(values)) {
        if (SABR_RECOVERY_BOOLEAN_FIELDS.has(key) && typeof value === "boolean") {
          fields.push(key + "=" + value);
        } else if (key === "patch_count" && Number.isSafeInteger(value) && value >= 0 && value <= 32) {
          fields.push("patch_count=" + value);
        } else if (SABR_RECOVERY_ENUM_FIELDS[key] && SABR_RECOVERY_ENUM_FIELDS[key].has(value)) {
          fields.push(key + "=" + value);
        }
      }
    }
    record("youtube_sabr_recovery", "player base.js", fields.join(" "));
  }

  try {
    Object.defineProperty(window, "__interceptRecordSabrRecovery", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: recordSabrRecovery
    });
  } catch (_) {}

  function youtubeAttestationRpcInfo(source) {
    try {
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      let hostname = candidate.hostname.toLowerCase();
      let pathname = candidate.pathname;

      // WAA RPCs can arrive directly or through this session's origin-qualified
      // route. Recover only the host/path envelope; never inspect or retain the
      // query string, which may carry request-specific credentials.
      if (candidate.origin === location.origin) {
        const routeMarker = sessionPrefix + "/_/https/";
        const routeIndex = pathname.indexOf(routeMarker);
        if (routeIndex >= 0) {
          const target = pathname.slice(routeIndex + routeMarker.length);
          const slash = target.indexOf("/");
          if (slash <= 0) return null;
          hostname = target.slice(0, slash).toLowerCase();
          pathname = target.slice(slash);
        } else if (pathname === sessionPrefix || pathname.startsWith(sessionPrefix + "/")) {
          hostname = new URL(upstreamOrigin).hostname.toLowerCase();
          pathname = pathname.slice(sessionPrefix.length) || "/";
        }
      }

      const lowerPath = pathname.toLowerCase();
      const youtubeHost = hostname === "youtube.com" || hostname.endsWith(".youtube.com");
      const googleCandidate = hostname === "jnn-pa.googleapis.com"
        || (hostname.endsWith(".googleapis.com") && lowerPath.includes("waa"));
      const youtubeJnn = youtubeHost && lowerPath.startsWith("/api/jnn/v1/");
      const youtubeAttGet = youtubeHost && lowerPath === "/youtubei/v1/att/get";
      const youtubeAttLog = youtubeHost && lowerPath === "/youtubei/v1/att/log";
      const youtubeAttResource = youtubeAttGet || youtubeAttLog;
      if (!googleCandidate && !youtubeJnn && !youtubeAttResource) return null;
      const match = pathname.match(
        /^\/\$rpc\/google\.internal\.waa\.v1\.Waa\/(Create|GenerateIT)$/
      ) || pathname.match(/^\/api\/jnn\/v1\/(Create|GenerateIT)$/);
      return {
        kind: youtubeAttResource ? "youtube_attestation_resource" : "youtube_attestation_rpc",
        operation: youtubeAttGet ? "AttGet" : youtubeAttLog ? "AttLog" : match ? match[1] : "Other",
        target: hostname + pathname
      };
    } catch (_) {
      return null;
    }
  }

  function beginYouTubeAttestationRpc(info, method, transport) {
    youtubeAttestationRpcSequence = (youtubeAttestationRpcSequence % 999999) + 1;
    const capturePlayerCallsite = info.operation === "GenerateIT";
    const playerState = capturePlayerCallsite ? latestYouTubePlayerState : null;
    return {
      id: Date.now().toString(36) + "-" + youtubeAttestationRpcSequence
        + "-" + Math.random().toString(36).slice(2, 8),
      info,
      method,
      transport,
      callsite: capturePlayerCallsite ? sanitizedYouTubeFetchCallsite(4) : null,
      timerContext: capturePlayerCallsite ? youtubePlayerTimerContext() : null,
      playerState: playerState ? {
        ageMs: Math.max(0, Math.round(performance.now() - playerState.at)),
        detail: playerState.detail
      } : null,
      startedAt: null,
      headersReported: false,
      terminal: false
    };
  }

  function youtubeAttestationHeader(headers, name) {
    try {
      if (headers && typeof headers.get === "function") return headers.get(name);
      if (headers && typeof headers.getResponseHeader === "function") {
        return headers.getResponseHeader(name);
      }
    } catch (_) {}
    return null;
  }

  function youtubeAttestationContentType(headers) {
    const value = youtubeAttestationHeader(headers, "content-type");
    if (!value) return "absent";
    const mime = String(value).split(";", 1)[0].trim().toLowerCase();
    return /^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/.test(mime) ? mime : "other";
  }

  function youtubeAttestationContentLength(headers) {
    const value = youtubeAttestationHeader(headers, "content-length");
    const normalized = value === null || value === undefined ? "" : String(value).trim();
    return /^\d{1,15}$/.test(normalized) ? normalized : "absent";
  }

  function youtubeAttestationContentEncoding(headers) {
    const value = youtubeAttestationHeader(headers, "content-encoding");
    if (!value) return "absent";
    const encodings = String(value).split(",").map(token => token.trim().toLowerCase());
    if (!encodings.length || encodings.some(token => !/^[a-z0-9._-]{1,16}$/.test(token))) {
      return "other";
    }
    return encodings.join(",").slice(0, 32);
  }

  function recordYouTubeAttestationRpcDispatch(call) {
    if (!call) return;
    call.startedAt = performance.now();
    record(
      call.info.kind || "youtube_attestation_rpc",
      call.info.target,
      "rpc=" + call.id
        + " operation=" + call.info.operation
        + " phase=dispatch method=" + call.method
        + " transport=" + call.transport
        + (call.callsite ? " callsite=" + call.callsite : "")
        + (call.playerState
          ? " player_state_age_ms=" + call.playerState.ageMs + " player_state=" + call.playerState.detail
          : (call.info.operation === "GenerateIT" ? " player_state=unobserved" : ""))
        + (call.timerContext ? " timer_context=" + call.timerContext : " timer_context=unobserved")
    );
  }

  function recordYouTubeAttestationRpcHeaders(call, status, headers) {
    if (!call || call.headersReported || call.terminal) return;
    call.headersReported = true;
    const elapsed = call.startedAt === null
      ? "not_dispatched"
      : String(Math.max(0, Math.round(performance.now() - call.startedAt)));
    record(
      call.info.kind || "youtube_attestation_rpc",
      call.info.target,
      "rpc=" + call.id
        + " operation=" + call.info.operation
        + " phase=response_headers status=" + (Number(status) || 0)
        + " elapsed_ms=" + elapsed
        + " ct=" + youtubeAttestationContentType(headers)
    );
  }

  function recordYouTubeAttestationRpcResponse(call, status, headers) {
    if (!call || call.terminal) return;
    call.terminal = true;
    const elapsed = call.startedAt === null
      ? "not_dispatched"
      : String(Math.max(0, Math.round(performance.now() - call.startedAt)));
    const statusCode = Number(status) || 0;
    const outcome = statusCode > 0 ? "http" : "no_http_response";
    record(
      call.info.kind || "youtube_attestation_rpc",
      call.info.target,
      "rpc=" + call.id
        + " operation=" + call.info.operation
        + " phase=response status=" + statusCode
        + " outcome=" + outcome
        + " elapsed_ms=" + elapsed
        + " ct=" + youtubeAttestationContentType(headers)
        + " cl=" + youtubeAttestationContentLength(headers)
        + " ce=" + youtubeAttestationContentEncoding(headers)
    );
  }

  function recordYouTubeAttestationRpcFailure(call, error, phase) {
    if (!call || call.terminal) return;
    call.terminal = true;
    const elapsed = call.startedAt === null
      ? "not_dispatched"
      : String(Math.max(0, Math.round(performance.now() - call.startedAt)));
    const errorName = String(error && error.name || (phase === "loadend" ? "no_terminal_event" : "none"))
      .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
    record(
      call.info.kind || "youtube_attestation_rpc",
      call.info.target,
      "rpc=" + call.id
        + " operation=" + call.info.operation
        + " phase=" + (phase || "error")
        + " elapsed_ms=" + elapsed
        + " error=" + errorName
        + " transport=" + call.transport
    );
  }

  function youtubeAttestationAssetInfo(source) {
    try {
      const candidate = new URL(String(source || ""), document.baseURI);
      let hostname = candidate.hostname.toLowerCase();
      let pathname = candidate.pathname;
      if (candidate.origin === location.origin) {
        const routeMarker = sessionPrefix + "/_/https/";
        const routeIndex = pathname.indexOf(routeMarker);
        if (routeIndex >= 0) {
          const target = pathname.slice(routeIndex + routeMarker.length);
          const slash = target.indexOf("/");
          if (slash <= 0) return null;
          hostname = target.slice(0, slash).toLowerCase();
          pathname = target.slice(slash);
        } else if (pathname === sessionPrefix || pathname.startsWith(sessionPrefix + "/")) {
          hostname = new URL(upstreamOrigin).hostname.toLowerCase();
          pathname = pathname.slice(sessionPrefix.length) || "/";
        }
      }
      const googleHost = hostname === "google.com" || hostname.endsWith(".google.com")
        || hostname === "gstatic.com" || hostname.endsWith(".gstatic.com")
        || hostname === "googleapis.com" || hostname.endsWith(".googleapis.com");
      const youtubeHost = hostname === "youtube.com" || hostname.endsWith(".youtube.com");
      const lowerPath = pathname.toLowerCase();
      const namedAsset = lowerPath.includes("botguard")
        || lowerPath.includes("bot_guard")
        || lowerPath.includes("attestation")
        || lowerPath.includes("integrity")
        || lowerPath.includes("challenge")
        || lowerPath.includes("/js/bg/")
        || /(^|\/)bg(?:\.min)?\.js$/.test(lowerPath);
      // YouTube's player runtime can host the BotGuard adapter without
      // mentioning BotGuard in its URL. Track the player bundle lifecycle
      // separately instead of silently treating it as an unrelated script.
      const youtubePlayerRuntime = youtubeHost
        && (lowerPath === "/s/player" || lowerPath.startsWith("/s/player/"));
      const googleScript = googleHost
        && (lowerPath.endsWith(".js") || lowerPath.includes(".js/"));
      if (!namedAsset && !googleScript && !youtubePlayerRuntime) return null;
      if (!googleHost && !(youtubeHost && (namedAsset || youtubePlayerRuntime))) return null;
      return {
        target: hostname + pathname,
        candidate: namedAsset ? "named_attestation_hint"
          : youtubePlayerRuntime ? "youtube_player_runtime" : "google_hosted_script"
      };
    } catch (_) {
      return null;
    }
  }

  function recordYouTubeAttestationScriptEvent(event, phase) {
    const element = event && event.target;
    if (!element || String(element.tagName || "").toLowerCase() !== "script") return;
    const info = youtubeAttestationAssetInfo(element.src || element.getAttribute("src"));
    if (!info) return;
    const scriptType = String(element.type || "classic").toLowerCase() === "module"
      ? "module" : "classic";
    record(
      "youtube_attestation_resource",
      info.target,
      "phase=" + phase + " candidate=" + info.candidate
        + " script_type=" + scriptType
        + " async=" + Boolean(element.async)
        + " defer=" + Boolean(element.defer)
    );
  }

  function observeYouTubeAttestationResources() {
    nativeAdd.call(document, "load", event => {
      recordYouTubeAttestationScriptEvent(event, "script_load");
    }, true);
    nativeAdd.call(document, "error", event => {
      recordYouTubeAttestationScriptEvent(event, "script_error");
    }, true);
    nativeAdd.call(window, "error", event => {
      const info = youtubeAttestationAssetInfo(event && event.filename);
      if (!info) return;
      const errorName = String(event && event.error && event.error.name || "ScriptError")
        .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      record("youtube_attestation_resource", info.target,
        "phase=script_runtime_error error=" + (errorName || "ScriptError"));
    }, true);
    nativeAdd.call(window, "unhandledrejection", event => {
      const reason = event && event.reason;
      const errorName = String(reason && reason.name || "UnhandledRejection")
        .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "UnhandledRejection";
      record("youtube_player_runtime", "window",
        "phase=unhandled_rejection error=" + errorName);
    }, true);
    nativeAdd.call(document, "securitypolicyviolation", event => {
      const info = youtubeAttestationAssetInfo(event && event.blockedURI);
      if (!info) return;
      const directive = String(event.effectiveDirective || "unknown")
        .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
      record("youtube_attestation_resource", info.target,
        "phase=script_policy_blocked directive=" + (directive || "unknown"));
    }, true);

    if (typeof PerformanceObserver !== "function") return;
    const observed = new Set();
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const number = value => Number.isFinite(Number(value))
            ? String(Math.max(0, Math.round(Number(value))))
            : "unknown";
          const initiator = String(entry.initiatorType || "other")
            .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "other";
          const info = youtubeAttestationRpcInfo(entry.name);
          if (info) {
            const key = "rpc|" + info.target + "|" + Math.round(entry.startTime * 10)
              + "|" + initiator;
            if (observed.has(key)) continue;
            observed.add(key);
            if (observed.size > 512) observed.delete(observed.values().next().value);
            record(
              info.kind || "youtube_attestation_rpc",
              info.target,
              "phase=resource_timing_observed operation=" + info.operation
                + " initiator=" + initiator
                + " start_ms=" + number(entry.startTime)
                + " duration_ms=" + number(entry.duration)
                + " transfer_bytes=" + number(entry.transferSize)
                + " encoded_bytes=" + number(entry.encodedBodySize)
            );
            continue;
          }
          if (initiator !== "script") continue;
          const asset = youtubeAttestationAssetInfo(entry.name);
          if (!asset) continue;
          const key = "asset|" + asset.target + "|" + Math.round(entry.startTime * 10);
          if (observed.has(key)) continue;
          observed.add(key);
          if (observed.size > 512) observed.delete(observed.values().next().value);
          record(
            "youtube_attestation_resource",
            asset.target,
            "phase=script_resource_timing_observed initiator=script"
              + " start_ms=" + number(entry.startTime)
              + " duration_ms=" + number(entry.duration)
              + " transfer_bytes=" + number(entry.transferSize)
              + " encoded_bytes=" + number(entry.encodedBodySize)
          );
        }
      });
      observer.observe({type: "resource", buffered: true});
    } catch (_) {
      // Resource Timing is supplemental; failure must not affect interception.
    }
  }

  observeYouTubeAttestationResources();

  // Observe the actual HTMLMediaElement state on YouTube. This is deliberately
  // metadata-only: never read currentSrc/src, media bytes, captions, or page data.
  function observeYouTubePlayerState() {
    let upstreamHost = "";
    try { upstreamHost = new URL(upstreamOrigin).hostname.toLowerCase(); } catch (_) {}
    if (upstreamHost !== "youtube.com" && !upstreamHost.endsWith(".youtube.com")) return;

    const observedVideos = new WeakSet();
    const observedVideoElements = new Set();
    const lastSampleAt = new WeakMap();
    const watchStates = new WeakMap();
    const WATCHDOG_INTERVAL_MS = 1000;
    const WATCHDOG_STALL_MS = 4500;
    const WATCHDOG_HEARTBEAT_MS = 12000;
    const eventNames = [
      "loadstart", "loadedmetadata", "loadeddata", "canplay", "canplaythrough",
      "play", "playing", "waiting", "stalled", "pause", "ended", "error",
      "seeking", "seeked", "emptied", "durationchange", "timeupdate", "progress"
    ];
    const sampledEvents = new Set(["timeupdate", "progress"]);
    const sampleIntervalMs = 4000;

    // Record only source-state transitions and sanitized callsites. Never log
    // media URLs, source values, MediaSource contents, or media payloads.
    function installYouTubeMediaMutationDiagnostics() {
      if (!window.HTMLMediaElement || !window.HTMLSourceElement || !window.Node) return;

      const mediaIds = new WeakMap();
      const sourceIds = new WeakMap();
      let mediaSequence = 0;
      let sourceSequence = 0;

      function mediaId(video) {
        if (!mediaIds.has(video)) mediaIds.set(video, "video#" + (++mediaSequence));
        return mediaIds.get(video);
      }

      function sourceId(source) {
        if (!sourceIds.has(source)) sourceIds.set(source, "source#" + (++sourceSequence));
        return sourceIds.get(source);
      }

      function mediaSnapshot(video) {
        let sourceCount = 0;
        let sourceObject = false;
        let currentSource = false;
        try { sourceCount = video.querySelectorAll("source").length; } catch (_) {}
        try { sourceObject = video.srcObject !== null; } catch (_) {}
        try { currentSource = Boolean(video.currentSrc); } catch (_) {}
        let sourceAttribute = false;
        let connected = false;
        try { sourceAttribute = video.hasAttribute("src"); } catch (_) {}
        try { connected = Boolean(video.isConnected); } catch (_) {}
        return {
          src_attr: sourceAttribute,
          current_src: currentSource,
          src_object: sourceObject,
          source_count: sourceCount,
          connected
        };
      }

      function snapshotFields(prefix, state) {
        return prefix + "_src_attr=" + state.src_attr
          + " " + prefix + "_current_src=" + state.current_src
          + " " + prefix + "_src_object=" + state.src_object
          + " " + prefix + "_source_count=" + state.source_count
          + " " + prefix + "_connected=" + state.connected;
      }

      function report(operation, video, source, before, after, callsite, extra = "") {
        const fields = [
          "observed_at_unix_ms=" + Date.now(),
          "operation=" + operation,
          "media_element=" + (video ? mediaId(video) : "unattached"),
          source ? "source_element=" + sourceId(source) : "",
          before ? snapshotFields("before", before) : "",
          after ? snapshotFields("after", after) : "",
          extra,
          "callsite=" + (callsite || "unavailable")
        ].filter(Boolean).join(" ");
        record("youtube_player_media_mutation", video ? "video" : "source", fields);
      }

      function videoForSource(source) {
        try {
          const parent = source && source.parentElement;
          return parent instanceof HTMLVideoElement ? parent : null;
        } catch (_) {
          return null;
        }
      }

      function isSourceTree(node) {
        if (!(node instanceof Node)) return false;
        if (node instanceof HTMLSourceElement) return true;
        try {
          return typeof node.querySelector === "function" && Boolean(node.querySelector("source"));
        } catch (_) {
          return false;
        }
      }

      function wrapAccessor(proto, property, applies, operation, sourceTarget = false) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(proto, property);
          if (!descriptor || typeof descriptor.set !== "function" || !descriptor.configurable) return;
          Object.defineProperty(proto, property, {
            ...descriptor,
            set: function(value) {
              if (!applies(this)) return descriptor.set.call(this, value);
              const callsite = sanitizedYouTubeFetchCallsite(6);
              const source = sourceTarget ? this : null;
              const video = this instanceof HTMLVideoElement ? this : videoForSource(this);
              const before = video ? mediaSnapshot(video) : null;
              const result = descriptor.set.call(this, value);
              const after = video ? mediaSnapshot(video) : null;
              report(operation, video, source, before, after, callsite,
                "value_present=" + (value !== null && value !== undefined && value !== ""));
              return result;
            }
          });
        } catch (_) {
          // Optional diagnostics must never interfere with native media APIs.
        }
      }

      wrapAccessor(HTMLMediaElement.prototype, "src",
        element => element instanceof HTMLVideoElement, "src_property_set");
      wrapAccessor(HTMLMediaElement.prototype, "srcObject",
        element => element instanceof HTMLVideoElement, "src_object_set");

      if (window.HTMLSourceElement) {
        wrapAccessor(HTMLSourceElement.prototype, "src",
          element => element instanceof HTMLSourceElement, "source_src_property_set", true);
      }

      function wrapSrcAttributeMethod(proto, name) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(proto, name);
          if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;
          const original = descriptor.value;
          Object.defineProperty(proto, name, {
            ...descriptor,
            value: function(attributeName, ...args) {
              const attribute = typeof attributeName === "string" ? attributeName.toLowerCase() : "";
              const isVideo = this instanceof HTMLVideoElement;
              const isSource = this instanceof HTMLSourceElement;
              if (attribute !== "src" || (!isVideo && !isSource)) {
                return original.call(this, attributeName, ...args);
              }
              const callsite = sanitizedYouTubeFetchCallsite(6);
              const video = isVideo ? this : videoForSource(this);
              const source = isSource ? this : null;
              const before = video ? mediaSnapshot(video) : null;
              const result = original.call(this, attributeName, ...args);
              const after = video ? mediaSnapshot(video) : null;
              const valuePresent = name === "removeAttribute" ? false
                : name === "toggleAttribute" && args.length > 0 && args[0] === false ? false
                : true;
              report("src_attribute_" + name, video, source, before, after, callsite,
                "value_present=" + valuePresent);
              return result;
            }
          });
        } catch (_) {
          // Preserve the native method if it cannot be wrapped.
        }
      }

      for (const method of ["setAttribute", "removeAttribute", "toggleAttribute"]) {
        wrapSrcAttributeMethod(Element.prototype, method);
      }

      function wrapChildMutation(proto, name, replaceChildren = false) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(proto, name);
          if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;
          const original = descriptor.value;
          Object.defineProperty(proto, name, {
            ...descriptor,
            value: function(...args) {
              const isVideoParent = this instanceof HTMLVideoElement;
              const videoNode = args.find(node => node instanceof HTMLVideoElement) || null;
              const sourceNode = args.find(isSourceTree) || null;
              const sourceParent = sourceNode instanceof HTMLSourceElement ? videoForSource(sourceNode) : null;
              const video = isVideoParent ? this : (videoNode || sourceParent);
              const before = video ? mediaSnapshot(video) : null;
              const relevant = Boolean(video) && (
                Boolean(videoNode)
                || (isVideoParent && (Boolean(sourceNode) || (replaceChildren && before.source_count > 0)))
                || Boolean(sourceParent)
              );
              if (!relevant) return original.apply(this, args);
              const callsite = sanitizedYouTubeFetchCallsite(6);
              const result = original.apply(this, args);
              const after = mediaSnapshot(video);
              let operation = "video_node_" + name;
              if (isVideoParent || sourceParent) operation = "source_children_" + name;
              report(operation, video, sourceNode instanceof HTMLSourceElement ? sourceNode : null,
                before, after, callsite,
                "nodes_with_source=" + args.filter(isSourceTree).length);
              return result;
            }
          });
        } catch (_) {
          // A missing wrapper only reduces diagnostics; it does not affect playback.
        }
      }

      for (const method of ["appendChild", "insertBefore", "removeChild", "replaceChild"]) {
        wrapChildMutation(Node.prototype, method);
      }
      if (window.Element && Element.prototype) {
        wrapChildMutation(Element.prototype, "replaceChildren", true);
      }

      try {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "load");
        if (descriptor && typeof descriptor.value === "function" && descriptor.configurable) {
          const original = descriptor.value;
          Object.defineProperty(HTMLMediaElement.prototype, "load", {
            ...descriptor,
            value: function(...args) {
              if (!(this instanceof HTMLVideoElement)) return original.apply(this, args);
              const callsite = sanitizedYouTubeFetchCallsite(6);
              const before = mediaSnapshot(this);
              const result = original.apply(this, args);
              report("load_call", this, null, before, mediaSnapshot(this), callsite);
              return result;
            }
          });
        }
      } catch (_) {
        // Preserve native load() behavior on unsupported browser implementations.
      }
    }

    function metric(value, digits = 1) {
      const number = Number(value);
      return Number.isFinite(number) ? String(Number(number.toFixed(digits))) : "unknown";
    }

    function snapshot(video, eventName) {
      const currentTime = Number(video.currentTime);
      const duration = Number(video.duration);
      const errorCode = video.error && Number(video.error.code);
      const elementConnected = Boolean(video.isConnected);
      const sourceAttributePresent = video.hasAttribute("src");
      const currentSourcePresent = Boolean(video.currentSrc);
      const sourceObjectPresent = video.srcObject !== null;
      const childSourceCount = video.querySelectorAll("source").length;
      let bufferedCount = 0;
      let currentBufferedEnd = "none";
      let currentBufferedAhead = "none";
      let furthestBufferedEnd = "none";
      try {
        const ranges = video.buffered;
        bufferedCount = Math.min(Number(ranges.length) || 0, 64);
        let furthest = -1;
        for (let index = 0; index < bufferedCount; index++) {
          const start = ranges.start(index);
          const end = ranges.end(index);
          if (Number.isFinite(currentTime) && start <= currentTime && end >= currentTime) {
            currentBufferedEnd = metric(end);
            currentBufferedAhead = metric(Math.max(0, end - currentTime));
          }
          if (end > furthest) furthest = end;
        }
        if (furthest >= 0) furthestBufferedEnd = metric(furthest);
      } catch (_) {}

      let totalFrames = "unknown";
      let droppedFrames = "unknown";
      let corruptedFrames = "unknown";
      try {
        if (typeof video.getVideoPlaybackQuality === "function") {
          const quality = video.getVideoPlaybackQuality();
          if (quality) {
            totalFrames = metric(quality.totalVideoFrames, 0);
            droppedFrames = metric(quality.droppedVideoFrames, 0);
            corruptedFrames = metric(quality.corruptedVideoFrames, 0);
          }
        }
      } catch (_) {}
      if (totalFrames === "unknown" && Number.isFinite(Number(video.webkitDecodedFrameCount))) {
        totalFrames = metric(video.webkitDecodedFrameCount, 0);
      }
      if (droppedFrames === "unknown" && Number.isFinite(Number(video.webkitDroppedFrameCount))) {
        droppedFrames = metric(video.webkitDroppedFrameCount, 0);
      }

      return "event=" + eventName
        + " current_time=" + metric(currentTime)
        + " duration=" + metric(duration)
        + " ready_state=" + (Number(video.readyState) || 0)
        + " network_state=" + (Number(video.networkState) || 0)
        + " paused=" + Boolean(video.paused)
        + " ended=" + Boolean(video.ended)
        + " seeking=" + Boolean(video.seeking)
        + " playback_rate=" + metric(video.playbackRate, 2)
        + " video_size=" + (Number(video.videoWidth) || 0) + "x" + (Number(video.videoHeight) || 0)
        + " connected=" + elementConnected
        + " src_attr=" + sourceAttributePresent
        + " current_src=" + currentSourcePresent
        + " src_object=" + sourceObjectPresent
        + " child_sources=" + childSourceCount
        + " buffered_ranges=" + bufferedCount
        + " current_buffer_end=" + currentBufferedEnd
        + " buffered_ahead_s=" + currentBufferedAhead
        + " furthest_buffer_end=" + furthestBufferedEnd
        + " frames_total=" + totalFrames
        + " frames_dropped=" + droppedFrames
        + " frames_corrupted=" + corruptedFrames
        + " media_error_code=" + (Number.isFinite(errorCode) && errorCode > 0 ? errorCode : "none");
    }

    function attestationPlayerSnapshot(video, eventName) {
      const bufferedAhead = bufferedAheadSeconds(video);
      const errorCode = video.error && Number(video.error.code);
      return "event=" + eventName
        + " current_time=" + metric(video.currentTime)
        + " ready_state=" + (Number(video.readyState) || 0)
        + " network_state=" + (Number(video.networkState) || 0)
        + " paused=" + Boolean(video.paused)
        + " ended=" + Boolean(video.ended)
        + " seeking=" + Boolean(video.seeking)
        + " playback_rate=" + metric(video.playbackRate, 2)
        + " current_src=" + Boolean(video.currentSrc)
        + " src_attr=" + video.hasAttribute("src")
        + " src_object=" + (video.srcObject !== null)
        + " buffered_ahead_s=" + (bufferedAhead === null ? "unknown" : metric(bufferedAhead))
        + " media_error_code=" + (Number.isFinite(errorCode) && errorCode > 0 ? errorCode : "none")
        + " visibility=" + (document.visibilityState || "unknown");
    }

    function getWatchState(video, now) {
      let state = watchStates.get(video);
      if (!state) {
        const currentTime = Number(video.currentTime);
        state = {
          lastCurrentTime: Number.isFinite(currentTime) ? currentTime : 0,
          lastAdvanceAt: now,
          lastHeartbeatAt: now,
          playbackStarted: false,
          stallStartedAt: null,
          stallCause: null,
          unreadySince: null,
          unreadyReported: false,
          lastUnreadyHeartbeatAt: now
        };
        watchStates.set(video, state);
      }
      return state;
    }

    function bufferedAheadSeconds(video) {
      const currentTime = Number(video.currentTime);
      if (!Number.isFinite(currentTime)) return null;
      try {
        const ranges = video.buffered;
        for (let index = 0; index < ranges.length; index++) {
          const start = ranges.start(index);
          const end = ranges.end(index);
          if (start <= currentTime && end >= currentTime) {
            return Math.max(0, end - currentTime);
          }
        }
      } catch (_) {}
      return null;
    }

    function classifyClockStall(video) {
      if (document.visibilityState === "hidden") return "background_tab";
      if (Number(video.networkState) === 3) return "no_source";
      if (!video.currentSrc && !video.hasAttribute("src")
          && video.srcObject === null && video.querySelectorAll("source").length === 0) {
        return "source_unselected";
      }
      if (Number(video.readyState) < 3) return "insufficient_media_data";
      const bufferedAhead = bufferedAheadSeconds(video);
      if (bufferedAhead !== null && bufferedAhead <= 0.25) return "buffer_empty";
      return "clock_stopped_with_buffer";
    }

    function classifyMediaReadiness(video) {
      if (document.visibilityState === "hidden") return "background_tab";
      if (Number(video.networkState) === 3) return "no_source";
      if (!video.currentSrc && !video.hasAttribute("src")
          && video.srcObject === null && video.querySelectorAll("source").length === 0) {
        return "source_unselected";
      }
      if (Number(video.readyState) < 2) return "no_current_frame_data";
      const bufferedAhead = bufferedAheadSeconds(video);
      if (bufferedAhead === null || bufferedAhead <= 0.25) return "no_buffer_ahead";
      return "media_not_ready";
    }

    function recordWatchdog(video, eventName, now, state, stalledForMs, extraDetail = "") {
      const detail = "observed_at_unix_ms=" + Date.now()
        + " " + snapshot(video, eventName)
        + " last_advance_ago_ms=" + Math.max(0, Math.round(now - state.lastAdvanceAt))
        + " stalled_for_ms=" + Math.max(0, Math.round(stalledForMs || 0))
        + " visibility_state=" + (document.visibilityState || "unknown")
        + " stall_cause=" + (state.stallCause || "none")
        + (extraDetail ? " " + extraDetail : "");
      record("youtube_player_watchdog", "video", detail);
    }

    function pollPlaybackClock() {
      const now = performance.now();
      for (const video of observedVideoElements) {
        if (!video.isConnected) {
          observedVideoElements.delete(video);
          continue;
        }
        const state = getWatchState(video, now);
        const currentTime = Number(video.currentTime);
        if (!Number.isFinite(currentTime)) continue;

        const activelyRequested = !video.seeking && !video.paused && !video.ended
          && Number(video.playbackRate) !== 0;
        if (!activelyRequested) {
          state.lastCurrentTime = currentTime;
          state.lastAdvanceAt = now;
          state.playbackStarted = false;
          state.stallStartedAt = null;
          state.stallCause = null;
          state.unreadySince = null;
          state.unreadyReported = false;
          state.lastUnreadyHeartbeatAt = now;
          continue;
        }

        state.playbackStarted = true;
        const mediaReadyState = Number(video.readyState) || 0;
        if (mediaReadyState < 2) {
          if (state.unreadySince === null) state.unreadySince = now;
          const unreadyForMs = now - state.unreadySince;
          if (!state.unreadyReported && unreadyForMs >= WATCHDOG_STALL_MS) {
            state.unreadyReported = true;
            state.lastUnreadyHeartbeatAt = now;
            recordWatchdog(
              video,
              "playback_unready",
              now,
              state,
              unreadyForMs,
              "readiness_cause=" + classifyMediaReadiness(video)
            );
          } else if (state.unreadyReported
              && now - state.lastUnreadyHeartbeatAt >= WATCHDOG_HEARTBEAT_MS) {
            state.lastUnreadyHeartbeatAt = now;
            recordWatchdog(
              video,
              "playback_unready_heartbeat",
              now,
              state,
              unreadyForMs,
              "readiness_cause=" + classifyMediaReadiness(video)
            );
          }
        } else if (state.unreadySince !== null) {
          const unreadyForMs = now - state.unreadySince;
          if (state.unreadyReported) {
            recordWatchdog(
              video,
              "playback_ready",
              now,
              state,
              unreadyForMs,
              "readiness_recovered=true"
            );
          }
          state.unreadySince = null;
          state.unreadyReported = false;
          state.lastUnreadyHeartbeatAt = now;
        }

        const delta = currentTime - state.lastCurrentTime;
        if (delta >= 0.04) {
          state.lastCurrentTime = currentTime;
          state.lastAdvanceAt = now;
          if (state.stallStartedAt !== null) {
            recordWatchdog(video, "clock_resumed", now, state, now - state.stallStartedAt);
            state.stallStartedAt = null;
            state.stallCause = null;
            state.lastHeartbeatAt = now;
          }
        } else if (delta < -0.25) {
          // A seek or source reset moved the playhead backwards; start a new baseline.
          state.lastCurrentTime = currentTime;
          state.lastAdvanceAt = now;
          state.stallStartedAt = null;
          state.stallCause = null;
        } else {
          state.lastCurrentTime = currentTime;
        }

        const noAdvanceMs = now - state.lastAdvanceAt;
        if (state.stallStartedAt === null && noAdvanceMs >= WATCHDOG_STALL_MS) {
          state.stallStartedAt = state.lastAdvanceAt;
          state.stallCause = classifyClockStall(video);
          recordWatchdog(video, "clock_stalled", now, state, noAdvanceMs);
          state.lastHeartbeatAt = now;
        } else if (now - state.lastHeartbeatAt >= WATCHDOG_HEARTBEAT_MS) {
          const eventName = state.stallStartedAt === null ? "heartbeat" : "stalled_heartbeat";
          recordWatchdog(
            video,
            eventName,
            now,
            state,
            state.stallStartedAt === null ? 0 : now - state.stallStartedAt
          );
          state.lastHeartbeatAt = now;
        }
      }
    }

    function observeVideo(video) {
      if (!(video instanceof HTMLVideoElement)) return;
      observedVideoElements.add(video);
      const now = performance.now();
      const state = getWatchState(video, now);
      if (observedVideos.has(video)) return;
      observedVideos.add(video);
      for (const eventName of eventNames) {
        nativeAdd.call(video, eventName, () => {
          const eventAt = performance.now();
          if (eventName === "playing") {
            state.playbackStarted = true;
            state.lastCurrentTime = Number(video.currentTime) || 0;
            state.lastAdvanceAt = eventAt;
            state.lastHeartbeatAt = eventAt;
            state.stallStartedAt = null;
            state.stallCause = null;
            state.unreadySince = null;
            state.unreadyReported = false;
            state.lastUnreadyHeartbeatAt = eventAt;
          } else if (eventName === "play" && !video.paused) {
            state.playbackStarted = true;
            state.lastCurrentTime = Number(video.currentTime) || 0;
            state.lastAdvanceAt = eventAt;
          } else if (eventName === "seeking" || eventName === "seeked"
              || eventName === "pause" || eventName === "ended"
              || eventName === "emptied" || eventName === "error") {
            state.lastCurrentTime = Number(video.currentTime) || 0;
            state.lastAdvanceAt = eventAt;
            state.stallStartedAt = null;
            state.stallCause = null;
            state.unreadySince = null;
            state.unreadyReported = false;
            state.lastUnreadyHeartbeatAt = eventAt;
            if (video.paused || video.ended || eventName === "emptied" || eventName === "error") {
              state.playbackStarted = false;
            }
          }
          latestYouTubePlayerState = {at: eventAt, detail: attestationPlayerSnapshot(video, eventName)};
          if (sampledEvents.has(eventName)) {
            let samples = lastSampleAt.get(video);
            if (!samples) {
              samples = new Map();
              lastSampleAt.set(video, samples);
            }
            const previous = samples.get(eventName);
            if (previous !== undefined && now - previous < sampleIntervalMs) return;
            samples.set(eventName, now);
          }
          record("youtube_player_state", "video", "observed_at_unix_ms=" + Date.now() + " " + snapshot(video, eventName));
        });
      }
      latestYouTubePlayerState = {at: now, detail: attestationPlayerSnapshot(video, "observed")};
      record("youtube_player_state", "video", "observed_at_unix_ms=" + Date.now() + " " + latestYouTubePlayerState.detail);
    }

    function observeTree(root) {
      if (!root) return;
      if (root instanceof HTMLVideoElement) observeVideo(root);
      if (typeof root.querySelectorAll === "function") {
        for (const video of root.querySelectorAll("video")) observeVideo(video);
      }
    }

    installYouTubeMediaMutationDiagnostics();
    observeTree(document);
    window.setInterval(pollPlaybackClock, WATCHDOG_INTERVAL_MS);
    try {
      const observer = new MutationObserver(records => {
        for (const mutation of records) {
          for (const node of mutation.addedNodes) observeTree(node);
        }
      });
      observer.observe(document.documentElement || document, {childList: true, subtree: true});
    } catch (_) {
      // Video lifecycle diagnostics are optional and must not affect playback.
    }
  }

  observeYouTubePlayerState();

  function sanitizedYouTubeFetchCallsite(maxFrames = 2) {
    try {
      const frames = String(new Error().stack || "").split("\n").slice(3);
      const safeFrames = [];
      for (const frame of frames) {
        const match = frame.match(/https?:\/\/[^\s)]+/);
        if (!match) continue;

        const raw = match[0];
        const position = raw.match(/:(\d+):(\d+)$/);
        const address = position ? raw.slice(0, -position[0].length) : raw;
        const parsed = new URL(address);
        const segments = parsed.pathname.split("/").filter(Boolean);
        const file = segments.length ? segments[segments.length - 1].slice(0, 36) : "script";
        const functionName = frame.slice(0, match.index)
          .replace(/^\s*at\s+/, "")
          .replace(/[\s(@]+$/, "")
          .trim()
          .slice(0, 28);
        const scriptLocation = parsed.hostname + "/" + file
          + (position ? ":" + position[1] + ":" + position[2] : "");
        safeFrames.push((functionName ? functionName + "@" : "") + scriptLocation);
        if (safeFrames.length >= Math.max(1, Math.min(6, Number(maxFrames) || 2))) break;
      }
      return safeFrames.length ? safeFrames.join(">") : "unavailable";
    } catch (_) {
      return "unavailable";
    }
  }

  function youtubePlayerTimerContext() {
    const now = performance.now();
    const activeTimer = activeYouTubePlayerTimer;

    // Keep slower timers in a separate bounded registry. High-frequency
    // zero/short-delay callbacks can churn through the fire ring buffer, but
    // they must not erase the last-fire timestamp of a 30s/60s player job.
    const slowEntries = Array.from(recentlyFiredSlowYouTubeTimers.values())
      .filter(timer => Number.isFinite(timer.lastFiredAt)
        && now - timer.lastFiredAt <= 15000)
      .map(timer => ({timer, firedAt: timer.lastFiredAt}))
      .sort((left, right) => left.firedAt - right.firedAt)
      .slice(-2);

    const selected = [];
    if (activeTimer) {
      selected.push({timer: activeTimer, firedAt: activeTimer.lastFiredAt});
    }
    for (const entry of slowEntries) {
      if (entry.timer !== activeTimer) selected.push(entry);
    }

    function summarize(entry) {
      const timer = entry.timer;
      const firedAgo = Number.isFinite(entry.firedAt)
        ? Math.max(0, Math.round(now - entry.firedAt))
        : -1;
      return timer.kind + "#" + timer.id
        + ":" + (timer === activeTimer ? "active" : "recent")
        + ":" + timer.delayMs + "ms"
        + ":" + timer.fireCount + "fires"
        + ":" + firedAgo + "msAgo";
    }

    const recentShortTimers = new Map();
    for (const entry of recentYouTubePlayerTimerFires) {
      if (now - entry.firedAt > 15000 || entry.timer.delayMs > 100) continue;
      recentShortTimers.set(entry.timer, entry);
    }
    const pollers = Array.from(recentShortTimers.values())
      .sort((left, right) => left.firedAt - right.firedAt)
      .slice(-2)
      .map(entry => {
        const timer = entry.timer;
        const firedAgo = Math.max(0, Math.round(now - entry.firedAt));
        return timer.kind + "#" + timer.id
          + ":" + timer.delayMs + "ms"
          + ":" + timer.fireCount + "fires"
          + ":" + firedAgo + "msAgo";
      });

    const fields = [];
    if (selected.length) fields.push("timers=" + selected.map(summarize).join(","));
    if (pollers.length) fields.push("pollers=" + pollers.join(","));
    return fields.length ? fields.join(";").slice(0, 520) : null;
  }
  function instrumentYouTubePlayerTimer(kind, nativeTimer) {
    if (typeof nativeTimer !== "function") return nativeTimer;
    return function(handler, delay, ...args) {
      if (typeof handler !== "function") {
        return Reflect.apply(nativeTimer, this, [handler, delay, ...args]);
      }

      const callsite = sanitizedYouTubeFetchCallsite(2);
      const isKevlarRuntime = /kevlar_base_module|kevlar_main_mod/i.test(callsite);
      const isBaseRuntime = /m=base(?::|[,/]|$)/i.test(callsite);
      if (!isKevlarRuntime && !isBaseRuntime) {
        return Reflect.apply(nativeTimer, this, [handler, delay, ...args]);
      }

      youtubePlayerTimerSequence = (youtubePlayerTimerSequence % 999999) + 1;
      const numericDelay = Number(delay);
      const timer = {
        id: youtubePlayerTimerSequence,
        kind,
        delayMs: Number.isFinite(numericDelay)
          ? Math.max(0, Math.min(2147483647, Math.round(numericDelay)))
          : 0,
        scheduledAt: performance.now(),
        callsite,
        fireCount: 0,
        lastFiredAt: null
      };

      // Emit registration metadata once per unique player timer site. This
      // makes the scheduler visible even when a later GenerateIT event omits
      // or truncates its timer-context suffix.
      const callbackName = String(handler.name || "anonymous")
        .replace(/[^A-Za-z0-9_$.-]/g, "").slice(0, 40) || "anonymous";
      const registrationKey = kind + "|" + timer.delayMs + "|" + callsite;
      if (!observedYouTubeTimerRegistrations.has(registrationKey)
          && observedYouTubeTimerRegistrations.size < 96) {
        observedYouTubeTimerRegistrations.add(registrationKey);
        record("youtube_player_runtime", "player timer",
          "phase=timer_registered runtime=" + (isBaseRuntime ? "base" : "kevlar")
          + " timer=" + kind + "#" + timer.id
          + " delay_ms=" + timer.delayMs
          + " callback=" + callbackName
          + " scheduled_by=" + callsite);
      }

      if (timer.delayMs > 100) {
        recentlyFiredSlowYouTubeTimers.set(timer.id, timer);
        while (recentlyFiredSlowYouTubeTimers.size > 64) {
          const oldestId = recentlyFiredSlowYouTubeTimers.keys().next().value;
          recentlyFiredSlowYouTubeTimers.delete(oldestId);
        }
      }

      const observedHandler = function(...callbackArgs) {
        const firedAt = performance.now();
        timer.fireCount++;
        timer.lastFiredAt = firedAt;
        recentYouTubePlayerTimerFires.push({timer, firedAt});
        while (recentYouTubePlayerTimerFires.length > 12) {
          recentYouTubePlayerTimerFires.shift();
        }
        while (recentYouTubePlayerTimerFires.length
            && firedAt - recentYouTubePlayerTimerFires[0].firedAt > 15000) {
          recentYouTubePlayerTimerFires.shift();
        }

        const previousTimer = activeYouTubePlayerTimer;
        activeYouTubePlayerTimer = timer;
        try {
          return handler.apply(this, callbackArgs);
        } finally {
          activeYouTubePlayerTimer = previousTimer;
        }
      };
      return Reflect.apply(nativeTimer, this, [observedHandler, delay, ...args]);
    };
  }

  (function observeYouTubePlayerTimers() {
    try {
      const nativeSetTimeout = window.setTimeout;
      const nativeSetInterval = window.setInterval;
      window.setTimeout = instrumentYouTubePlayerTimer("timeout", nativeSetTimeout);
      window.setInterval = instrumentYouTubePlayerTimer("interval", nativeSetInterval);
      record("youtube_player_runtime", "player timers",
        "phase=timer_observer_installed scope=kevlar_and_base");
    } catch (error) {
      const errorName = String(error && error.name || "unknown")
        .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
      record("youtube_player_runtime", "kevlar timers",
        "phase=timer_observer_install_failed error=" + errorName);
    }
  })();

  let youtubeSabrRequestBodyMeasurementStarted = false;

  function requestBodyPropertyDiagnostic(request) {
    try {
      const body = request.body;
      if (body === null) return "null";
      if (body === undefined) return "undefined";
      return "non_null";
    } catch (_) {
      return "throws";
    }
  }

  function requestCloneByteCount(request) {
    let clone;
    try {
      clone = request.clone();
    } catch (error) {
      const errorName = String(error && error.name || "unknown")
        .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
      return Promise.resolve({ok: false, errorName});
    }

    try {
      if (!clone || typeof clone.arrayBuffer !== "function") {
        return Promise.resolve({ok: false, errorName: "BodyReadUnavailable"});
      }
      return clone.arrayBuffer().then(buffer => ({
        ok: true,
        bytes: buffer.byteLength
      }), error => {
        const errorName = String(error && error.name || "unknown")
          .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
        return {ok: false, errorName};
      });
    } catch (error) {
      const errorName = String(error && error.name || "unknown")
        .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
      return Promise.resolve({ok: false, errorName});
    }
  }

  function recordYouTubeSabrRequestBodyMeasurement(originalRequest, routedRequest) {
    const originalBodyProperty = requestBodyPropertyDiagnostic(originalRequest);
    const routedBodyProperty = requestBodyPropertyDiagnostic(routedRequest);
    const originalMeasurement = requestCloneByteCount(originalRequest);
    const routedMeasurement = requestCloneByteCount(routedRequest);

    Promise.all([originalMeasurement, routedMeasurement]).then(([original, routed]) => {
      const describe = measurement => measurement.ok
        ? "ok bytes=" + measurement.bytes
        : "error name=" + measurement.errorName;
      record(
        "youtube_sabr_request_body_measurement",
        "/videoplayback",
        "original_body_property=" + originalBodyProperty
          + " original_clone=" + describe(original)
          + " routed_body_property=" + routedBodyProperty
          + " routed_clone=" + describe(routed)
      );
    }, () => {
      record("youtube_sabr_request_body_measurement", "/videoplayback",
        "original_clone=error name=MeasurementFailed routed_clone=error name=MeasurementFailed");
    });
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



  function youtubePlayerEndpointCheck(source) {
    try {
      const upstream = new URL(upstreamOrigin);
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      const host = upstream.hostname.toLowerCase();
      const upstreamHostMatch = host === "youtube.com" || host.endsWith(".youtube.com");
      const candidatePathMatch = candidate.pathname === "/youtubei/v1/player";
      return {
        endpointMatch: upstreamHostMatch && candidatePathMatch,
        upstreamHostMatch,
        candidatePathMatch
      };
    } catch (_) {
      return {endpointMatch: false, upstreamHostMatch: false, candidatePathMatch: false};
    }
  }

  function findYouTubeFeedbackToken(roots) {
    const queue = roots.filter(value => value && typeof value === "object")
      .map(value => ({value, depth: 0}));
    const seen = new WeakSet();
    let visited = 0;
    while (queue.length && visited < 2400) {
      const entry = queue.shift();
      const value = entry.value;
      if (!value || typeof value !== "object" || seen.has(value) || entry.depth > 10) continue;
      seen.add(value);
      visited++;
      let keys;
      try { keys = Object.keys(value).slice(0, 100); } catch (_) { continue; }
      for (const key of keys) {
        let child;
        try { child = value[key]; } catch (_) { continue; }
        if (key.toLowerCase() === "feedbacktoken" && typeof child === "string"
            && child.length >= 16 && child.length <= 8192) {
          return child;
        }
        if (!child || typeof child !== "object") continue;
        // Avoid walking DOM ownership graphs or browser globals. Polymer's
        // serializable __data/data objects and command payloads remain visible.
        if (["parentnode", "ownerdocument", "documentelement", "defaultview",
             "window", "host", "rootnode"].includes(key.toLowerCase())) continue;
        if (Array.isArray(child)) {
          for (const item of child.slice(0, 80)) {
            if (item && typeof item === "object") queue.push({value: item, depth: entry.depth + 1});
          }
        } else {
          queue.push({value: child, depth: entry.depth + 1});
        }
      }
    }
    return null;
  }

  function captureYouTubeFeedbackToken(event) {
    const roots = [];
    try {
      if (typeof event.composedPath === "function") {
        for (const node of event.composedPath().slice(0, 16)) {
          if (!(node instanceof Element)) continue;
          try { roots.push(node.__data, node.data, node.data_); } catch (_) {}
          try {
            if (node.__dataHost) roots.push(node.__dataHost.__data, node.__dataHost.data);
          } catch (_) {}
        }
      }
    } catch (_) {}
    let node = event.target instanceof Element ? event.target : null;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      try { roots.push(node.__data, node.data, node.data_); } catch (_) {}
    }
    const token = findYouTubeFeedbackToken(roots);
    if (token) {
      recentYouTubeFeedbackToken = {token, at: performance.now()};
      record("youtube_feedback_token_captured", "clicked YouTube control",
        "source=live_element_model · token_present=true");
    }
  }

  function youtubeGetWatchEndpointCheck(source) {
    try {
      const upstream = new URL(upstreamOrigin);
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      const host = upstream.hostname.toLowerCase();
      const upstreamHostMatch = host === "youtube.com" || host.endsWith(".youtube.com");
      const candidatePathMatch = candidate.pathname === "/youtubei/v1/get_watch";
      return {
        endpointMatch: upstreamHostMatch && candidatePathMatch,
        upstreamHostMatch,
        candidatePathMatch
      };
    } catch (_) {
      return {endpointMatch: false, upstreamHostMatch: false, candidatePathMatch: false};
    }
  }

  async function buildYouTubePlayerFallbackBody() {
    let config = null;
    let context = null;
    let playerResponse = null;
    let playerArgs = null;
    try {
      config = window.ytcfg;
      if (config && typeof config.get === "function") {
        context = config.get("INNERTUBE_CONTEXT");
      }
      if (!context && config && config.data_) context = config.data_.INNERTUBE_CONTEXT;
    } catch (_) {}
    try {
      playerResponse = window.ytInitialPlayerResponse || null;
      playerArgs = window.ytplayer && window.ytplayer.config
        && window.ytplayer.config.args || null;
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
            && Object.prototype.hasOwnProperty.call(config.data_, key)) return config.data_[key];
      } catch (_) {}
      return undefined;
    };
    const candidateIds = [];
    let videoIdSource = "unavailable";
    const addId = (value, source) => {
      if (typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value)
          && !candidateIds.includes(value)) {
        candidateIds.push(value);
        if (videoIdSource === "unavailable") videoIdSource = source;
      }
    };

    // During YouTube SPA navigation, /player can fire before location.href,
    // ytInitialPlayerResponse, and the video element have updated. Prefer the
    // recently clicked destination, just as the get_watch/next fallbacks do.
    // Do not consume this state here: get_watch may still need it in parallel.
    const pendingNavigation = recentYouTubeVideoNavigation;
    const pendingNavigationIsFresh = Boolean(
      pendingNavigation && performance.now() - pendingNavigation.at <= 12000
    );
    if (pendingNavigationIsFresh) {
      addId(pendingNavigation.videoId, "recent_navigation_click");
    }

    try {
      const url = new URL(location.href);
      addId(url.searchParams.get("v"), "current_url");
      const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
      if (match) addId(match[1], "current_url");
    } catch (_) {}
    try {
      addId(playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.videoId,
        "ytInitialPlayerResponse");
    } catch (_) {}
    try { addId(playerArgs && playerArgs.video_id, "ytplayer.config.args"); } catch (_) {}
    try {
      const video = document.querySelector("video");
      const source = video && (video.currentSrc || video.src);
      if (source) {
        const url = new URL(source, location.href);
        addId(url.searchParams.get("video_id"), "video_source");
        addId(url.searchParams.get("v"), "video_source");
      }
    } catch (_) {}

    const videoId = candidateIds[0];
    if (!videoId) return {body: null, reason: "video_id unavailable"};

    try {
      const client = context.client;
      const payload = {
        context: {client},
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      };
      // These values are optional in the player request. Copy them only when
      // the current page exposes a well-formed live value.
      const contextRequest = context.request;
      if (contextRequest && typeof contextRequest === "object" && !Array.isArray(contextRequest)) {
        payload.request = {...contextRequest};
      }
      const playbackContext = configValue("PLAYER_PLAYBACK_CONTEXT");
      if (playbackContext && typeof playbackContext === "object" && !Array.isArray(playbackContext)) {
        payload.playbackContext = playbackContext;
      } else {
        const signatureTimestamp = playerArgs && playerArgs.sts;
        if ((typeof signatureTimestamp === "number" && Number.isFinite(signatureTimestamp))
            || (typeof signatureTimestamp === "string" && /^\d+$/.test(signatureTimestamp))) {
          payload.playbackContext = {
            contentPlaybackContext: {signatureTimestamp: Number(signatureTimestamp)}
          };
        }
      }

      const headers = {"Content-Type": "application/json"};
      const loggedIn = configValue("LOGGED_IN");
      if (typeof loggedIn === "boolean") headers["X-YouTube-Bootstrap-Logged-In"] = String(loggedIn);
      if (client.clientName === "WEB") headers["X-YouTube-Client-Name"] = "1";
      if (typeof client.clientVersion === "string" && client.clientVersion.trim()) {
        headers["X-YouTube-Client-Version"] = client.clientVersion.trim();
      }
      if (typeof client.visitorData === "string" && client.visitorData.trim()) {
        headers["X-Goog-Visitor-Id"] = client.visitorData.trim();
      }
      const dataSyncId = configValue("DATASYNC_ID");
      if (typeof dataSyncId === "string" && dataSyncId.length > 0 && dataSyncId.length <= 512) {
        headers["X-Intercept-YouTube-DataSync-Id"] = dataSyncId;
      }
      let youtubeOrigin = "https://www.youtube.com";
      const configuredApiHost = configValue("INNERTUBE_HOST");
      if (typeof configuredApiHost === "string" && configuredApiHost.trim()) {
        try {
          const candidate = new URL(configuredApiHost.includes("://")
            ? configuredApiHost : "https://" + configuredApiHost);
          const host = candidate.hostname.toLowerCase();
          if (candidate.protocol === "https:"
              && (host === "youtube.com" || host.endsWith(".youtube.com"))
              && !candidate.username && !candidate.password && !candidate.search && !candidate.hash) {
            youtubeOrigin = candidate.origin;
          }
        } catch (_) {}
      }
      headers["X-Origin"] = youtubeOrigin;
      const sessionIndex = configValue("SESSION_INDEX");
      headers["X-Goog-AuthUser"] = (
        (typeof sessionIndex === "number" && Number.isInteger(sessionIndex) && sessionIndex >= 0)
        || (typeof sessionIndex === "string" && /^\d+$/.test(sessionIndex))
      ) ? String(sessionIndex) : "0";

      return {
        body: JSON.stringify(payload),
        headers,
        videoIdSource,
        payloadKeys: Object.keys(payload).join(","),
        clientName: typeof client.clientName === "string" ? client.clientName.slice(0, 24) : "unknown",
        clientVersion: typeof client.clientVersion === "string" ? client.clientVersion.slice(0, 48) : "unknown",
        playbackContextPresent: Boolean(payload.playbackContext)
      };
    } catch (error) {
      return {body: null, reason: "fallback_error=" + String(error && error.name || "unknown").slice(0, 40)};
    }
  }

  async function buildYouTubeGetWatchFallbackBody() {
    let config = null;
    let context = null;
    let playerResponse = null;
    let playerArgs = null;
    try {
      config = window.ytcfg;
      if (config && typeof config.get === "function") {
        context = config.get("INNERTUBE_CONTEXT");
      }
      if (!context && config && config.data_) context = config.data_.INNERTUBE_CONTEXT;
    } catch (_) {}
    try {
      playerResponse = window.ytInitialPlayerResponse || null;
      playerArgs = window.ytplayer && window.ytplayer.config
        && window.ytplayer.config.args || null;
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
            && Object.prototype.hasOwnProperty.call(config.data_, key)) return config.data_[key];
      } catch (_) {}
      return undefined;
    };

    const candidateIds = [];
    let videoIdSource = "unavailable";
    const addId = (value, source) => {
      if (typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value)
          && !candidateIds.includes(value)) {
        candidateIds.push(value);
        if (videoIdSource === "unavailable") videoIdSource = source;
      }
    };

    // YouTube fires get_watch before its SPA navigation necessarily updates
    // location.href. Prefer the most recent clicked watch target when fresh.
    const pendingNavigation = recentYouTubeVideoNavigation;
    const pendingNavigationIsFresh = Boolean(
      pendingNavigation && performance.now() - pendingNavigation.at <= 12000
    );
    if (pendingNavigationIsFresh) {
      addId(pendingNavigation.videoId, "recent_navigation_click");
    }

    try {
      const url = new URL(location.href);
      addId(url.searchParams.get("v"), "current_url");
      const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
      if (match) addId(match[1], "current_url");
    } catch (_) {}
    try {
      addId(playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.videoId,
        "ytInitialPlayerResponse");
    } catch (_) {}
    try { addId(playerArgs && playerArgs.video_id, "ytplayer.config.args"); } catch (_) {}
    try {
      const video = document.querySelector("video");
      const source = video && (video.currentSrc || video.src);
      if (source) {
        const url = new URL(source, location.href);
        addId(url.searchParams.get("video_id"), "video_source");
        addId(url.searchParams.get("v"), "video_source");
      }
    } catch (_) {}

    const videoId = candidateIds[0];
    if (!videoId) return {body: null, reason: "video_id unavailable"};

    try {
      // GetWatchRequest is a compound InnerTube request. Its outer context
      // accompanies a PlayerRequest and a WatchNextRequest; both subrequests
      // carry the same live page context and target video.
      const playerRequest = {
        context,
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      };
      const watchNextRequest = {
        context,
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      };

      const playbackContext = configValue("PLAYER_PLAYBACK_CONTEXT");
      if (playbackContext && typeof playbackContext === "object" && !Array.isArray(playbackContext)) {
        playerRequest.playbackContext = playbackContext;
      } else {
        const signatureTimestamp = configValue("STS") || (playerArgs && playerArgs.sts);
        if ((typeof signatureTimestamp === "number" && Number.isFinite(signatureTimestamp))
            || (typeof signatureTimestamp === "string" && /^\d+$/.test(signatureTimestamp))) {
          playerRequest.playbackContext = {
            contentPlaybackContext: {signatureTimestamp: Number(signatureTimestamp)}
          };
        }
      }

      // Use the clicked destination's playlist state during SPA navigation;
      // location.href can still describe the previous video at this point.
      if (pendingNavigationIsFresh) {
        if (pendingNavigation.playlistId && pendingNavigation.playlistId.length <= 256) {
          watchNextRequest.playlistId = pendingNavigation.playlistId;
        }
        if (Number.isInteger(pendingNavigation.playlistIndex) && pendingNavigation.playlistIndex >= 0) {
          watchNextRequest.playlistIndex = pendingNavigation.playlistIndex;
        }
      } else {
        try {
          const pageUrl = new URL(location.href);
          const playlistId = pageUrl.searchParams.get("list");
          if (playlistId && playlistId.length <= 256) watchNextRequest.playlistId = playlistId;
          const playlistIndex = pageUrl.searchParams.get("index");
          if (playlistIndex && /^\d+$/.test(playlistIndex)) {
            watchNextRequest.playlistIndex = Number(playlistIndex);
          }
        } catch (_) {}
      }

      const payload = {
        context,
        playerRequest,
        watchNextRequest
      };
      const client = context.client;
      const headers = {"Content-Type": "application/json"};
      const loggedIn = configValue("LOGGED_IN");
      if (typeof loggedIn === "boolean") headers["X-YouTube-Bootstrap-Logged-In"] = String(loggedIn);
      if (client.clientName === "WEB") headers["X-YouTube-Client-Name"] = "1";
      if (typeof client.clientVersion === "string" && client.clientVersion.trim()) {
        headers["X-YouTube-Client-Version"] = client.clientVersion.trim();
      }
      if (typeof client.visitorData === "string" && client.visitorData.trim()) {
        headers["X-Goog-Visitor-Id"] = client.visitorData.trim();
      }
      const dataSyncId = configValue("DATASYNC_ID");
      if (typeof dataSyncId === "string" && dataSyncId.length > 0 && dataSyncId.length <= 512) {
        headers["X-Intercept-YouTube-DataSync-Id"] = dataSyncId;
      }

      let youtubeOrigin = "https://www.youtube.com";
      const configuredApiHost = configValue("INNERTUBE_HOST");
      if (typeof configuredApiHost === "string" && configuredApiHost.trim()) {
        try {
          const candidate = new URL(configuredApiHost.includes("://")
            ? configuredApiHost : "https://" + configuredApiHost);
          const host = candidate.hostname.toLowerCase();
          if (candidate.protocol === "https:"
              && (host === "youtube.com" || host.endsWith(".youtube.com"))
              && !candidate.username && !candidate.password && !candidate.search && !candidate.hash) {
            youtubeOrigin = candidate.origin;
          }
        } catch (_) {}
      }
      headers["X-Origin"] = youtubeOrigin;
      const sessionIndex = configValue("SESSION_INDEX");
      headers["X-Goog-AuthUser"] = (
        (typeof sessionIndex === "number" && Number.isInteger(sessionIndex) && sessionIndex >= 0)
        || (typeof sessionIndex === "string" && /^\d+$/.test(sessionIndex))
      ) ? String(sessionIndex) : "0";

      return {
        body: JSON.stringify(payload),
        headers,
        videoIdSource,
        payloadKeys: Object.keys(payload).join(","),
        playerRequestKeys: Object.keys(playerRequest).join(","),
        watchNextRequestKeys: Object.keys(watchNextRequest).join(","),
        clientName: typeof client.clientName === "string" ? client.clientName.slice(0, 24) : "unknown",
        clientVersion: typeof client.clientVersion === "string" ? client.clientVersion.slice(0, 48) : "unknown",
        playbackContextPresent: Boolean(playerRequest.playbackContext)
      };
    } catch (error) {
      return {body: null, reason: "fallback_error=" + String(error && error.name || "unknown").slice(0, 40)};
    }
  }

  function youtubeNextEndpointCheck(source) {
    try {
      const upstream = new URL(upstreamOrigin);
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      const host = upstream.hostname.toLowerCase();
      const upstreamHostMatch = host === "youtube.com" || host.endsWith(".youtube.com");
      const candidatePathMatch = candidate.pathname === "/youtubei/v1/next";
      return {
        endpointMatch: upstreamHostMatch && candidatePathMatch,
        upstreamHostMatch,
        candidatePathMatch
      };
    } catch (_) {
      return {endpointMatch: false, upstreamHostMatch: false, candidatePathMatch: false};
    }
  }

  function youtubeFeedbackEndpointCheck(source) {
    try {
      const upstream = new URL(upstreamOrigin);
      const candidate = new URL(
        source instanceof Request ? source.url : String(source),
        document.baseURI
      );
      const host = upstream.hostname.toLowerCase();
      const upstreamHostMatch = host === "youtube.com" || host.endsWith(".youtube.com");
      const candidatePathMatch = candidate.pathname === "/youtubei/v1/feedback";
      return {
        endpointMatch: upstreamHostMatch && candidatePathMatch,
        upstreamHostMatch,
        candidatePathMatch
      };
    } catch (_) {
      return {endpointMatch: false, upstreamHostMatch: false, candidatePathMatch: false};
    }
  }

  async function buildYouTubeNextFallbackBody() {
    let config = null;
    let context = null;
    let playerResponse = null;
    try {
      config = window.ytcfg;
      if (config && typeof config.get === "function") context = config.get("INNERTUBE_CONTEXT");
      if (!context && config && config.data_) context = config.data_.INNERTUBE_CONTEXT;
      playerResponse = window.ytInitialPlayerResponse || null;
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
            && Object.prototype.hasOwnProperty.call(config.data_, key)) return config.data_[key];
      } catch (_) {}
      return undefined;
    };

    const candidateIds = [];
    let videoIdSource = "unavailable";
    const addId = (value, source) => {
      if (typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value)
          && !candidateIds.includes(value)) {
        candidateIds.push(value);
        if (videoIdSource === "unavailable") videoIdSource = source;
      }
    };
    const pendingNavigation = recentYouTubeVideoNavigation;
    const pendingNavigationIsFresh = Boolean(
      pendingNavigation && performance.now() - pendingNavigation.at <= 12000
    );
    if (pendingNavigationIsFresh) addId(pendingNavigation.videoId, "recent_navigation_click");
    try {
      const url = new URL(location.href);
      addId(url.searchParams.get("v"), "current_url");
      const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
      if (match) addId(match[1], "current_url");
    } catch (_) {}
    try { addId(playerResponse && playerResponse.videoDetails && playerResponse.videoDetails.videoId,
      "ytInitialPlayerResponse"); } catch (_) {}
    try {
      const video = document.querySelector("video");
      const source = video && (video.currentSrc || video.src);
      if (source) {
        const url = new URL(source, location.href);
        addId(url.searchParams.get("video_id"), "video_source");
        addId(url.searchParams.get("v"), "video_source");
      }
    } catch (_) {}
    const videoId = candidateIds[0];
    if (!videoId) return {body: null, reason: "video_id unavailable"};

    try {
      const payload = {
        context,
        videoId,
        racyCheckOk: true,
        contentCheckOk: true
      };
      const playlistId = pendingNavigationIsFresh
        ? pendingNavigation.playlistId
        : (() => { try { return new URL(location.href).searchParams.get("list"); } catch (_) { return null; } })();
      const playlistIndex = pendingNavigationIsFresh
        ? pendingNavigation.playlistIndex
        : (() => { try { const value = new URL(location.href).searchParams.get("index");
          return value && /^\d+$/.test(value) ? Number(value) : null; } catch (_) { return null; } })();
      const navigationParams = pendingNavigationIsFresh
        ? pendingNavigation.params
        : (() => { try { return new URL(location.href).searchParams.get("params"); } catch (_) { return null; } })();
      if (typeof playlistId === "string" && playlistId.length <= 256) payload.playlistId = playlistId;
      if (Number.isInteger(playlistIndex) && playlistIndex >= 0) payload.playlistIndex = playlistIndex;
      if (typeof navigationParams === "string" && navigationParams.length <= 4096) {
        payload.params = navigationParams;
      }

      const client = context.client;
      const headers = {"Content-Type": "application/json"};
      const loggedIn = configValue("LOGGED_IN");
      if (typeof loggedIn === "boolean") headers["X-YouTube-Bootstrap-Logged-In"] = String(loggedIn);
      if (client.clientName === "WEB") headers["X-YouTube-Client-Name"] = "1";
      if (typeof client.clientVersion === "string" && client.clientVersion.trim()) {
        headers["X-YouTube-Client-Version"] = client.clientVersion.trim();
      }
      if (typeof client.visitorData === "string" && client.visitorData.trim()) {
        headers["X-Goog-Visitor-Id"] = client.visitorData.trim();
      }
      const dataSyncId = configValue("DATASYNC_ID");
      if (typeof dataSyncId === "string" && dataSyncId.length > 0 && dataSyncId.length <= 512) {
        headers["X-Intercept-YouTube-DataSync-Id"] = dataSyncId;
      }
      let youtubeOrigin = "https://www.youtube.com";
      const configuredApiHost = configValue("INNERTUBE_HOST");
      if (typeof configuredApiHost === "string" && configuredApiHost.trim()) {
        try {
          const candidate = new URL(configuredApiHost.includes("://")
            ? configuredApiHost : "https://" + configuredApiHost);
          const host = candidate.hostname.toLowerCase();
          if (candidate.protocol === "https:"
              && (host === "youtube.com" || host.endsWith(".youtube.com"))
              && !candidate.username && !candidate.password && !candidate.search && !candidate.hash) {
            youtubeOrigin = candidate.origin;
          }
        } catch (_) {}
      }
      headers["X-Origin"] = youtubeOrigin;
      const sessionIndex = configValue("SESSION_INDEX");
      headers["X-Goog-AuthUser"] = (
        (typeof sessionIndex === "number" && Number.isInteger(sessionIndex) && sessionIndex >= 0)
        || (typeof sessionIndex === "string" && /^\d+$/.test(sessionIndex))
      ) ? String(sessionIndex) : "0";

      return {
        body: JSON.stringify(payload),
        headers,
        videoIdSource,
        payloadKeys: Object.keys(payload).join(","),
        clientName: typeof client.clientName === "string" ? client.clientName.slice(0, 24) : "unknown",
        clientVersion: typeof client.clientVersion === "string" ? client.clientVersion.slice(0, 48) : "unknown"
      };
    } catch (error) {
      return {body: null, reason: "fallback_error=" + String(error && error.name || "unknown").slice(0, 40)};
    }
  }

  async function buildYouTubeFeedbackFallbackBody() {
    let config = null;
    let context = null;
    try {
      config = window.ytcfg;
      if (config && typeof config.get === "function") context = config.get("INNERTUBE_CONTEXT");
      if (!context && config && config.data_) context = config.data_.INNERTUBE_CONTEXT;
    } catch (_) {}
    if (!context || typeof context !== "object" || !context.client) {
      return {body: null, reason: "INNERTUBE_CONTEXT unavailable"};
    }
    const pending = recentYouTubeFeedbackToken;
    recentYouTubeFeedbackToken = null;
    if (!pending || performance.now() - pending.at > 10000) {
      return {body: null, reason: "clicked feedback token unavailable"};
    }
    try {
      const payload = {
        context,
        isFeedbackTokenUnencrypted: false,
        shouldMerge: false,
        feedbackTokens: [pending.token]
      };
      const configValue = key => {
        try {
          if (config && typeof config.get === "function") {
            const value = config.get(key);
            if (value !== undefined && value !== null) return value;
          }
          if (config && config.data_
              && Object.prototype.hasOwnProperty.call(config.data_, key)) return config.data_[key];
        } catch (_) {}
        return undefined;
      };
      const client = context.client;
      const headers = {"Content-Type": "application/json"};
      const loggedIn = configValue("LOGGED_IN");
      if (typeof loggedIn === "boolean") headers["X-YouTube-Bootstrap-Logged-In"] = String(loggedIn);
      if (client.clientName === "WEB") headers["X-YouTube-Client-Name"] = "1";
      if (typeof client.clientVersion === "string" && client.clientVersion.trim()) {
        headers["X-YouTube-Client-Version"] = client.clientVersion.trim();
      }
      if (typeof client.visitorData === "string" && client.visitorData.trim()) {
        headers["X-Goog-Visitor-Id"] = client.visitorData.trim();
      }
      const dataSyncId = configValue("DATASYNC_ID");
      if (typeof dataSyncId === "string" && dataSyncId.length > 0 && dataSyncId.length <= 512) {
        headers["X-Intercept-YouTube-DataSync-Id"] = dataSyncId;
      }
      let youtubeOrigin = "https://www.youtube.com";
      const configuredApiHost = configValue("INNERTUBE_HOST");
      if (typeof configuredApiHost === "string" && configuredApiHost.trim()) {
        try {
          const candidate = new URL(configuredApiHost.includes("://")
            ? configuredApiHost : "https://" + configuredApiHost);
          const host = candidate.hostname.toLowerCase();
          if (candidate.protocol === "https:"
              && (host === "youtube.com" || host.endsWith(".youtube.com"))
              && !candidate.username && !candidate.password && !candidate.search && !candidate.hash) {
            youtubeOrigin = candidate.origin;
          }
        } catch (_) {}
      }
      headers["X-Origin"] = youtubeOrigin;
      const sessionIndex = configValue("SESSION_INDEX");
      headers["X-Goog-AuthUser"] = (
        (typeof sessionIndex === "number" && Number.isInteger(sessionIndex) && sessionIndex >= 0)
        || (typeof sessionIndex === "string" && /^\d+$/.test(sessionIndex))
      ) ? String(sessionIndex) : "0";

      return {
        body: JSON.stringify(payload),
        headers,
        payloadKeys: Object.keys(payload).join(","),
        clientName: typeof client.clientName === "string" ? client.clientName.slice(0, 24) : "unknown",
        clientVersion: typeof client.clientVersion === "string" ? client.clientVersion.slice(0, 48) : "unknown"
      };
    } catch (error) {
      return {body: null, reason: "fallback_error=" + String(error && error.name || "unknown").slice(0, 40)};
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

  function readYouTubeField(object, key) {
    try {
      return object && object[key];
    } catch (_) {
      return undefined;
    }
  }

  function youtubeNavigationFromUrl(value) {
    if (typeof value !== "string" || !value || value.length > 4096) return null;
    try {
      const targetUrl = new URL(value, document.baseURI);
      const upstreamHost = new URL(upstreamOrigin).hostname.toLowerCase();
      const upstreamIsYouTube = upstreamHost === "youtube.com" || upstreamHost.endsWith(".youtube.com");
      const targetHost = targetUrl.hostname.toLowerCase();
      const isYouTubeHost = targetHost === "youtube.com" || targetHost.endsWith(".youtube.com");
      const isSessionOrigin = targetUrl.origin === location.origin;
      if (!upstreamIsYouTube || (!isYouTubeHost && !isSessionOrigin)) return null;

      let videoId = targetUrl.searchParams.get("v");
      let source = "anchor_href";
      if (!videoId) {
        const targetMatch = targetUrl.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
        videoId = targetMatch && targetMatch[1];
      }
      if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

      const playlistIndex = targetUrl.searchParams.get("index");
      return {
        videoId,
        source,
        playlistId: targetUrl.searchParams.get("list") || null,
        playlistIndex: playlistIndex && /^\d+$/.test(playlistIndex) ? Number(playlistIndex) : null,
        params: targetUrl.searchParams.get("params") || null
      };
    } catch (_) {
      return null;
    }
  }

  function youtubeNavigationFromObject(root, initialSource) {
    const queue = [{value: root, source: initialSource, depth: 0}];
    const visited = new Set();
    const nestedKeys = [
      "watchEndpoint", "reelWatchEndpoint", "navigationEndpoint", "command",
      "data", "content", "renderer", "videoRenderer", "richItemRenderer",
      "compactVideoRenderer", "gridVideoRenderer", "playlistVideoRenderer",
      "commandMetadata", "webCommandMetadata", "innertubeCommand", "onTap"
    ];
    let inspected = 0;

    while (queue.length && inspected < 48) {
      const current = queue.shift();
      const object = current && current.value;
      if (!object || typeof object !== "object" || visited.has(object)) continue;
      visited.add(object);
      inspected++;

      const videoId = readYouTubeField(object, "videoId");
      if (typeof videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        const playlistIndex = readYouTubeField(object, "playlistIndex");
        const rawIndex = typeof playlistIndex === "number"
          ? String(playlistIndex) : playlistIndex;
        return {
          videoId,
          source: current.source,
          playlistId: typeof readYouTubeField(object, "playlistId") === "string"
            ? readYouTubeField(object, "playlistId") : null,
          playlistIndex: (typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0)
            ? rawIndex
            : (typeof rawIndex === "string" && /^\d+$/.test(rawIndex) ? Number(rawIndex) : null),
          params: typeof readYouTubeField(object, "params") === "string"
            ? readYouTubeField(object, "params") : null
        };
      }

      const metadata = readYouTubeField(object, "webCommandMetadata");
      const metadataUrl = readYouTubeField(metadata, "url");
      const directUrlCandidate = youtubeNavigationFromUrl(readYouTubeField(object, "url"));
      const urlCandidate = directUrlCandidate || youtubeNavigationFromUrl(metadataUrl);
      if (urlCandidate) {
        urlCandidate.source = "command_metadata_url";
        return urlCandidate;
      }

      if (current.depth >= 4) continue;
      for (const key of nestedKeys) {
        const child = readYouTubeField(object, key);
        if (!child || typeof child !== "object") continue;
        let childSource = current.source;
        if (key === "watchEndpoint") childSource = "watch_endpoint";
        else if (key === "reelWatchEndpoint") childSource = "reel_watch_endpoint";
        else if (key === "navigationEndpoint" || key === "command") childSource = "endpoint_data";
        queue.push({value: child, source: childSource, depth: current.depth + 1});
      }
    }
    return null;
  }

  function pathLooksLikeYouTubeVideoSurface(event) {
    let path = [];
    try {
      path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    } catch (_) {
      path = [event.target];
    }
    return path.some(node => {
      if (!(node instanceof Element)) return false;
      const tag = String(node.localName || "").toLowerCase();
      return tag === "ytd-video-renderer"
        || tag === "ytd-compact-video-renderer"
        || tag === "ytd-rich-item-renderer"
        || tag === "ytd-grid-video-renderer"
        || tag === "ytd-playlist-video-renderer"
        || tag === "ytd-thumbnail"
        || tag === "yt-lockup-view-model"
        || tag === "ytm-compact-video-renderer";
    });
  }

  function captureYouTubeNavigation(event, eventType) {
    let path = [];
    try {
      path = typeof event.composedPath === "function"
        ? event.composedPath()
        : [event.target];
    } catch (_) {
      path = [event.target];
    }
    const elements = path.filter(node => node instanceof Element);
    const seenAnchors = new Set();

    // Prefer the actual link from the composed path, rather than the retargeted
    // event.target. This reaches anchors inside YouTube's open shadow roots.
    for (const element of elements) {
      let anchor = null;
      try {
        if (element.matches("a[href],area[href]")) anchor = element;
        else if (element === event.target) anchor = element.closest("a[href],area[href]");
      } catch (_) {}
      if (!anchor || seenAnchors.has(anchor)) continue;
      seenAnchors.add(anchor);
      const candidate = youtubeNavigationFromUrl(anchor.href || anchor.getAttribute("href"));
      if (candidate) {
        candidate.element = anchor;
        candidate.eventType = eventType;
        candidate.composedPathLength = elements.length;
        return candidate;
      }
    }

    // YouTube cards often expose navigationEndpoint through Polymer's data
    // model even when no anchor is present in the composed path.
    for (const element of elements) {
      const attributeId = (() => {
        try {
          return element.getAttribute("video-id")
            || element.getAttribute("data-video-id");
        } catch (_) {
          return null;
        }
      })();
      if (typeof attributeId === "string" && /^[A-Za-z0-9_-]{11}$/.test(attributeId)) {
        return {
          videoId: attributeId,
          source: "element_video_id_attribute",
          playlistId: null,
          playlistIndex: null,
          params: null,
          element,
          eventType,
          composedPathLength: elements.length
        };
      }

      const propertyId = readYouTubeField(element, "videoId");
      if (typeof propertyId === "string" && /^[A-Za-z0-9_-]{11}$/.test(propertyId)) {
        return {
          videoId: propertyId,
          source: "element_video_id_property",
          playlistId: null,
          playlistIndex: null,
          params: null,
          element,
          eventType,
          composedPathLength: elements.length
        };
      }

      const data = readYouTubeField(element, "data");
      const dataCandidate = youtubeNavigationFromObject(data, "endpoint_data");
      if (dataCandidate) {
        dataCandidate.element = element;
        dataCandidate.eventType = eventType;
        dataCandidate.composedPathLength = elements.length;
        return dataCandidate;
      }

      const polymerData = readYouTubeField(element, "__data");
      const polymerCandidate = youtubeNavigationFromObject(polymerData, "polymer_endpoint_data");
      if (polymerCandidate) {
        polymerCandidate.element = element;
        polymerCandidate.eventType = eventType;
        polymerCandidate.composedPathLength = elements.length;
        return polymerCandidate;
      }
    }
    return null;
  }

  for (const type of ["pointerdown", "click", "change", "input", "keydown"]) {
    nativeAdd.call(document, type, event => {
      if ((type === "pointerdown" || type === "click") && event.target instanceof Element) {
        captureYouTubeFeedbackToken(event);
        const candidate = captureYouTubeNavigation(event, type);
        if (candidate) {
          recentYouTubeVideoNavigation = {
            videoId: candidate.videoId,
            playlistId: candidate.playlistId || null,
            playlistIndex: candidate.playlistIndex,
            params: candidate.params || null,
            source: candidate.source,
            at: performance.now()
          };
          record(
            "youtube_navigation_candidate_captured",
            selectorFor(candidate.element || event.target),
            "source=" + candidate.source
              + " · event=" + type
              + " · composed_path_nodes=" + candidate.composedPathLength
          );
        } else if (type === "click") {
          const videoSurface = pathLooksLikeYouTubeVideoSurface(event);
          if (videoSurface) {
            record(
              "youtube_navigation_candidate_missed",
              selectorFor(event.target),
              "source=none · event=click"
            );
          }
        }
      }
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
    const attestationInfo = youtubeAttestationRpcInfo(source);
    record("fetch", attestationInfo ? attestationInfo.target : String(source), method);
    if (!routed) return Promise.reject(new TypeError("Intercept only proxies HTTP and HTTPS requests."));
    try {
      // Mark the request explicitly instead of relying on browser-specific
      // Fetch Metadata support. Preserve Request/init overrides and bodies.
      let bodyDetail = fetchBodyDiagnostic(input, init);
      const originalBodyDetail = bodyDetail;
      const isYouTubeSabrPost = method === "POST" && youtubeSabrEndpointCheck(source);
      let recoveredSabrBody = null;
      if (isYouTubeSabrPost
          && input instanceof Request
          && input.body === undefined
          && bodyDetail === "body_arg=none"
          && !(init && Object.prototype.hasOwnProperty.call(init, "body")
            && init.body !== undefined)) {
        // Firefox can expose Request.body as undefined even when its internal
        // request body is readable. Limit recovery to SABR POSTs: applying this
        // workaround to unrelated application fetches caused regressions.
        // Read a clone so the page-owned Request remains untouched. If cloning
        // fails, preserve the pre-existing Fetch behavior rather than rejecting
        // an unrelated part of the page.
        try {
          const bodyBuffer = await input.clone().arrayBuffer();
          if (bodyBuffer.byteLength > 0) {
            recoveredSabrBody = bodyBuffer;
            bodyDetail = "body_arg=request_recovered body_arg_bytes=" + bodyBuffer.byteLength;
            record(
              "youtube_sabr_request_body_recovered",
              "/videoplayback",
              "body_bytes=" + bodyBuffer.byteLength + " source=Request.clone"
            );
          }
        } catch (error) {
          const errorName = String(error && error.name || "unknown")
            .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
          record(
            "youtube_sabr_request_body_recovery_failed",
            "/videoplayback",
            "error_name=" + errorName + " fallback=original_request_path"
          );
        }
      }

      let routedRequest;
      if (input instanceof Request) {
        routedRequest = new Request(routed, input);
        if (init) routedRequest = new Request(routedRequest, init);
        if (recoveredSabrBody !== null) {
          routedRequest = new Request(routedRequest, {body: recoveredSabrBody});
        }
      } else {
        routedRequest = new Request(routed, init);
      }
      if (routedRequest.method === "POST"
          && originalBodyDetail === "body_arg=none"
          && youtubeSabrEndpointCheck(source)) {
        const requestInput = input instanceof Request;
        const initPresent = init !== undefined && init !== null;
        const initBodyPresent = Boolean(initPresent
          && Object.prototype.hasOwnProperty.call(init, "body")
          && init.body !== undefined);
        const inputBodyNull = requestInput ? input.body === null : null;
        const inputBodyUsed = requestInput ? input.bodyUsed : null;
        record(
          "youtube_sabr_fetch_callsite",
          "/videoplayback",
          "method=POST"
            + " input=" + (requestInput ? "Request" : input instanceof URL ? "URL" : typeof input)
            + " init_present=" + initPresent
            + " init_body_present=" + initBodyPresent
            + " body_diag=" + originalBodyDetail
            + " recovered_body_bytes=" + (recoveredSabrBody ? recoveredSabrBody.byteLength : 0)
            + " input_body_null=" + (inputBodyNull === null ? "n/a" : inputBodyNull)
            + " input_body_used=" + (inputBodyUsed === null ? "n/a" : inputBodyUsed)
            + " routed_body_null=" + (routedRequest.body === null)
            + " callsite=" + sanitizedYouTubeFetchCallsite()
        );
        if (requestInput && !youtubeSabrRequestBodyMeasurementStarted) {
          // Read cloned copies in parallel with the original Fetch path. The
          // original Request and the routed Request passed to nativeFetch are
          // never consumed by this measurement.
          youtubeSabrRequestBodyMeasurementStarted = true;
          recordYouTubeSabrRequestBodyMeasurement(input, routedRequest);
        }
      }
      let youtubeSearchFallbackHeaders = null;
      const youtubeSearchCheck = youtubeSearchEndpointCheck(source);
      const youtubePlayerCheck = youtubePlayerEndpointCheck(source);
      let youtubePlayerFallbackHeaders = null;
      let youtubePlayerFallbackUnavailable = null;
      const youtubeGetWatchCheck = youtubeGetWatchEndpointCheck(source);
      let youtubeGetWatchFallbackHeaders = null;
      const youtubeNextCheck = youtubeNextEndpointCheck(source);
      let youtubeNextFallbackHeaders = null;
      const youtubeFeedbackCheck = youtubeFeedbackEndpointCheck(source);
      let youtubeFeedbackFallbackHeaders = null;
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

      if (routedRequest.method === "POST"
          && bodyDetail === "body_arg=none"
          && youtubePlayerCheck.endpointMatch) {
        const fallback = await buildYouTubePlayerFallbackBody();
        if (fallback.body) {
          const replacementRequest = new Request(routedRequest, {body: fallback.body});
          const replacementHeaders = new Headers(replacementRequest.headers);
          const inheritedContentEncoding = replacementHeaders.has("content-encoding");
          replacementHeaders.delete("content-encoding");
          replacementHeaders.delete("content-length");
          replacementHeaders.set("content-type", "application/json");
          routedRequest = new Request(replacementRequest, {headers: replacementHeaders});
          youtubePlayerFallbackHeaders = fallback.headers || {};
          bodyDetail = "body_arg=generated_innertube_player body_arg_bytes="
            + new TextEncoder().encode(fallback.body).byteLength;
          record("youtube_player_body_generated", fetchEventPath(source),
            "Generated InnerTube player JSON · video_id_source=" + fallback.videoIdSource
              + " · payload_keys=" + fallback.payloadKeys
              + " · playback_context=" + (fallback.playbackContextPresent ? "present" : "absent")
              + " · body_bytes=" + new TextEncoder().encode(fallback.body).byteLength);
          record("youtube_player_payload_shape", fetchEventPath(source),
            "keys=" + fallback.payloadKeys + " · client=" + fallback.clientName
              + " · version=" + fallback.clientVersion + " · video_id_present=true");
          record("youtube_player_fallback_encoding", fetchEventPath(source),
            "body_encoding=identity · content_type=application/json"
              + " · inherited_content_encoding=" + (inheritedContentEncoding ? "removed" : "absent"));
        } else {
          youtubePlayerFallbackUnavailable = fallback.reason || "fallback_unavailable";
          record("youtube_player_body_unavailable", fetchEventPath(source), youtubePlayerFallbackUnavailable);
        }
      }
      // Never send a bodyless InnerTube player POST upstream. In particular,
      // the original request may still carry Content-Encoding: gzip even
      // though Fetch supplied no compressed bytes. Return a local failure and
      // let diagnostics explain why playback could not be initialized.
      if (youtubePlayerFallbackUnavailable) {
        record("youtube_player_request_blocked", fetchEventPath(source),
          "reason=" + youtubePlayerFallbackUnavailable + " · upstream_dispatch=false");
        return new Response(null, {
          status: 503,
          statusText: "Player request unavailable"
        });
      }
      if (routedRequest.method === "POST"
          && bodyDetail === "body_arg=none"
          && youtubeGetWatchCheck.endpointMatch) {
        const fallback = await buildYouTubeGetWatchFallbackBody();
        if (fallback.body) {
          const replacementRequest = new Request(routedRequest, {body: fallback.body});
          const replacementHeaders = new Headers(replacementRequest.headers);
          const inheritedContentEncoding = replacementHeaders.has("content-encoding");
          replacementHeaders.delete("content-encoding");
          replacementHeaders.delete("content-length");
          replacementHeaders.set("content-type", "application/json");
          routedRequest = new Request(replacementRequest, {headers: replacementHeaders});
          youtubeGetWatchFallbackHeaders = fallback.headers || {};
          bodyDetail = "body_arg=generated_innertube_get_watch body_arg_bytes="
            + new TextEncoder().encode(fallback.body).byteLength;
          record("youtube_get_watch_body_generated", fetchEventPath(source),
            "Generated compound InnerTube get_watch JSON · video_id_source=" + fallback.videoIdSource
              + " · payload_keys=" + fallback.payloadKeys
              + " · player_request_keys=" + fallback.playerRequestKeys
              + " · watch_next_request_keys=" + fallback.watchNextRequestKeys
              + " · playback_context=" + (fallback.playbackContextPresent ? "present" : "absent")
              + " · body_bytes=" + new TextEncoder().encode(fallback.body).byteLength);
          record("youtube_get_watch_payload_shape", fetchEventPath(source),
            "keys=" + fallback.payloadKeys + " · client=" + fallback.clientName
              + " · version=" + fallback.clientVersion
              + " · video_id_present=true · player_request=true · watch_next_request=true");
          record("youtube_get_watch_fallback_encoding", fetchEventPath(source),
            "body_encoding=identity · content_type=application/json"
              + " · inherited_content_encoding=" + (inheritedContentEncoding ? "removed" : "absent"));
        } else {
          record("youtube_get_watch_body_unavailable", fetchEventPath(source), fallback.reason);
        }
      }
      if (routedRequest.method === "POST"
          && bodyDetail === "body_arg=none"
          && youtubeNextCheck.endpointMatch) {
        const fallback = await buildYouTubeNextFallbackBody();
        if (fallback.body) {
          const replacementRequest = new Request(routedRequest, {body: fallback.body});
          const replacementHeaders = new Headers(replacementRequest.headers);
          const inheritedContentEncoding = replacementHeaders.has("content-encoding");
          replacementHeaders.delete("content-encoding");
          replacementHeaders.delete("content-length");
          replacementHeaders.set("content-type", "application/json");
          routedRequest = new Request(replacementRequest, {headers: replacementHeaders});
          youtubeNextFallbackHeaders = fallback.headers || {};
          bodyDetail = "body_arg=generated_innertube_next body_arg_bytes="
            + new TextEncoder().encode(fallback.body).byteLength;
          record("youtube_next_body_generated", fetchEventPath(source),
            "Generated InnerTube next JSON · video_id_source=" + fallback.videoIdSource
              + " · payload_keys=" + fallback.payloadKeys
              + " · body_bytes=" + new TextEncoder().encode(fallback.body).byteLength);
          record("youtube_next_payload_shape", fetchEventPath(source),
            "keys=" + fallback.payloadKeys + " · client=" + fallback.clientName
              + " · version=" + fallback.clientVersion + " · video_id_present=true");
          record("youtube_next_fallback_encoding", fetchEventPath(source),
            "body_encoding=identity · content_type=application/json"
              + " · inherited_content_encoding=" + (inheritedContentEncoding ? "removed" : "absent"));
        } else {
          record("youtube_next_body_unavailable", fetchEventPath(source), fallback.reason);
        }
      }
      if (routedRequest.method === "POST"
          && bodyDetail === "body_arg=none"
          && youtubeFeedbackCheck.endpointMatch) {
        const fallback = await buildYouTubeFeedbackFallbackBody();
        if (fallback.body) {
          const replacementRequest = new Request(routedRequest, {body: fallback.body});
          const replacementHeaders = new Headers(replacementRequest.headers);
          const inheritedContentEncoding = replacementHeaders.has("content-encoding");
          replacementHeaders.delete("content-encoding");
          replacementHeaders.delete("content-length");
          replacementHeaders.set("content-type", "application/json");
          routedRequest = new Request(replacementRequest, {headers: replacementHeaders});
          youtubeFeedbackFallbackHeaders = fallback.headers || {};
          bodyDetail = "body_arg=generated_innertube_feedback body_arg_bytes="
            + new TextEncoder().encode(fallback.body).byteLength;
          record("youtube_feedback_body_generated", fetchEventPath(source),
            "Generated InnerTube feedback JSON from clicked token · payload_keys=" + fallback.payloadKeys
              + " · body_bytes=" + new TextEncoder().encode(fallback.body).byteLength);
          record("youtube_feedback_payload_shape", fetchEventPath(source),
            "keys=" + fallback.payloadKeys + " · client=" + fallback.clientName
              + " · version=" + fallback.clientVersion + " · feedback_token_present=true");
          record("youtube_feedback_fallback_encoding", fetchEventPath(source),
            "body_encoding=identity · content_type=application/json"
              + " · inherited_content_encoding=" + (inheritedContentEncoding ? "removed" : "absent"));
        } else {
          record("youtube_feedback_body_unavailable", fetchEventPath(source), fallback.reason);
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

      if (youtubePlayerFallbackHeaders) {
        const added = [];
        for (const [name, value] of Object.entries(youtubePlayerFallbackHeaders)) {
          if (!headers.has(name)) {
            headers.set(name, value);
            added.push(name.toLowerCase());
          }
        }
        if (added.length) {
          record("youtube_player_headers_synthesized", fetchEventPath(source),
            "Added missing InnerTube headers: " + added.join(", "));
        }
      }
      if (youtubeGetWatchFallbackHeaders) {
        const added = [];
        for (const [name, value] of Object.entries(youtubeGetWatchFallbackHeaders)) {
          if (!headers.has(name)) {
            headers.set(name, value);
            added.push(name.toLowerCase());
          }
        }
        if (added.length) {
          record("youtube_get_watch_headers_synthesized", fetchEventPath(source),
            "Added missing InnerTube headers: " + added.join(", "));
        }
      }
      if (youtubeNextFallbackHeaders) {
        const added = [];
        for (const [name, value] of Object.entries(youtubeNextFallbackHeaders)) {
          if (!headers.has(name)) {
            headers.set(name, value);
            added.push(name.toLowerCase());
          }
        }
        if (added.length) {
          record("youtube_next_headers_synthesized", fetchEventPath(source),
            "Added missing InnerTube headers: " + added.join(", "));
        }
      }
      if (youtubeFeedbackFallbackHeaders) {
        const added = [];
        for (const [name, value] of Object.entries(youtubeFeedbackFallbackHeaders)) {
          if (!headers.has(name)) {
            headers.set(name, value);
            added.push(name.toLowerCase());
          }
        }
        if (added.length) {
          record("youtube_feedback_headers_synthesized", fetchEventPath(source),
            "Added missing InnerTube headers: " + added.join(", "));
        }
      }
      headers.set("X-Intercept-Proxy-Mode", "ajax");
      headers.set("X-Intercept-Body-Diagnostic", bodyDetail);
      headers.set("X-Intercept-Transport-Diagnostic", "window-fetch");
      headers.set("X-Intercept-Playback-Context-Id", playbackContextId);
      const inputContext = addInputCorrelation(headers);
      const attestationCall = attestationInfo
        ? beginYouTubeAttestationRpc(attestationInfo, routedRequest.method, "fetch")
        : null;
      if (attestationCall) headers.set("X-Intercept-Attestation-Id", attestationCall.id);
      const markedRequest = new Request(routedRequest, {headers});
      record(
        "ajax_dispatch",
        attestationInfo ? attestationInfo.target : routed,
        method + " · " + bodyDetail + inputCorrelationDetail(inputContext)
      );
      const fetchEventTarget = fetchEventPath(source);
      return cookieWriteQueue.then(() => {
        // ajax_dispatch is recorded before cookie synchronization finishes.
        // This marker proves the request has reached the actual native Fetch call.

        if (fetchEventTarget === "/youtubei/v1/player") {
          record("youtube_player_fetch_started", fetchEventTarget,
            method + " · " + bodyDetail);
        }
        if (fetchEventTarget === "/youtubei/v1/get_watch") {
          record("youtube_get_watch_fetch_started", fetchEventTarget,
            method + " · " + bodyDetail);
        }
        if (fetchEventTarget === "/youtubei/v1/next") {
          record("youtube_next_fetch_started", fetchEventTarget,
            method + " · " + bodyDetail);
        }
        if (fetchEventTarget === "/youtubei/v1/feedback") {
          record("youtube_feedback_fetch_started", fetchEventTarget,
            method + " · " + bodyDetail);
        }
        if (fetchEventTarget === "/youtubei/v1/search") {
          record(
            "fetch_started",
            fetchEventTarget,
            method + " · " + bodyDetail
          );
        }
        recordYouTubeAttestationRpcDispatch(attestationCall);
        return nativeFetch(markedRequest);
      }).then(response => {
        recordYouTubeAttestationRpcResponse(attestationCall, response.status, response.headers);
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
        recordYouTubeAttestationRpcFailure(attestationCall, error);
        // Do not log the error message: browser errors may contain full URLs
        // or other request-specific values. The error class is sufficient to
        // distinguish a rejected Fetch from an HTTP response.
        const errorName = String(error && error.name || "unknown").slice(0, 40);
        record("fetch_error", fetchEventTarget, "error_name=" + errorName);
        throw error;
      });
    } catch (error) {
      record(
        "ajax_route_error",
        attestationInfo ? attestationInfo.target : String(source),
        attestationInfo
          ? "error_name=" + String(error && error.name || "unknown").slice(0, 40)
          : String(error && error.message || error)
      );
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
    const attestation = youtubeAttestationRpcInfo(url);
    xhrMeta.set(this, {
      method: String(method).toUpperCase(),
      url: routed,
      eventTarget: attestation ? attestation.target : routed,
      async: rest[0] !== false,
      attestation
    });
    return nativeXhrOpen.call(this, method, routed, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const meta = xhrMeta.get(this);
    const attestationCall = meta && meta.attestation
      ? beginYouTubeAttestationRpc(meta.attestation, meta.method, "xhr")
      : null;
    if (meta) {
      nativeAdd.call(this, "readystatechange", () => {
        if (this.readyState === 2) {
          recordYouTubeAttestationRpcHeaders(attestationCall, this.status, this);
        }
      });
      nativeAdd.call(this, "load", () => {
        recordYouTubeAttestationRpcResponse(attestationCall, this.status, this);
      });
      nativeAdd.call(this, "error", () => {
        recordYouTubeAttestationRpcFailure(attestationCall, null, "error");
      });
      nativeAdd.call(this, "abort", () => {
        recordYouTubeAttestationRpcFailure(attestationCall, null, "abort");
      });
      nativeAdd.call(this, "timeout", () => {
        recordYouTubeAttestationRpcFailure(attestationCall, null, "timeout");
      });
      nativeAdd.call(this, "loadend", () => {
        try {
          if (this.getResponseHeader("X-Intercept-Cookie-Updated") === "1") refreshCookieMirror();
        } catch (_) {}
        // XHR always fires loadend after its terminal event. This fallback
        // records unusual implementations that omit load/error/abort/timeout.
        recordYouTubeAttestationRpcFailure(attestationCall, null, "loadend");
      });
      const inputContext = currentInputEvent();
      const bodyDetail = requestBodyDiagnostic(args[0], args.length > 0);
      try {
        // Add internal metadata last, after page code has configured headers.
        nativeXhrSetRequestHeader.call(this, "X-Intercept-Proxy-Mode", "ajax");
        nativeXhrSetRequestHeader.call(this, "X-Intercept-Body-Diagnostic", bodyDetail);
        nativeXhrSetRequestHeader.call(this, "X-Intercept-Transport-Diagnostic", "window-xhr");
        nativeXhrSetRequestHeader.call(this, "X-Intercept-Playback-Context-Id", playbackContextId);
        if (attestationCall) {
          nativeXhrSetRequestHeader.call(this, "X-Intercept-Attestation-Id", attestationCall.id);
        }
        if (inputContext) {
          nativeXhrSetRequestHeader.call(this, "X-Intercept-Input-Id", inputContext.id);
          nativeXhrSetRequestHeader.call(
            this,
            "X-Intercept-Input-Target",
            encodeURIComponent(inputContext.target).slice(0, 360)
          );
        }
      } catch (error) {
        record(
          "xhr_marker_error",
          meta.eventTarget || meta.url,
          meta.attestation
            ? "error_name=" + String(error && error.name || "unknown").slice(0, 40)
            : String(error && error.message || error)
        );
      }
      record("xhr", meta.eventTarget || meta.url, meta.method + inputCorrelationDetail(inputContext));
      record(
        "ajax_dispatch",
        meta.eventTarget || meta.url,
        meta.method + " · " + bodyDetail + inputCorrelationDetail(inputContext)
      );
    }
    const dispatchXhr = () => {
      recordYouTubeAttestationRpcDispatch(attestationCall);
      try {
        return nativeXhrSend.apply(this, args);
      } catch (error) {
        recordYouTubeAttestationRpcFailure(attestationCall, error);
        throw error;
      }
    };
    if (meta && meta.async && cookieWriteQueue) {
      cookieWriteQueue.then(dispatchXhr, error => {
        recordYouTubeAttestationRpcFailure(attestationCall, error);
      });
      return;
    }
    return dispatchXhr();
  };

  if (navigator.sendBeacon) {
    const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      const routed = routeToProxy(url);
      if (!routed) {
        record("beacon_blocked", String(url), "URL could not be routed");
        return false;
      }
      const isYouTubeQoe = isYouTubeQoeEndpoint(url);
      const eventTarget = isYouTubeQoe ? "/api/stats/qoe" : routed;
      const bodyDetail = requestBodyDiagnostic(data, arguments.length > 1);
      if (isYouTubeQoe) {
        // sendBeacon cannot expose the upstream response or accept arbitrary
        // headers. Record only the supplied BodyInit type and byte count here;
        // Rust records the actual request headers received by the proxy.
        record("youtube_qoe_beacon_dispatch", eventTarget,
          bodyDetail + " · transport=sendBeacon · body_content=not_logged");
      }
      record(
        "ajax_dispatch",
        eventTarget,
        "POST · " + bodyDetail + " · transport=sendBeacon"
      );
      const accepted = nativeSendBeacon(routed, data);
      if (isYouTubeQoe) {
        record("youtube_qoe_beacon_queued", eventTarget,
          "browser_accepted=" + accepted + " · upstream_status=not_exposed_by_sendBeacon");
      }
      return accepted;
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

  // Blob-backed workers bypass rewrite_worker_javascript because their source
  // never crosses the proxy as a worker-script response. For JavaScript Blobs
  // created by YouTube pages, prepend a guarded worker-only bootstrap that
  // routes fetch/XHR/importScripts through this session. In window/script
  // contexts the bootstrap exits without changing browser behavior.
  function youtubeBlobWorkerBootstrap() {
    const prefixLiteral = JSON.stringify(sessionPrefix);
    const primaryOriginLiteral = JSON.stringify(upstreamOrigin);
    return "(function(){try{"
      + "if(typeof WorkerGlobalScope==='undefined'||!(self instanceof WorkerGlobalScope))return;"
      + "const prefix=" + prefixLiteral + ",primaryOrigin=" + primaryOriginLiteral + ";"
      + "const rawFetch=typeof self.fetch==='function'?self.fetch.bind(self):null;"
      + "let playbackContextId='';"
      + "function acceptPlaybackContext(event){const value=event&&event.data;if(!value||value.__interceptPlaybackContext!==true||typeof value.id!=='string'||!/^[a-z0-9-]{1,64}$/.test(value.id))return;playbackContextId=value.id;try{event.stopImmediatePropagation();}catch(_e){}}"
      + "self.addEventListener('message',acceptPlaybackContext,true);"
      + "let attestationSequence=0;function nextAttestationId(){attestationSequence=(attestationSequence%999999)+1;return Date.now().toString(36)+'-'+attestationSequence+'-'+Math.random().toString(36).slice(2,8);}"
      + "function route(value){"
      + "const raw=value instanceof Request?value.url:value instanceof URL?value.href:String(value);"
      + "const url=new URL(raw,self.location.origin+'/');"
      + "if(url.protocol!=='http:'&&url.protocol!=='https:')return url.href;"
      + "if(url.origin===self.location.origin)return url.href;"
      + "const path=url.pathname+url.search+url.hash;"
      + "if(url.origin===primaryOrigin)return new URL(path,self.location.origin+'/').href;"
      + "return self.location.origin+prefix+'/_/'+url.protocol.slice(0,-1)+'/'+url.host+path;"
      + "}"
      + "function attestationInfo(value){try{"
      + "const url=new URL(value instanceof Request?value.url:value instanceof URL?value.href:String(value),self.location.origin+'/');"
      + "let host=url.hostname.toLowerCase(),path=url.pathname;"
      + "if(url.origin===self.location.origin){const marker=prefix+'/_/https/';const at=path.indexOf(marker);"
      + "if(at>=0){const target=path.slice(at+marker.length),slash=target.indexOf('/');if(slash>0){host=target.slice(0,slash).toLowerCase();path=target.slice(slash);}}"
      + "else if(path===prefix||path.startsWith(prefix+'/')){host=new URL(primaryOrigin).hostname.toLowerCase();path=path.slice(prefix.length)||'/';}}"
      + "const lower=path.toLowerCase(),youtube=host==='youtube.com'||host.endsWith('.youtube.com');"
      + "const google=host==='jnn-pa.googleapis.com'||(host.endsWith('.googleapis.com')&&lower.includes('waa'));"
      + "const jnn=youtube&&lower.startsWith('/api/jnn/v1/'),attGet=youtube&&lower==='/youtubei/v1/att/get';"
      + "const attLog=youtube&&lower==='/youtubei/v1/att/log',attResource=attGet||attLog;"
      + "if(!google&&!jnn&&!attResource)return null;"
      + "const match=path.match(/^\\/\\$rpc\\/google\\.internal\\.waa\\.v1\\.Waa\\/(Create|GenerateIT)$/)||path.match(/^\\/api\\/jnn\\/v1\\/(Create|GenerateIT)$/);"
      + "return {target:host+path,operation:attGet?'AttGet':attLog?'AttLog':match?match[1]:'Other',kind:attResource?'youtube_attestation_resource':'youtube_attestation_rpc'};"
      + "}catch(_e){return null}}"
      + "function report(info,detail){if(!info||!rawFetch)return;try{"
      + "rawFetch(new URL('/_intercept/events',self.location.origin).href,{method:'POST',"
      + "headers:{'content-type':'application/json'},body:JSON.stringify([{kind:info.kind||'youtube_attestation_rpc',"
      + "target:info.target,detail:String(detail||'').slice(0,300)}]),keepalive:true}).catch(()=>{});"
      + "}catch(_e){}}"
      + "if(rawFetch){self.fetch=function(input,init){"
      + "const source=input instanceof Request?input.url:input;"
      + "const routed=route(source),info=attestationInfo(source),attestationId=info?nextAttestationId():null;"
      + "let request=input instanceof Request?new Request(routed,input):new Request(routed,init);"
      + "if(input instanceof Request&&init)request=new Request(request,init);"
      + "const headers=new Headers(request.headers);headers.set('X-Intercept-Proxy-Mode','ajax');"
      + "headers.set('X-Intercept-Transport-Diagnostic','worker-fetch');"
      + "if(attestationId){headers.set('X-Intercept-Attestation-Id',attestationId);if(playbackContextId)headers.set('X-Intercept-Playback-Context-Id',playbackContextId);}"
      + "const marked=new Request(request,{headers});"
      + "if(info)report(info,'rpc='+attestationId+' phase=blob_worker_dispatch operation='+info.operation+' method='+marked.method+' transport=worker-fetch');"
      + "return rawFetch(marked).then(response=>{if(info)report(info,'rpc='+attestationId+' phase=blob_worker_response operation='+info.operation+' status='+response.status);return response;});"
      + "};}"
      + "if(self.XMLHttpRequest){const X=self.XMLHttpRequest,open=X.prototype.open,send=X.prototype.send,meta=new WeakMap();"
      + "X.prototype.open=function(method,url,...rest){const info=attestationInfo(url),routed=route(url);"
      + "meta.set(this,{info,method:String(method).toUpperCase()});return open.call(this,method,routed,...rest);};"
      + "X.prototype.send=function(...args){const call=meta.get(this);if(!call)return send.apply(this,args);"
      + "const attestationId=call.info?nextAttestationId():null;"
      + "try{this.setRequestHeader('X-Intercept-Proxy-Mode','ajax');"
      + "this.setRequestHeader('X-Intercept-Transport-Diagnostic','worker-xhr');"
      + "if(attestationId){this.setRequestHeader('X-Intercept-Attestation-Id',attestationId);if(playbackContextId)this.setRequestHeader('X-Intercept-Playback-Context-Id',playbackContextId);}}catch(_e){}"
      + "if(call.info)report(call.info,'rpc='+attestationId+' phase=blob_worker_dispatch operation='+call.info.operation+' method='+call.method+' transport=worker-xhr');"
      + "this.addEventListener('load',()=>{if(call.info)report(call.info,'rpc='+attestationId+' phase=blob_worker_response operation='+call.info.operation+' status='+this.status);},{once:true});"
      + "this.addEventListener('error',()=>{if(call.info)report(call.info,'rpc='+attestationId+' phase=blob_worker_error operation='+call.info.operation+' error=network');},{once:true});"
      + "return send.apply(this,args);};}"
      + "if(typeof self.importScripts==='function'){const nativeImport=self.importScripts.bind(self);self.importScripts=function(...urls){"
      + "return nativeImport(...urls.map(route));};}"
      + "}catch(_e){}})();\n";
  }

  (function instrumentYouTubeJavascriptBlobs() {
    let primaryHost = "";
    try { primaryHost = new URL(upstreamOrigin).hostname.toLowerCase(); } catch (_) {}
    if (primaryHost !== "youtube.com" && !primaryHost.endsWith(".youtube.com")) return;
    if (typeof window.Blob !== "function") return;
    const NativeBlob = window.Blob;
    const blobWorkerBootstrap = youtubeBlobWorkerBootstrap();
    const javascriptMimeTypes = new Set([
      "text/javascript", "application/javascript", "application/x-javascript",
      "text/ecmascript", "application/ecmascript"
    ]);
    try {
      window.Blob = new Proxy(NativeBlob, {
        construct(target, args, newTarget) {
          const options = args[1] || {};
          const mime = String(options.type || "").split(";", 1)[0].trim().toLowerCase();
          if (!javascriptMimeTypes.has(mime)) {
            return Reflect.construct(target, args, newTarget);
          }
          let parts;
          try { parts = Array.from(args[0] || []); } catch (_) {
            return Reflect.construct(target, args, newTarget);
          }
          record("youtube_player_worker", "blob:worker",
            "phase=javascript_blob_created parts=" + parts.length + " bootstrap=worker_only");
          return Reflect.construct(target, [[blobWorkerBootstrap, ...parts], options], newTarget);
        }
      });
    } catch (_) {
      record("youtube_player_worker", "blob:worker", "phase=blob_constructor_patch_failed");
    }
  })();

  function youtubeWorkerResourceInfo(source) {
    let primaryHost = "";
    try { primaryHost = new URL(upstreamOrigin).hostname.toLowerCase(); } catch (_) {}
    if (primaryHost !== "youtube.com" && !primaryHost.endsWith(".youtube.com")) return null;
    try {
      const raw = source instanceof URL ? source.href : String(source || "");
      const parsed = new URL(raw, document.baseURI);
      if (parsed.protocol === "blob:") {
        return {target: "blob:worker", candidate: "blob_worker"};
      }
      if (parsed.protocol === "data:") {
        return {target: "data:worker", candidate: "data_worker"};
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {target: "worker", candidate: "non_http_worker"};
      }

      let hostname = parsed.hostname.toLowerCase();
      let pathname = parsed.pathname;
      if (parsed.origin === location.origin) {
        const routeMarker = sessionPrefix + "/_/https/";
        const routeIndex = pathname.indexOf(routeMarker);
        if (routeIndex >= 0) {
          const target = pathname.slice(routeIndex + routeMarker.length);
          const slash = target.indexOf("/");
          if (slash > 0) {
            hostname = target.slice(0, slash).toLowerCase();
            pathname = target.slice(slash);
          }
        } else if (pathname === sessionPrefix || pathname.startsWith(sessionPrefix + "/")) {
          hostname = new URL(upstreamOrigin).hostname.toLowerCase();
          pathname = pathname.slice(sessionPrefix.length) || "/";
        }
      }
      const asset = youtubeAttestationAssetInfo(raw);
      return {
        target: hostname + pathname,
        candidate: asset ? asset.candidate : "worker_script"
      };
    } catch (_) {
      return {target: "worker", candidate: "unresolved_worker"};
    }
  }

  function workerMessageType(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value !== "object") return typeof value;
    if (value instanceof ArrayBuffer) return "array_buffer";
    if (ArrayBuffer.isView(value)) return "typed_array";
    if (Array.isArray(value)) return "array";
    return "object";
  }

  function observeYouTubeWorker(worker, info, transport) {
    if (!info) return;
    const target = info.target;
    record("youtube_player_worker", target,
      "phase=construct candidate=" + info.candidate + " transport=" + transport);
    try {
      worker.postMessage({__interceptPlaybackContext: true, id: playbackContextId});
      record("youtube_player_worker", target,
        "phase=playback_context_handoff sent=true scope=dedicated");
    } catch (_) {
      record("youtube_player_worker", target,
        "phase=playback_context_handoff sent=false scope=dedicated");
    }
    nativeAdd.call(worker, "error", event => {
      const errorName = String(event && event.error && event.error.name || "WorkerError")
        .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "WorkerError";
      record("youtube_player_worker", target,
        "phase=error error=" + errorName + " transport=" + transport);
    });
    nativeAdd.call(worker, "message", event => {
      record("youtube_player_worker", target,
        "phase=message message_type=" + workerMessageType(event && event.data)
          + " transport=" + transport);
    });
    nativeAdd.call(worker, "messageerror", () => {
      record("youtube_player_worker", target,
        "phase=message_error transport=" + transport);
    });
  }

  if (window.Worker) {
    const NativeWorker = window.Worker;
    window.Worker = function(url, options) {
      const routed = routeToProxy(url);
      if (!routed) throw new DOMException("Intercept only proxies HTTP and HTTPS worker scripts.", "SecurityError");
      const info = youtubeWorkerResourceInfo(url);
      const worker = new NativeWorker(routed, options);
      observeYouTubeWorker(worker, info, options && options.type === "module" ? "module" : "classic");
      return worker;
    };
    window.Worker.prototype = NativeWorker.prototype;
  }

  if (window.SharedWorker) {
    const NativeSharedWorker = window.SharedWorker;
    window.SharedWorker = function(url, options) {
      const routed = routeToProxy(url);
      if (!routed) throw new DOMException("Intercept only proxies HTTP and HTTPS shared-worker scripts.", "SecurityError");
      const info = youtubeWorkerResourceInfo(url);
      const worker = new NativeSharedWorker(routed, options);
      if (info) {
        const target = info.target;
        record("youtube_player_worker", target,
          "phase=construct candidate=" + info.candidate + " transport=shared");
        nativeAdd.call(worker.port, "message", event => {
          record("youtube_player_worker", target,
            "phase=message message_type=" + workerMessageType(event && event.data) + " transport=shared");
        });
        nativeAdd.call(worker.port, "messageerror", () => {
          record("youtube_player_worker", target, "phase=message_error transport=shared");
        });
      }
      return worker;
    };
    window.SharedWorker.prototype = NativeSharedWorker.prototype;
  }

  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    let primaryHost = "";
    try { primaryHost = new URL(upstreamOrigin).hostname.toLowerCase(); } catch (_) {}
    if (primaryHost === "youtube.com" || primaryHost.endsWith(".youtube.com")) {
      nativeAdd.call(navigator.serviceWorker, "controllerchange", () => {
        record("youtube_player_worker", "service-worker",
          "phase=controller_change controlled=" + Boolean(navigator.serviceWorker.controller));
      });
      record("youtube_player_worker", "service-worker",
        "phase=initial_state controlled=" + Boolean(navigator.serviceWorker.controller));
      navigator.serviceWorker.ready.then(registration => {
        const active = registration && registration.active;
        record("youtube_player_worker", "service-worker",
          "phase=ready active_state=" + (active && active.state || "none"));
      }).catch(() => {
        record("youtube_player_worker", "service-worker", "phase=ready_error");
      });
      nativeAdd.call(navigator.serviceWorker, "message", event => {
        record("youtube_player_worker", "service-worker",
          "phase=message message_type=" + workerMessageType(event && event.data));
      });
      nativeAdd.call(navigator.serviceWorker, "messageerror", () => {
        record("youtube_player_worker", "service-worker", "phase=message_error");
      });
    }
    const nativeRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function(scriptURL, options) {
      const routed = routeToProxy(scriptURL);
      if (!routed) return Promise.reject(new TypeError("Intercept only registers HTTP and HTTPS service workers."));
      record("service_worker_register", routed, "Service worker script routed through this session");
      const asset = youtubeAttestationAssetInfo(scriptURL);
      if (asset) {
        record("youtube_attestation_resource", asset.target,
          "phase=worker_register transport=service");
      }
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
  let recentYouTubeVideoNavigation = null;
  let recentYouTubeFeedbackToken = null;
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