(() => {
  "use strict";

  const script = document.currentScript;
  const sessionId = script && script.dataset.session;
  const upstreamOrigin = script && script.dataset.upstreamOrigin;
  if (!sessionId || !upstreamOrigin) return;

  const sessionPrefix = "/p/" + encodeURIComponent(sessionId);
  const apiPrefix = "/api/sessions/" + encodeURIComponent(sessionId);
  const api = suffix => apiPrefix + suffix;
  const stateNode = () => document.getElementById("intercept-state");
  const countdownNode = () => document.getElementById("intercept-countdown");
  const delayInput = () => document.getElementById("intercept-delay");
  const startButton = () => document.getElementById("intercept-start");

  // The page remains on localhost, but every HTTP(S) request made by its scripts
  // is translated into a path-addressed upstream request handled by Rust.
  function routeToProxy(value) {
    let url;
    try {
      url = new URL(value instanceof URL ? value.href : String(value), document.baseURI);
    } catch (_) {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const path = url.pathname + url.search + url.hash;
    if (url.origin === location.origin) {
      if (url.pathname === sessionPrefix || url.pathname.startsWith(sessionPrefix + "/")) {
        return url.href;
      }
      if (url.pathname === apiPrefix || url.pathname.startsWith(apiPrefix + "/") ||
          url.pathname === "/assets/controller.js" || url.pathname === "/assets/intercept.css") {
        return url.href;
      }
      return sessionPrefix + path;
    }

    if (url.origin === upstreamOrigin) {
      return sessionPrefix + path;
    }
    return sessionPrefix + "/_/" + url.protocol.slice(0, -1) + "/" + url.host + path;
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const source = input instanceof Request ? input.url : input;
    const routed = routeToProxy(source);
    if (!routed) {
      return Promise.reject(new TypeError("Intercept only proxies HTTP and HTTPS requests."));
    }
    try {
      const routedInput = input instanceof Request ? new Request(routed, input) : routed;
      return nativeFetch.call(this, routedInput, init);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const routed = routeToProxy(url);
    if (!routed) throw new DOMException("Intercept only proxies HTTP and HTTPS requests.", "SecurityError");
    return nativeXhrOpen.call(this, method, routed, ...rest);
  };

  if (navigator.sendBeacon) {
    const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      const routed = routeToProxy(url);
      return routed ? nativeSendBeacon(routed, data) : false;
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

  const nativeOpenWindow = window.open;
  window.open = function(url, ...rest) {
    const routed = routeToProxy(url);
    return nativeOpenWindow.call(this, routed || url, ...rest);
  };

  async function pollStatus() {
    try {
      const response = await nativeFetch(api("/status"), { cache: "no-store" });
      if (!response.ok) throw new Error("status " + response.status);
      const data = await response.json();

      const state = data.state;
      const status = stateNode();
      const countdown = countdownNode();
      const button = startButton();
      const input = delayInput();

      if (status) {
        status.textContent = state === "waiting" ? "WAITING" :
          state === "running" ? "AUTHORIZATION COUNTDOWN" : "AUTHORIZED";
      }
      if (countdown) {
        countdown.textContent = state === "waiting" ? "NOT STARTED" :
          state === "released" ? "00:00.00" :
          (Math.ceil((data.remaining_ms || 0) / 10) / 100).toFixed(2) + "s";
      }
      if (button) button.disabled = state !== "waiting";
      if (input) input.disabled = state !== "waiting";
    } catch (error) {
      const status = stateNode();
      const countdown = countdownNode();
      if (status) status.textContent = "SERVICE UNAVAILABLE";
      if (countdown) countdown.textContent = String(error.message || error).slice(0, 80);
    }
  }

  document.addEventListener("click", async event => {
    const target = event.target;
    const button = target instanceof Element ? target.closest("#intercept-start") : null;
    if (!button || button.disabled) return;

    const seconds = Number(delayInput() && delayInput().value);
    if (!Number.isFinite(seconds) || seconds < 0.000000001 || seconds > 86400) {
      const status = stateNode();
      if (status) status.textContent = "INVALID DELAY";
      return;
    }

    button.disabled = true;
    try {
      const response = await nativeFetch(api("/start"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delay_seconds: seconds })
      });
      if (!response.ok) throw new Error(await response.text() || "Timer could not start");
      await pollStatus();
    } catch (error) {
      const status = stateNode();
      const countdown = countdownNode();
      if (status) status.textContent = "START FAILED";
      if (countdown) countdown.textContent = String(error.message || error).slice(0, 80);
      button.disabled = false;
    }
  });

  pollStatus();
  window.setInterval(pollStatus, 200);
})();
