(() => {
  "use strict";

  const script = document.currentScript;
  const sessionId = script && script.dataset.session;
  const upstreamOrigin = script && script.dataset.upstreamOrigin;
  if (!sessionId || !upstreamOrigin) return;

  const rawFetch = window.fetch.bind(window);
  const api = (suffix) => "/api/sessions/" + encodeURIComponent(sessionId) + suffix;
  const queue = [];
  const eventBuffer = [];
  let gateState = "waiting";
  let remainingMs = 0;
  let replaying = false;
  let lastListenerReport = 0;

  const noticeNode = () => document.getElementById("intercept-notice");

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
    if (!eventBuffer.length) return;
    const batch = eventBuffer.splice(0, 100);
    try {
      await rawFetch(api("/events"), {
        method: "POST",
        headers: {"content-type":"application/json"},
        body: JSON.stringify(batch),
        keepalive: true
      });
    } catch (_) {
      eventBuffer.unshift(...batch);
    }
  }

  function showNotice(message) {
    const node = noticeNode();
    if (node) node.textContent = message;
  }

  function queueAction(action, description) {
    if (queue.length >= 50) {
      showNotice("Action queue is full (50). Wait for authorization before trying again.");
      record("queue_full", description, "Action not queued");
      return;
    }
    queue.push(action);
    showNotice(queue.length + " browser action(s) held until authorization.");
    record("action_queued", description, "Held by the browser controller");
  }

  function releaseQueuedActions() {
    if (gateState !== "released" || !queue.length) return;
    const actions = queue.splice(0);
    showNotice("Timer complete. Releasing " + actions.length + " queued browser action(s).");
    for (const action of actions) {
      try { action(); } catch (error) { console.error("Intercept could not replay action", error); }
    }
  }

  function routeRequestUrl(value) {
    try {
      const url = new URL(value, location.href);
      const fromLocal = url.origin === location.origin;
      const fromUpstream = url.origin === upstreamOrigin;
      if (!fromLocal && !fromUpstream) return null;
      const prefix = "/p/" + sessionId;
      if (fromUpstream || (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/"))) {
        url.pathname = prefix + (url.pathname.startsWith("/") ? url.pathname : "/" + url.pathname);
      }
      url.host = location.host;
      url.protocol = location.protocol;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function sameLocalOrigin(value) {
    try {
      const origin = new URL(value, location.href).origin;
      return origin === location.origin || origin === upstreamOrigin;
    } catch (_) {
      return false;
    }
  }

  // Install this before page scripts so registrations made after the controller loads are observable.
  const nativeAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (["click","submit","change","input","keydown","pointerdown"].includes(String(type)) &&
        (this === window || this === document || this instanceof Element)) {
      const now = Date.now();
      if (now - lastListenerReport > 100) {
        lastListenerReport = now;
        record("listener_registered", selectorFor(this), String(type));
      }
    }
    return nativeAdd.call(this, type, listener, options);
  };

  for (const type of ["pointerdown","click","change","input","keydown"]) {
    nativeAdd.call(document, type, event => {
      const target = event.target;
      record("dom_" + type, selectorFor(target), type === "keydown" ? "key=" + String(event.key || "").slice(0, 24) : "");
    }, true);
  }

  nativeAdd.call(document, "click", event => {
    if (gateState === "released" || replaying) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href],area[href]") : null;
    if (!anchor) return;
    const href = anchor.href;
    const routedHref = routeRequestUrl(href);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!routedHref) {
      showNotice("Blocked a cross-origin link. Open that origin in a separate Intercept session.");
      record("external_navigation_blocked", selectorFor(anchor), href);
      return;
    }
    queueAction(() => location.assign(routedHref), routedHref);
  }, true);

  nativeAdd.call(document, "submit", event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || gateState === "released" || replaying) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const routedAction = routeRequestUrl(form.action);
    if (!routedAction) {
      showNotice("Blocked a cross-origin form action. This session is pinned to one origin.");
      record("external_form_blocked", selectorFor(form), form.action);
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
        setTimeout(() => { replaying = false; }, 0);
      }
    }, form.method.toUpperCase() + " " + form.action);
  }, true);

  // Same-origin fetch/XHR traffic is still sent through the Rust proxy. Rust gates
  // mutating verbs; cross-origin scripted requests are rejected to avoid silent bypass.
  const nativeFetch = window.fetch;
  window.fetch = function(input, init) {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const method = String((init && init.method) || (input instanceof Request && input.method) || "GET").toUpperCase();
    record("fetch", rawUrl, method);
    const routedUrl = routeRequestUrl(rawUrl);
    if (!routedUrl) {
      return Promise.reject(new TypeError("Intercept blocks cross-origin fetch; open the destination in its own session."));
    }
    const routedInput = input instanceof Request ? new Request(routedUrl, input) : routedUrl;
    return nativeFetch.call(this, routedInput, init);
  };

  const xhrMeta = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const routedUrl = routeRequestUrl(String(url));
    if (!routedUrl) throw new DOMException("Intercept blocks cross-origin XHR", "SecurityError");
    xhrMeta.set(this, {method: String(method).toUpperCase(), url: routedUrl});
    return nativeOpen.call(this, method, routedUrl, ...rest);
  };
  if (navigator.sendBeacon) {
    const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      const routedUrl = routeRequestUrl(String(url));
      if (!routedUrl) {
        record("beacon_blocked", String(url), "Cross-origin sendBeacon blocked");
        return false;
      }
      record("send_beacon", routedUrl, "POST");
      return nativeSendBeacon(routedUrl, data);
    };
  }

  XMLHttpRequest.prototype.send = function(...args) {
    const meta = xhrMeta.get(this);
    if (meta) {
      record("xhr", meta.url, meta.method);
      if (!sameLocalOrigin(meta.url)) throw new DOMException("Intercept blocks cross-origin XHR", "SecurityError");
    }
    return nativeSend.apply(this, args);
  };

  async function pollStatus() {
    try {
      const response = await rawFetch(api("/status"), {cache:"no-store"});
      if (!response.ok) throw new Error("status " + response.status);
      const data = await response.json();
      gateState = data.state;
      remainingMs = data.remaining_ms || 0;
      const stateNode = document.getElementById("intercept-state");
      const countdownNode = document.getElementById("intercept-countdown");
      const startButton = document.getElementById("intercept-start");
      const delayInput = document.getElementById("intercept-delay");
      if (stateNode) {
        stateNode.textContent = gateState === "waiting" ? "WAITING FOR START" :
          gateState === "running" ? "AUTHORIZATION COUNTDOWN" : "AUTHORIZED";
      }
      if (countdownNode) {
        countdownNode.textContent = gateState === "waiting" ? "Not started" :
          gateState === "released" ? "00:00" : (remainingMs / 1000).toFixed(1) + "s";
      }
      if (startButton) startButton.disabled = gateState !== "waiting";
      if (delayInput) delayInput.disabled = gateState !== "waiting";
      if (gateState === "released") releaseQueuedActions();
    } catch (error) {
      showNotice("Lost contact with the local authorization service: " + error.message);
    }
  }

  async function pollEvents() {
    try {
      const response = await rawFetch(api("/events"), {cache:"no-store"});
      if (!response.ok) return;
      const events = await response.json();
      const summary = document.getElementById("intercept-events-summary");
      const list = document.getElementById("intercept-events-list");
      if (summary) summary.textContent = "EVENT STREAM · " + events.length + " retained";
      if (list) {
        list.textContent = events.slice(-30).reverse().map(item => {
          const time = new Date(Number(item.at_unix_ms)).toLocaleTimeString();
          return "[" + time + "] " + item.kind + " · " + item.detail + " · " + item.target;
        }).join("\n") || "No events recorded yet.";
      }
    } catch (_) {}
  }

  nativeAdd.call(document, "click", async event => {
    const startButton = event.target instanceof Element ? event.target.closest("#intercept-start") : null;
    if (!startButton) return;
    const delayInput = document.getElementById("intercept-delay");
    const seconds = Number(delayInput && delayInput.value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
      showNotice("Enter a whole-number delay from 1 to 86400 seconds.");
      return;
    }
    startButton.disabled = true;
    try {
      const response = await rawFetch(api("/start"), {
        method: "POST",
        headers: {"content-type":"application/json"},
        body: JSON.stringify({delay_seconds: seconds})
      });
      if (!response.ok) throw new Error(await response.text() || "Timer could not start");
      const data = await response.json();
      record("timer_started", "intercept-toolbar", seconds + " seconds");
      await pollStatus();
    } catch (error) {
      showNotice(error.message || String(error));
      startButton.disabled = false;
    }
  }, true);

  setInterval(pollStatus, 400);
  setInterval(pollEvents, 1800);
  setInterval(flushEvents, 1200);
  pollStatus();
  pollEvents();
  record("controller_loaded", "document", "Browser event observer active");
})();