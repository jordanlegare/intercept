(() => {
  "use strict";

  const KEY = "__interceptWorkerProbeV1";
  if (globalThis[KEY]) return;

  const MAX_EVENTS = 200;

  function hostClass(host) {
    host = String(host || "").toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
    if (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) return "googlevideo";
    if (host === "googleapis.com" || host.endsWith(".googleapis.com")) return "googleapis";
    if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
    if (host === "127.0.0.1" || host === "::1") return "loopback";
    return "other";
  }

  function pathClass(path) {
    if (path === "/" || !path) return "root";
    if (/^\/watch\/?$/.test(path)) return "watch";
    if (/^\/embed\//.test(path)) return "embed";
    if (/^\/shorts\//.test(path)) return "shorts";
    if (/^\/s\/player\/[^/]+\/base\.js$/.test(path)) return "player_bundle";
    if (path === "/videoplayback") return "media";
    if (/^\/youtubei\/v1\/player$/.test(path)) return "innertube_player";
    if (/^\/youtubei\/v1\//.test(path)) return "innertube";
    return "other";
  }

  function scriptDescriptor(input) {
    try {
      const raw = input instanceof URL ? input.href : String(input);
      const parsed = new URL(raw, document.baseURI);
      const isBlob = parsed.protocol === "blob:";
      let origin = parsed.origin;
      if (isBlob && origin === "null") {
        const match = raw.match(/^blob:(https?:\/\/[^/]+)/i);
        origin = match ? match[1] : "null";
      }
      let originScheme = "opaque";
      let host = "other";
      let originClass = "opaque";
      if (origin && origin !== "null") {
        const originUrl = new URL(origin);
        originScheme = originUrl.protocol.replace(/:$/, "");
        host = hostClass(originUrl.hostname);
        originClass = originScheme + "://" + host
          + (originUrl.port ? ":" + originUrl.port : "");
      }
      return {
        scheme: parsed.protocol.replace(/:$/, ""),
        origin_scheme: originScheme,
        host_class: host,
        origin_class: originClass,
        path_class: isBlob ? "blob_worker" : pathClass(parsed.pathname),
        port: parsed.port || "default"
      };
    } catch (_) {
      return {
        scheme: "unparseable",
        origin_scheme: "opaque",
        host_class: "other",
        origin_class: "opaque",
        path_class: "other",
        port: "unknown"
      };
    }
  }

  const state = {
    schema_version: 1,
    installed_at_ms: Date.now(),
    events: [],
    dropped_events: 0,
    instrumentation: {}
  };

  function addEvent(event) {
    if (state.events.length >= MAX_EVENTS) {
      state.events.shift();
      state.dropped_events++;
    }
    state.events.push(event);
  }

  function installConstructor(name, kind) {
    const original = globalThis[name];
    if (typeof original !== "function") {
      state.instrumentation[name] = "unavailable";
      return;
    }

    try {
      const wrapped = new Proxy(original, {
        construct(target, args, newTarget) {
          const event = {
            at_ms: Math.round(performance.now()),
            constructor: kind,
            script: scriptDescriptor(args[0]),
            options: {},
            outcome: "unknown"
          };

          const options = args[1];
          if (options && typeof options === "object") {
            if (options.type === "classic" || options.type === "module") {
              event.options.type = options.type;
            }
            if (options.credentials === "omit" || options.credentials === "same-origin"
                || options.credentials === "include") {
              event.options.credentials = options.credentials;
            }
            if (kind === "shared" && typeof options.name === "string") {
              event.options.name_present = options.name.length > 0;
            }
          }

          try {
            const instance = Reflect.construct(target, args, newTarget);
            event.outcome = "constructed";
            addEvent(event);
            return instance;
          } catch (error) {
            event.outcome = "constructor_threw";
            addEvent(event);
            throw error;
          }
        }
      });

      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        Object.defineProperty(globalThis, name, {...descriptor, value: wrapped});
      } else {
        Object.defineProperty(globalThis, name, {
          value: wrapped,
          configurable: true,
          enumerable: descriptor ? !!descriptor.enumerable : false,
          writable: true
        });
      }
      state.instrumentation[name] = globalThis[name] === wrapped ? "installed" : "failed";
    } catch (_) {
      state.instrumentation[name] = "failed";
    }
  }

  installConstructor("Worker", "dedicated");
  installConstructor("SharedWorker", "shared");

  try {
    Object.defineProperty(globalThis, KEY, {
      value: state,
      configurable: false,
      enumerable: false,
      writable: false
    });
  } catch (_) {
    // The probe is best-effort and must never prevent page startup.
  }
})();
