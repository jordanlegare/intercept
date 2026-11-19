"use strict";

const downloadJobs = new Map();

function safeFilename(value) {
  let filename = String(value || "youtube-playback.webm")
    .replace(/[<>:"\\/|?*\\u0000-\\u001f]/g, "_")
    .replace(/[\\/]+/g, "_")
    .trim()
    .slice(0, 140);
  if (!filename) filename = "youtube-playback";
  return filename.toLowerCase().endsWith(".webm") ? filename : filename + ".webm";
}

function finishJob(downloadId, state) {
  const job = downloadJobs.get(downloadId);
  if (!job) return;
  downloadJobs.delete(downloadId);
  try { URL.revokeObjectURL(job.objectUrl); } catch (_) {}
  try { job.port.postMessage({type: "playback-download:finished", state}); } catch (_) {}
  try { job.port.disconnect(); } catch (_) {}
}

browser.downloads.onChanged.addListener(delta => {
  if (!delta || !delta.state) return;
  if (delta.state.current === "complete" || delta.state.current === "interrupted") {
    finishJob(delta.id, delta.state.current);
  }
});

browser.runtime.onConnect.addListener(port => {
  if (!port || port.name !== "standalone-playback-download") return;
  const senderUrl = (() => {
    try { return new URL(port.sender && port.sender.url || ""); }
    catch (_) { return null; }
  })();
  const senderHost = senderUrl ? senderUrl.hostname.toLowerCase() : "";
  const trustedSender = !!senderUrl
    && senderUrl.protocol === "https:"
    && (senderHost === "youtube.com" || senderHost.endsWith(".youtube.com"))
    && port.sender && port.sender.frameId === 0;

  let accepted = false;
  port.onMessage.addListener(async message => {
    if (accepted || !message || message.type !== "start") return;
    accepted = true;
    try {
      if (!trustedSender) {
        throw new Error("Downloads are accepted only from a top-level HTTPS YouTube page.");
      }
      const blob = message.blob;
      if (!blob || typeof blob.size !== "number"
          || typeof blob.slice !== "function"
          || typeof blob.type !== "string"
          || !blob.type.toLowerCase().startsWith("video/webm")
          || blob.size <= 0
          || blob.size > 2 * 1024 * 1024 * 1024) {
        throw new Error("The captured WebM file has an invalid type or size.");
      }

      const objectUrl = URL.createObjectURL(blob);
      let downloadId;
      try {
        downloadId = await browser.downloads.download({
          url: objectUrl,
          filename: safeFilename(message.filename),
          conflictAction: "uniquify",
          saveAs: false
        });
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }

      downloadJobs.set(downloadId, {objectUrl, port});
      port.postMessage({type: "playback-download:started", download_id: downloadId});
      try {
        const matches = await browser.downloads.search({id: downloadId});
        const item = matches && matches[0];
        if (item && (item.state === "complete" || item.state === "interrupted")) {
          finishJob(downloadId, item.state);
        }
      } catch (_) {}
    } catch (error) {
      try {
        port.postMessage({
          type: "playback-download:failed",
          error: String(error && error.message || error || "Firefox could not start the download.")
        });
      } catch (_) {}
      try { port.disconnect(); } catch (_) {}
    }
  });
});
