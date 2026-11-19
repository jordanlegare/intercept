(() => {
  "use strict";
  if (location.protocol !== "https:") return;
  const host = location.hostname.toLowerCase();
  if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return;

  const MESSAGE_TYPE = "standalone-playback-download:request";
  const RESULT_TYPE = "standalone-playback-download:result";

  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin
        || !data || data.type !== MESSAGE_TYPE
        || typeof data.request_id !== "string"
        || !data.blob || typeof data.blob.size !== "number"
        || typeof data.blob.slice !== "function"
        || typeof data.blob.type !== "string") return;

    let port;
    try {
      port = browser.runtime.connect({name: "standalone-playback-download"});
    } catch (error) {
      window.postMessage({
        type: RESULT_TYPE,
        request_id: data.request_id,
        ok: false,
        error: String(error && error.message || error || "Could not connect to the extension download service.")
      }, location.origin);
      return;
    }

    let acknowledged = false;
    const fail = error => {
      if (acknowledged) return;
      acknowledged = true;
      window.postMessage({
        type: RESULT_TYPE,
        request_id: data.request_id,
        ok: false,
        error: String(error && error.message || error || "Firefox could not start the playback download.")
      }, location.origin);
      try { port.disconnect(); } catch (_) {}
    };

    port.onMessage.addListener(message => {
      if (!message) return;
      if (message.type === "playback-download:failed") {
        fail(message.error);
        return;
      }
      if (message.type === "playback-download:finished") {
        window.postMessage({
          type: RESULT_TYPE,
          request_id: message.request_id || data.request_id,
          download_id: message.download_id,
          capture_id: message.capture_id || data.capture_id,
          download_state: message.state
        }, location.origin);
        return;
      }
      if (message.type !== "playback-download:started") return;
      acknowledged = true;
      window.postMessage({
        type: RESULT_TYPE,
        request_id: data.request_id,
        ok: true,
        download_id: message.download_id
      }, location.origin);
    });
    port.onDisconnect.addListener(() => {
      if (!acknowledged) fail(browser.runtime.lastError || "The extension download process disconnected.");
    });

    try {
      port.postMessage({
        type: "start",
        request_id: data.request_id,
        capture_id: data.capture_id,
        filename: data.filename,
        blob: data.blob
      });
    } catch (error) {
      fail(error);
    }
  });
})();