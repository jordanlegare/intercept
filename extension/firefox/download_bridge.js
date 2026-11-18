(() => {
  "use strict";
  if (location.protocol !== "https:") return;
  const host = location.hostname.toLowerCase();
  if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return;

  const MESSAGE_TYPE = "intercept-playback-download:request";
  const RESULT_TYPE = "intercept-playback-download:result";
  const activeObjectUrls = new Map();

  function sendResult(requestId, payload) {
    window.postMessage({
      type: RESULT_TYPE,
      request_id: requestId,
      ...payload
    }, location.origin);
  }

  function safeFilename(value) {
    const name = String(value || "youtube-playback.webm")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[\\/]+/g, "_")
      .trim()
      .slice(0, 140);
    return name.toLowerCase().endsWith(".webm") ? name : (name || "youtube-playback") + ".webm";
  }

  browser.downloads.onChanged.addListener(delta => {
    const objectUrl = activeObjectUrls.get(delta.id);
    if (!objectUrl) return;
    if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
      activeObjectUrls.delete(delta.id);
      URL.revokeObjectURL(objectUrl);
    }
  });

  window.addEventListener("message", async event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin
        || !data || data.type !== MESSAGE_TYPE
        || typeof data.request_id !== "string"
        || typeof data.token !== "string" || !data.token
        || !data.blob || typeof data.blob.size !== "number"
        || typeof data.blob.slice !== "function"
        || typeof data.blob.type !== "string") return;

    try {
      const stored = await browser.storage.local.get("nativeSession");
      const session = stored.nativeSession;
      if (!session || !session.downloadEnabled || !session.downloadToken
          || session.downloadToken !== data.token) {
        throw new Error("The active extension session did not authorize this playback download.");
      }
      if (!data.blob.type.toLowerCase().startsWith("video/webm")
          || data.blob.size <= 0 || data.blob.size > 2 * 1024 * 1024 * 1024) {
        throw new Error("The captured WebM file has an invalid type or size.");
      }

      const objectUrl = URL.createObjectURL(data.blob);
      try {
        const downloadId = await browser.downloads.download({
          url: objectUrl,
          filename: safeFilename(data.filename),
          conflictAction: "uniquify"
        });
        activeObjectUrls.set(downloadId, objectUrl);
        // Some download transitions may not emit a terminal event while this
        // document is alive; keep a bounded fallback revocation as well.
        setTimeout(() => {
          if (activeObjectUrls.get(downloadId) === objectUrl) {
            activeObjectUrls.delete(downloadId);
            URL.revokeObjectURL(objectUrl);
          }
        }, 60 * 60 * 1000);
        sendResult(data.request_id, {ok: true, download_id: downloadId});
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
    } catch (error) {
      sendResult(data.request_id, {
        ok: false,
        error: String(error && error.message || error || "Firefox could not start the playback download.")
      });
    }
  });
})();