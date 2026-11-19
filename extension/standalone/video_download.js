(() => {
  "use strict";

  const KEY = "__standalonePlaybackDownloadV1";
  const host = location.hostname.toLowerCase();
  if (location.protocol !== "https:" || !(host === "youtube.com" || host.endsWith(".youtube.com"))
      || (location.port && location.port !== "443")) return;
  if (globalThis[KEY]) return;
  const CACHE_DIRECTORY = "standalone-playback-downloads";
  const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;
  const status = {
    enabled: false,
    state: "disabled",
    bytes_written: 0,
    filename: null,
    error: null,
    mime_type: null,
    started_at_ms: null,
    completed_at_ms: null
  };
  let activeCapture = null;
  let navigationInProgress = false;
  let navigationSnapshot = null;
  const pendingDownloads = new Map();
  const watchedVideos = new WeakSet();

  function requestBrowserDownload(file, filename) {
    const requestId = (globalThis.crypto && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingDownloads.delete(requestId);
        reject(new Error("The extension download service did not acknowledge the completed file."));
      }, 20_000);
      pendingDownloads.set(requestId, result => {
        clearTimeout(timeout);
        pendingDownloads.delete(requestId);
        if (result && result.ok) resolve(result);
        else reject(new Error(result && result.error || "Firefox could not start the download."));
      });
      window.postMessage({
        type: "standalone-playback-download:request",
        request_id: requestId,
        filename,
        blob: file
      }, location.origin);
    });
  }

  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin
        || !data || data.type !== "standalone-playback-download:result"
        || typeof data.request_id !== "string") return;
    const resolve = pendingDownloads.get(data.request_id);
    if (resolve) resolve(data);
  });

  function statusSnapshot() {
    return {...status};
  }

  function isPlayerVideo(video) {
    return video instanceof HTMLVideoElement
      && (video.matches("#movie_player video, video.html5-main-video")
        || !!video.closest("ytd-reel-video-renderer"));
  }

  function isAdvertisement(video) {
    const player = video.closest("#movie_player");
    return !!(player && (
      player.classList.contains("ad-showing")
      || player.classList.contains("ad-interrupting")
      || player.querySelector(".ytp-ad-player-overlay")
    ));
  }

  function safeFilename(value) {
    return String(value || "youtube-playback")
      .replace(/\s+-\s+YouTube\s*$/i, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 110) || "youtube-playback";
  }

  function currentVideoContext(video) {
    let url;
    try { url = new URL(location.href); }
    catch (_) { url = new URL("https://www.youtube.com/"); }

    const pathVideoId = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{1,24})/i);
    const rawVideoId = url.searchParams.get("v") || (pathVideoId && pathVideoId[1]) || "";
    const videoId = /^[A-Za-z0-9_-]{1,24}$/.test(rawVideoId) ? rawVideoId : "";
    const mediaSource = String(video && (video.currentSrc || video.src) || "");
    const key = videoId
      ? "youtube:" + videoId
      : "page:" + url.origin + url.pathname + "|media:" + mediaSource;
    const heading = document.querySelector("h1.ytd-watch-metadata, ytd-watch-metadata h1");
    const titleText = heading && heading.textContent && heading.textContent.trim()
      ? heading.textContent.trim()
      : document.title;
    const title = safeFilename(titleText);
    const suffix = videoId ? "-" + videoId : "";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return {key, videoId, title, mediaSource, filename: title + suffix + "-" + timestamp + ".webm"};
  }

  async function openCaptureFile(filename) {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
      throw new Error("Firefox temporary file storage is unavailable for playback capture.");
    }
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(CACHE_DIRECTORY, {create: true});
    const fileHandle = await directory.getFileHandle(filename, {create: true});
    const writable = await fileHandle.createWritable({keepExistingData: false});
    return {directory, fileHandle, writer: writable.getWriter()};
  }

  async function pruneOldCaptureFiles() {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(CACHE_DIRECTORY, {create: true});
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for await (const [name, handle] of directory.entries()) {
        if (!name.endsWith(".webm") || handle.kind !== "file") continue;
        const file = await handle.getFile();
        if (file.lastModified < cutoff) await directory.removeEntry(name);
      }
    } catch (_) {}
  }
  void pruneOldCaptureFiles();

  function supportedMimeType() {
    if (typeof MediaRecorder === "undefined") return null;
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || null;
  }

  function stopCapture(capture, reason) {
    if (!capture || capture.stopRequested) return;
    capture.stopRequested = true;
    capture.stopReason = reason;
    if (capture.recorder && capture.recorder.state !== "inactive") {
      try { capture.recorder.stop(); }
      catch (error) {
        capture.writeError = capture.writeError || String(error && error.message || error);
        void finalizeCapture(capture);
      }
    } else if (capture.preparationFinished) {
      void finalizeCapture(capture);
    }
    // If OPFS is still opening, startCapture observes stopRequested and
    // finalizes the temporary file after asynchronous setup completes.
  }

  function queueChunk(capture, blob) {
    if (!blob || blob.size === 0 || capture.finalized) return;
    if (capture.bytesWritten + blob.size > capture.maxBytes) {
      capture.writeError = "The temporary playback capture reached its available-storage safety limit.";
      stopCapture(capture, "error");
      return;
    }
    capture.bytesWritten += blob.size;
    status.bytes_written = capture.bytesWritten;
    capture.writeQueue = capture.writeQueue.then(() => capture.writer.write(blob)).catch(error => {
      capture.writeError = String(error && error.message || error || "Could not write playback cache.");
      stopCapture(capture, "error");
    });
  }

  async function finalizeCapture(capture) {
    if (!capture || capture.finalized) return;
    capture.finalized = true;
    status.state = "finalizing";
    status.bytes_written = capture.bytesWritten;
    try {
      await capture.writeQueue;
      const shouldSave = !capture.writeError
        && (capture.stopReason === "complete" || capture.stopReason === "source_changed");
      if (capture.writer) {
        if (!shouldSave) {
          try { await capture.writer.abort(capture.writeError || "Playback capture discarded."); } catch (_) {}
        } else {
          await capture.writer.close();
        }
      }
      if (capture.stream) {
        for (const track of capture.stream.getTracks()) {
          try { track.stop(); } catch (_) {}
        }
      }

      if (!shouldSave) {
        if (capture.directory && capture.filename) {
          try { await capture.directory.removeEntry(capture.filename); } catch (_) {}
        }
        status.state = capture.writeError ? "error" : (status.enabled ? "armed" : "disabled");
        status.error = capture.writeError || null;
        status.filename = null;
        return;
      }

      const file = await capture.fileHandle.getFile();
      if (file.size === 0) {
        if (capture.directory && capture.filename) {
          try { await capture.directory.removeEntry(capture.filename); } catch (_) {}
        }
        status.state = status.enabled ? "armed" : "disabled";
        status.filename = null;
        return;
      }
      await requestBrowserDownload(file, capture.filename);
      status.state = "download_started";
      status.bytes_written = file.size;
      status.filename = capture.filename;
      status.error = null;
      status.completed_at_ms = Date.now();

      // Keep the origin-private copy briefly after the browser confirms its download job.
      setTimeout(() => {
        if (capture.directory) void capture.directory.removeEntry(capture.filename).catch(() => {});
      }, 60 * 60 * 1000);
    } catch (error) {
      if (capture.directory && capture.filename) {
        try { await capture.directory.removeEntry(capture.filename); } catch (_) {}
      }
      status.state = "error";
      status.error = String(error && error.message || error || "Playback download failed.");
      status.filename = null;
    } finally {
      if (activeCapture === capture) activeCapture = null;
      if (capture.resolveFinished) capture.resolveFinished();
    }
  }

  async function startCapture(video) {
    if (!status.enabled || navigationInProgress || activeCapture || !video || !video.isConnected || video.ended || isAdvertisement(video)) return;
    const videoContext = currentVideoContext(video);
    const captureMethod = typeof video.captureStream === "function"
      ? video.captureStream.bind(video)
      : typeof video.mozCaptureStream === "function" ? video.mozCaptureStream.bind(video) : null;
    if (!captureMethod) {
      status.state = "error";
      status.error = "This Firefox build does not expose media-element capture.";
      return;
    }
    const mimeType = supportedMimeType();
    if (!mimeType) {
      status.state = "error";
      status.error = "Firefox MediaRecorder has no supported WebM recording type.";
      return;
    }

    const capture = {
      video,
      recorder: null,
      stream: null,
      writer: null,
      fileHandle: null,
      directory: null,
      filename: videoContext.filename,
      videoKey: videoContext.key,
      videoId: videoContext.videoId,
      mediaSource: videoContext.mediaSource,
      videoTitle: videoContext.title,
      mimeType,
      bytesWritten: 0,
      maxBytes: MAX_CAPTURE_BYTES,
      writeQueue: Promise.resolve(),
      writeError: null,
      stopReason: null,
      stopRequested: false,
      finalized: false,
      preparationFinished: false,
      resolveFinished: null
    };
    capture.finished = new Promise(resolve => { capture.resolveFinished = resolve; });
    activeCapture = capture;
    status.state = "preparing";
    status.bytes_written = 0;
    status.filename = null;
    status.error = null;
    status.started_at_ms = Date.now();
    status.completed_at_ms = null;

    try {
      const estimate = await navigator.storage.estimate();
      if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
        const available = Math.max(0, estimate.quota - estimate.usage);
        capture.maxBytes = Math.min(MAX_CAPTURE_BYTES, Math.floor(available * 0.8));
        if (capture.maxBytes < 16 * 1024 * 1024) {
          throw new Error("Not enough available browser storage for a video capture.");
        }
      }
      if (!status.enabled || activeCapture !== capture || capture.stopRequested || navigationInProgress
          || currentVideoContext(video).key !== capture.videoKey || video.ended || !video.isConnected) {
        capture.preparationFinished = true;
        if (!capture.stopRequested) {
          capture.stopRequested = true;
          capture.stopReason = "disabled";
        }
        void finalizeCapture(capture);
        return;
      }
      const opened = await openCaptureFile(capture.filename);
      capture.directory = opened.directory;
      capture.fileHandle = opened.fileHandle;
      capture.writer = opened.writer;
      if (!status.enabled || activeCapture !== capture || capture.stopRequested || navigationInProgress
          || currentVideoContext(video).key !== capture.videoKey || video.ended || !video.isConnected) {
        capture.preparationFinished = true;
        if (!capture.stopRequested) {
          capture.stopRequested = true;
          capture.stopReason = "disabled";
        }
        void finalizeCapture(capture);
        return;
      }

      capture.stream = captureMethod();
      if (!capture.stream.getVideoTracks().length) {
        throw new Error("The player did not expose a capturable video track.");
      }
      capture.recorder = new MediaRecorder(capture.stream, {
        mimeType: capture.mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 160_000
      });
      capture.recorder.addEventListener("dataavailable", event => queueChunk(capture, event.data));
      capture.recorder.addEventListener("error", event => {
        capture.writeError = String(event.error && event.error.message || "MediaRecorder failed.");
        stopCapture(capture, "error");
      });
      capture.recorder.addEventListener("stop", () => {
        void finalizeCapture(capture);
      }, {once: true});
      capture.preparationFinished = true;
      capture.recorder.start(1000);
      status.state = "recording";
      status.mime_type = capture.mimeType;
      status.bytes_written = 0;
    } catch (error) {
      capture.writeError = String(error && error.message || error || "Could not start playback capture.");
      capture.preparationFinished = true;
      if (!capture.stopRequested) {
        capture.stopRequested = true;
        capture.stopReason = "error";
      }
      void finalizeCapture(capture);
    }
  }

  function onPlaying(video) {
    if (!isPlayerVideo(video) || isAdvertisement(video) || !status.enabled || navigationInProgress) return;
    const incomingContext = currentVideoContext(video);
    if (activeCapture) {
      const previous = activeCapture;
      const sameVideo = previous.video === video && previous.videoKey === incomingContext.key;
      if (sameVideo && !previous.stopRequested) {
        if (previous.recorder && previous.recorder.state === "paused") {
          try { previous.recorder.resume(); } catch (_) {}
        }
        return;
      }
      // A YouTube SPA transition can reuse the same video element. A changed
      // video ID is still a hard boundary between independent capture files.
      stopCapture(previous, "source_changed");
      void previous.finished.then(() => {
        if (status.enabled && !navigationInProgress && !video.paused && !video.ended
            && video.isConnected && currentVideoContext(video).key === incomingContext.key) {
          void startCapture(video);
        }
      });
      return;
    }
    void startCapture(video);
  }

  function watchVideo(video) {
    if (!isPlayerVideo(video) || watchedVideos.has(video)) return;
    watchedVideos.add(video);
    video.addEventListener("play", () => onPlaying(video));
    video.addEventListener("playing", () => onPlaying(video));
    video.addEventListener("pause", () => {
      if (activeCapture && activeCapture.video === video && !video.ended
          && activeCapture.recorder && activeCapture.recorder.state === "recording") {
        try { activeCapture.recorder.pause(); } catch (_) {}
      }
    });
    video.addEventListener("ended", () => {
      if (activeCapture && activeCapture.video === video) {
        const reason = isAdvertisement(video)
          ? "ad"
          : currentVideoContext(video).key === activeCapture.videoKey ? "complete" : "source_changed";
        stopCapture(activeCapture, reason);
      }
    });
    video.addEventListener("emptied", () => {
      if (activeCapture && activeCapture.video === video && !video.ended) {
        stopCapture(activeCapture, "source_changed");
      }
    });
    video.addEventListener("error", () => {
      if (activeCapture && activeCapture.video === video) stopCapture(activeCapture, "error");
    });
    if (!video.paused) onPlaying(video);
  }

  function scanVideos(root = document) {
    const videos = new Set();
    if (root instanceof HTMLVideoElement) videos.add(root);
    if (root.querySelectorAll) {
      for (const video of root.querySelectorAll("#movie_player video, video.html5-main-video, ytd-reel-video-renderer video")) {
        videos.add(video);
      }
    }
    for (const video of videos) watchVideo(video);
  }

  function setEnabled(enabled) {
    status.enabled = !!enabled;
    if (!status.enabled) {
      if (activeCapture) stopCapture(activeCapture, "disabled");
      status.state = "disabled";
      status.error = null;
    } else {
      status.state = activeCapture ? status.state : "armed";
      status.error = null;
      scanVideos();
    }
    return statusSnapshot();
  }

  function getStatus() {
    return statusSnapshot();
  }

  try {
    Object.defineProperty(globalThis, KEY, {
      value: Object.freeze({setEnabled, getStatus}),
      configurable: false,
      enumerable: false,
      writable: false
    });
  } catch (_) {}

  function beginYouTubeNavigation() {
    navigationInProgress = true;
    navigationSnapshot = activeCapture ? {
      video: activeCapture.video,
      videoKey: activeCapture.videoKey,
      mediaSource: activeCapture.video.currentSrc || activeCapture.mediaSource || ""
    } : null;
    if (activeCapture) stopCapture(activeCapture, "source_changed");
  }

  function finishYouTubeNavigation() {
    navigationInProgress = false;
    scanVideos();
    const outgoing = navigationSnapshot;
    navigationSnapshot = null;
    if (!outgoing) return;
    const videos = document.querySelectorAll("#movie_player video, video.html5-main-video, ytd-reel-video-renderer video");
    for (const candidate of videos) {
      if (!candidate.isConnected || candidate.paused || candidate.ended || !isPlayerVideo(candidate)) continue;
      const context = currentVideoContext(candidate);
      const source = String(candidate.currentSrc || candidate.src || "");
      if (context.key === outgoing.videoKey) continue;
      if (candidate === outgoing.video && source === outgoing.mediaSource) continue;
      onPlaying(candidate);
      break;
    }
  }

  // Split the outgoing recording before YouTube swaps its SPA page data.
  document.addEventListener("yt-navigate-start", beginYouTubeNavigation, true);
  document.addEventListener("yt-navigate-finish", finishYouTubeNavigation, true);
  document.addEventListener("yt-page-data-updated", () => {
    if (activeCapture && currentVideoContext(activeCapture.video).key !== activeCapture.videoKey) {
      stopCapture(activeCapture, "source_changed");
    }
  }, true);
  window.addEventListener("popstate", () => {
    beginYouTubeNavigation();
    queueMicrotask(finishYouTubeNavigation);
  });

  scanVideos();
  if (typeof MutationObserver === "function" && document.documentElement) {
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scanVideos(node);
        }
      }
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});
  }
})();