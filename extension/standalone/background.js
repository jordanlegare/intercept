"use strict";

const downloadJobs = new Map();

function safeFilename(value) {
  let filename = String(value || "youtube-playback.webm");
  const invalid = ["<", ">", ":", String.fromCharCode(34), "/", String.fromCharCode(92), "|", "?", "*"];
  for (const character of invalid) filename = filename.split(character).join("_");
  filename = Array.from(filename, character => character.charCodeAt(0) < 32 ? "_" : character)
    .join("").trim().slice(0, 140);
  if (!filename) filename = "youtube-playback";
  return filename.toLowerCase().endsWith(".webm") ? filename : filename + ".webm";
}

function finishJob(downloadId, state) {
  const job = downloadJobs.get(downloadId);
  if (!job) return;
  downloadJobs.delete(downloadId);
  try { URL.revokeObjectURL(job.objectUrl); } catch (_) {}
  try { job.port.postMessage({type: "playback-download:finished", state, download_id: downloadId, capture_id: job.captureId, request_id: job.requestId}); } catch (_) {}
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

      downloadJobs.set(downloadId, {objectUrl, port, captureId: message.capture_id || null, requestId: message.request_id || null});
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


function isSupportedOverlayTab(tab) {
  try {
    const url = new URL(tab && tab.url || "");
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "www.youtube.com"
      && (!url.port || url.port === "443")
      && !url.username && !url.password
      && Number.isInteger(tab && tab.id);
  } catch (_) { return false; }
}

const OVERLAY_COMMANDS = new Set([
  "snapshot", "set", "pause", "resume", "split", "stop", "discard",
  "history", "recover", "delete"
]);

browser.action.onClicked.addListener(async tab => {
  if (!isSupportedOverlayTab(tab)) {
    if (tab && Number.isInteger(tab.id)) {
      try {
        await browser.action.setTitle({
          tabId: tab.id,
          title: "Playback Capture requires HTTPS www.youtube.com."
        });
        await browser.action.setBadgeText({tabId: tab.id, text: ""});
      } catch (_) {}
    }
    return;
  }

  try {
    await browser.scripting.executeScript({
      target: {tabId: tab.id},
      files: ["overlay.js"]
    });
    await browser.action.setTitle({
      tabId: tab.id,
      title: "Playback Capture dark overlay is active"
    });
    await browser.action.setBadgeBackgroundColor({tabId: tab.id, color: "#9BE24B"});
    await browser.action.setBadgeText({tabId: tab.id, text: "ON"});
  } catch (error) {
    try {
      await browser.action.setBadgeText({tabId: tab.id, text: "ERR"});
      await browser.action.setTitle({
        tabId: tab.id,
        title: String(error && error.message || error || "Could not inject Playback Capture overlay.")
      });
    } catch (_) {}
  }
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "playback-capture:overlay-command") return undefined;
  const senderUrl = (() => {
    try { return new URL(sender && sender.url || ""); }
    catch (_) { return null; }
  })();
  const trusted = !!senderUrl
    && senderUrl.protocol === "https:"
    && senderUrl.hostname.toLowerCase() === "www.youtube.com"
    && (!senderUrl.port || senderUrl.port === "443")
    && sender && sender.frameId === 0
    && sender.tab && Number.isInteger(sender.tab.id);
  if (!trusted) {
    return Promise.resolve({ok: false, error: "Overlay commands are accepted only from a top-level www.youtube.com tab."});
  }
  if (!OVERLAY_COMMANDS.has(message.command)) {
    return Promise.resolve({ok: false, error: "Unsupported Playback Capture command."});
  }

  return browser.scripting.executeScript({
    target: {tabId: sender.tab.id},
    world: "MAIN",
    func: async function(command, payload) {
      const api = globalThis.__standalonePlaybackDownloadV1;
      if (!api || typeof api.runCommand !== "function") {
        return {ok: false, error: "Playback Capture is not ready. Reload this YouTube tab and activate the extension again."};
      }
      try {
        return {ok: true, result: await api.runCommand(command, payload)};
      } catch (error) {
        return {ok: false, error: String(error && error.message || error || "Playback Capture command failed.")};
      }
    },
    args: [message.command, message.payload]
  }).then(results => {
    const result = results && results[0] && results[0].result;
    return result || {ok: false, error: "The YouTube tab did not return a capture response."};
  }).catch(error => ({
    ok: false,
    error: String(error && error.message || error || "Could not communicate with the YouTube capture runtime.")
  }));
});
