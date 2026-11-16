(() => {
  "use strict";

  const script = document.currentScript;
  const sessionId = script && script.dataset.session;
  const upstreamOrigin = script && script.dataset.upstreamOrigin;
  if (!sessionId || !upstreamOrigin) return;

  const sessionPrefix = "/p/" + encodeURIComponent(sessionId);
  const rawFetch = window.fetch.bind(window);
  const nativeAdd = EventTarget.prototype.addEventListener;
  const queue = [];
  const eventBuffer = [];
  let authorityFrame = null;
  let gateState = "waiting";
  let replaying = false;
  let lastListenerReport = 0;
  let eventFlushInFlight = false;

  function selectorFor(node) {
    if (!(node instanceof Element)) return String(node && node.nodeName || "unknown");
    const parts = [node.tagName.toLowerCase()];
    if (node.id) parts.push("#" + node.id.slice(0, 80));
    if (node.classList && node.classList.length) {
      parts.push("." + Array.from(node.classList).slice(0, 3).map(v => v.slice(0, 32)).join("."));
    }
    return parts.join("").slice(0, 180);
  }

  function record(kind, target, detail) {
    eventBuffer.push({
      kind: String(kind).slice(0, 80),
      target: String(target || "").slice(0, 240),
      detail: String(detail || "").slice(0, 300)
    });
    if (eventBuffer.length > 120) eventBuffer.shift();
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
      if (url.pathname === apiPrefix || url.pathname.startsWith(apiPrefix + "/") ||
          url.pathname === "/assets/controller.js" || url.pathname === "/assets/intercept.css") return url.href;
      return sessionPrefix + path;
    }
    if (url.origin === upstreamOrigin) return sessionPrefix + path;
    return sessionPrefix + "/_/" + url.protocol.slice(0, -1) + "/" + url.host + path;
  }

  function routeSrcset(value) {
    return String(value).split(",").map(candidate => {
      const pieces = candidate.trim().split(/\s+/);
      if (!pieces[0]) return candidate;
      pieces[0] = routeToProxy(pieces[0]) || pieces[0];
      return pieces.join(" ");
    }).join(", ");
  }

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const key = String(name).toLowerCase();
    if (["href", "src", "action", "formaction", "poster", "data", "cite", "background"].includes(key)) {
      value = routeToProxy(value) || value;
    } else if (key === "srcset") {
      value = routeSrcset(value);
    }
    return nativeSetAttribute.call(this, name, value);
  };

  function patchUrlSetter(proto, property) {
    if (!proto) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (!descriptor || !descriptor.set || !descriptor.configurable) return;
    Object.defineProperty(proto, property, {
      ...descriptor,
      set(value) {
        const routed = routeToProxy(value);
        return descriptor.set.call(this, routed || value);
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
      if (routed && routed !== current) nativeSetAttribute.call(element, attribute, routed);
    }
    const srcset = element.getAttribute("srcset");
    if (srcset) {
      const routed = routeSrcset(srcset);
      if (routed !== srcset) nativeSetAttribute.call(element, "srcset", routed);
    }
    const style = element.getAttribute("style");
    if (style) {
      const routed = routeCssValue(style);
      if (routed !== style) nativeSetAttribute.call(element, "style", routed);
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

  for (const type of ["pointerdown", "click", "change", "input", "keydown"]) {
    nativeAdd.call(document, type, event => {
      const detail = type === "keydown" ? "key=" + String(event.key || "").slice(0, 24) : "";
      record("dom_" + type, selectorFor(event.target), detail);
    }, true);
  }

  function queueAction(action, description) {
    if (queue.length >= 50) {
      showNotice("Action queue is full (50). Wait for authorization before trying again.");
      record("queue_full", description, "Action not queued");
      return;
    }
    queue.push(action);
    showNotice(queue.length + " browser action(s) held until authorization.");
    record("action_queued", description, "Held until timer authorization");
  }

  function releaseQueuedActions() {
    if (gateState !== "released" || !queue.length) return;
    const actions = queue.splice(0);
    showNotice("Timer complete. Releasing " + actions.length + " queued browser action(s).");
    record("actions_released", "browser queue", String(actions.length) + " action(s)");
    for (const action of actions) {
      try { action(); } catch (error) { console.error("Intercept could not replay action", error); }
    }
  }

  nativeAdd.call(document, "click", event => {
    if (gateState === "released" || replaying) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href],area[href]") : null;
    if (!anchor) return;
    const href = anchor.href;
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
    if (!(form instanceof HTMLFormElement) || gateState === "released" || replaying) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const routedAction = routeToProxy(form.action);
    if (!routedAction) {
      showNotice("Could not route this form through the active Intercept session.");
      record("form_blocked", selectorFor(form), form.action);
      return;
    }
    const submitter = event.submitter;
    queueAction(() => {
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
    }, form.method.toUpperCase() + " " + form.action);
  }, true);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
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
      const headers = new Headers(routedRequest.headers);
      headers.set("X-Intercept-Proxy-Mode", "ajax");
      const markedRequest = new Request(routedRequest, {headers});
      record("ajax_routed", routed, method);
      return nativeFetch(markedRequest);
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
    xhrMeta.set(this, {method: String(method).toUpperCase(), url: routed});
    return nativeXhrOpen.call(this, method, routed, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const meta = xhrMeta.get(this);
    if (meta) {
      try {
        // Add the internal marker last, after page code has configured headers.
        nativeXhrSetRequestHeader.call(this, "X-Intercept-Proxy-Mode", "ajax");
      } catch (error) {
        record("xhr_marker_error", meta.url, String(error && error.message || error));
      }
      record("xhr", meta.url, meta.method);
      record("ajax_routed", meta.url, meta.method);
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
      record("send_beacon", routed, "POST");
      return nativeSendBeacon(routed, data);
    };
  }

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    window.EventSource = function(url, options) {
      const routed = routeToProxy(url);
      if (!routed) throw new DOMException("Intercept only proxies HTTP and HTTPS requests.", "SecurityError");
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

  function initializeToolbar() {
    const placeholder = document.getElementById("intercept-toolbar");
    if (!placeholder || !document.body) {
      console.error("Intercept could not initialize its authority frame.");
      return;
    }
    const host = document.createElement("div");
    host.id = "intercept-ui-host";
    host.style.cssText = "position:fixed;inset:auto 0 0;height:148px;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({mode: "closed"});
    const frame = document.createElement("iframe");
    frame.title = "Intercept authority controls";
    frame.src = "http://127.0.0.1:5000/authority/" + encodeURIComponent(sessionId);
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    authorityFrame = frame;
    frame.referrerPolicy = "no-referrer";
    frame.style.cssText = "display:block;width:100%;height:148px;border:0;pointer-events:auto;background:#080e16;";
    root.appendChild(frame);
    placeholder.remove();
    const oldStylesheet = document.querySelector('link[href="/assets/intercept.css"]');
    if (oldStylesheet) oldStylesheet.remove();
    document.body.appendChild(host);
    document.documentElement.style.setProperty("scroll-padding-bottom", "158px", "important");
    document.body.style.setProperty("padding-bottom", "148px", "important");
    nativeAdd.call(window, "message", event => {
      const data = event.data;
      if (event.origin !== "http://127.0.0.1:5000"
          || !authorityFrame
          || event.source !== authorityFrame.contentWindow
          || !data
          || data.type !== "intercept:authority-status"
          || data.session_id !== sessionId
          || !["waiting", "running", "released"].includes(data.state)) {
        return;
      }
      gateState = data.state;
      if (gateState === "released") releaseQueuedActions();
      record("authority_status_received", "authority-frame", gateState);
    });
    record("controller_loaded", "document", "Isolated cross-origin authority frame initialized");
    window.setInterval(flushEvents, 1200);
  }

  if (document.readyState === "loading") {
    nativeAdd.call(document, "DOMContentLoaded", initializeToolbar, {once: true});
  } else {
    initializeToolbar();
  }
})();