(() => {
  "use strict";

  const KEY = "__standalonePlaybackDownloadV1";
  const host = location.hostname.toLowerCase();
  if (location.protocol !== "https:" || !(host === "youtube.com" || host.endsWith(".youtube.com"))
      || (location.port && location.port !== "443")) return;
  if (globalThis[KEY]) return;

  const Core = globalThis.__standalonePlaybackCoreV1;
  if (!Core) {
    console.error("[Playback Capture] Core module is missing; reload the YouTube tab.");
    return;
  }

  const CACHE_DIRECTORY = "standalone-playback-downloads";
  const HISTORY_DATABASE = "standalone-playback-history";
  const HISTORY_STORE = "captures";
  const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;
  const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const DOWNLOADED_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;

  const status = {
    enabled: false, state: "disabled", bytes_written: 0, filename: null,
    error: null, mime_type: null, started_at_ms: null, completed_at_ms: null,
    video_id: null, video_title: null, canonical_url: null, elapsed_ms: 0
  };

  let activeCapture = null;
  let navigationInProgress = false;
  let navigationSnapshot = null;
  let historyDbPromise = null;
  const sessionManager = new Core.CaptureSessionManager();
  const pendingDownloads = new Map();
  const downloadIdToCapture = new Map();
  const watchedVideos = new WeakSet();


  function isBackgroundCaptureTab() {
    try { return new URL(location.href).searchParams.get("__playback_capture_job") === "1"; }
    catch (_) { return false; }
  }

  function withCaptureTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function randomId() {
    return globalThis.crypto && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function openHistoryDatabase() {
    if (historyDbPromise) return historyDbPromise;
    historyDbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("Firefox IndexedDB is unavailable; capture history cannot be stored."));
        return;
      }
      const request = indexedDB.open(HISTORY_DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          db.createObjectStore(HISTORY_STORE, {keyPath: "id"});
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open capture history."));
      request.onblocked = () => reject(new Error("Capture history database upgrade is blocked."));
    });
    return historyDbPromise;
  }

  async function putHistory(record) {
    const db = await openHistoryDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, "readwrite");
      tx.objectStore(HISTORY_STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error || new Error("Could not save capture history."));
      tx.onabort = () => reject(tx.error || new Error("Capture history write was aborted."));
    });
  }

  async function getHistoryRecord(id) {
    const db = await openHistoryDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(HISTORY_STORE, "readonly").objectStore(HISTORY_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read capture history."));
    });
  }

  async function listHistory() {
    const db = await openHistoryDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(HISTORY_STORE, "readonly").objectStore(HISTORY_STORE).getAll();
      request.onsuccess = () => resolve((request.result || []).sort((a, b) => b.startedAt - a.startedAt));
      request.onerror = () => reject(request.error || new Error("Could not list capture history."));
    });
  }

  async function patchHistory(id, patch, event) {
    const db = await openHistoryDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, "readwrite");
      const store = tx.objectStore(HISTORY_STORE);
      const request = store.get(id);
      let updated = null;
      request.onsuccess = () => {
        const current = request.result;
        if (!current) return;
        updated = {...current, ...patch, updatedAt: Date.now()};
        if (event) updated.events = [...(current.events || []), event];
        store.put(updated);
      };
      request.onerror = () => reject(request.error || new Error("Could not update capture history."));
      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(tx.error || new Error("Capture history update failed."));
      tx.onabort = () => reject(tx.error || new Error("Capture history update was aborted."));
    });
  }

  async function deleteHistoryRecord(id) {
    const db = await openHistoryDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, "readwrite");
      tx.objectStore(HISTORY_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Could not delete capture history."));
    });
  }

  async function getCaptureDirectory(create = false) {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
      throw new Error("Firefox temporary file storage is unavailable.");
    }
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(CACHE_DIRECTORY, {create});
  }

  async function removeCaptureFile(filename) {
    if (!filename) return;
    try {
      const directory = await getCaptureDirectory(false);
      await directory.removeEntry(filename);
    } catch (_) {}
  }

  async function captureFileExists(filename) {
    if (!filename) return false;
    try {
      const directory = await getCaptureDirectory(false);
      await directory.getFileHandle(filename);
      return true;
    } catch (_) { return false; }
  }

  async function cleanupExpiredCaptures() {
    try {
      const now = Date.now();
      const records = await listHistory();
      for (const record of records) {
        if (activeCapture && record.id === activeCapture.id) continue;
        const orphan = Core.reconcileInterruptedCapture(record.status, await captureFileExists(record.filename));
        if (orphan) {
          await patchHistory(record.id, {...orphan, endedAt: record.endedAt || now}, {
            type: "capture_interrupted_by_tab_close", at: now
          });
          continue;
        }
        const retentionBase = record.status === "downloaded"
          ? (record.downloadedAt || record.endedAt || record.startedAt)
          : (record.endedAt || record.startedAt);
        const age = now - Number(retentionBase || now);
        const removeDownloaded = record.status === "downloaded" && age > DOWNLOADED_FILE_RETENTION_MS;
        const removeExpired = age > HISTORY_RETENTION_MS;
        if ((removeDownloaded || removeExpired) && record.fileAvailable) {
          await removeCaptureFile(record.filename);
          await patchHistory(record.id, {fileAvailable: false}, {
            type: "temporary_copy_removed", at: now
          });
        }
        if (removeExpired) await patchHistory(record.id, {status: "expired"}, null);
      }
      const directory = await getCaptureDirectory(false);
      const known = new Set(records.map(record => record.filename));
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== "file" || !name.endsWith(".webm") || known.has(name)) continue;
        const file = await handle.getFile();
        if (now - file.lastModified > HISTORY_RETENTION_MS) await directory.removeEntry(name);
      }
    } catch (_) {}
  }

  function requestBrowserDownload(file, filename, captureId) {
    const requestId = randomId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingDownloads.delete(requestId);
        reject(new Error("The one-at-a-time Firefox download queue did not acknowledge this file within six hours."));
      }, 6 * 60 * 60 * 1000);
      pendingDownloads.set(requestId, {resolve, reject, timeout, captureId});
      window.postMessage({
        type: "standalone-playback-download:request",
        request_id: requestId,
        capture_id: captureId,
        filename,
        blob: file
      }, location.origin);
    });
  }

  async function handleDownloadFinished(data) {
    const captureId = data.capture_id || downloadIdToCapture.get(data.download_id);
    if (!captureId) return;
    downloadIdToCapture.delete(data.download_id);
    const completed = data.download_state === "complete";
    try {
      await patchHistory(captureId, {
        status: completed ? "downloaded" : "download_failed",
        downloadedAt: completed ? Date.now() : null,
        downloadId: data.download_id || null,
        error: completed ? null : "Firefox interrupted the download. The temporary recording is available to retry.",
        fileAvailable: true
      }, {
        type: completed ? "download_completed" : "download_interrupted",
        at: Date.now()
      });
    } catch (_) {}
    if (completed) {
      setTimeout(async () => {
        const record = await getHistoryRecord(captureId).catch(() => null);
        if (!record || record.status !== "downloaded") return;
        await removeCaptureFile(record.filename);
        await patchHistory(captureId, {fileAvailable: false}, {
          type: "temporary_copy_removed", at: Date.now()
        }).catch(() => {});
      }, DOWNLOADED_FILE_RETENTION_MS);
    }
  }

  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin
        || !data || data.type !== "standalone-playback-download:result") return;
    if (typeof data.request_id === "string" && typeof data.ok === "boolean") {
      const pending = pendingDownloads.get(data.request_id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingDownloads.delete(data.request_id);
        if (data.ok) {
          downloadIdToCapture.set(data.download_id, pending.captureId);
          pending.resolve(data);
        } else {
          pending.reject(new Error(data.error || "Firefox could not start the download."));
        }
      }
    }
    if (data.download_state) void handleDownloadFinished(data);
  });

  function statusSnapshot() {
    const session = sessionManager.snapshot();
    return {
      ...status,
      elapsed_ms: session ? session.elapsedMs : status.elapsed_ms,
      capture_id: activeCapture ? activeCapture.id : null,
      session_state: session ? session.state : null,
      can_pause: !!(activeCapture && activeCapture.recorder && activeCapture.recorder.state === "recording"),
      can_resume: !!(activeCapture && activeCapture.recorder && activeCapture.recorder.state === "paused"),
      can_stop: !!activeCapture,
      can_split: !!activeCapture && status.state !== "preparing",
      can_discard: !!activeCapture
    };
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

  function currentVideoContext(video, titleOverride) {
    const heading = document.querySelector("h1.ytd-watch-metadata, ytd-watch-metadata h1");
    const title = titleOverride || (heading && heading.textContent && heading.textContent.trim()
      ? heading.textContent.trim()
      : document.title);
    return Core.buildVideoIdentity({
      href: location.href,
      title,
      mediaSource: video && (video.currentSrc || video.src) || "",
      at: new Date()
    });
  }

  async function openCaptureFile(filename) {
    const directory = await getCaptureDirectory(true);
    const fileHandle = await directory.getFileHandle(filename, {create: true});
    const writable = await fileHandle.createWritable({keepExistingData: false});
    return {directory, fileHandle, writer: writable.getWriter()};
  }

  function supportedMimeType() {
    if (typeof MediaRecorder === "undefined") return null;
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || null;
  }

  function appendEvent(capture, type, extra = {}) {
    void patchHistory(capture.id, {}, {type, at: Date.now(), ...extra}).catch(error => {
      console.warn("[Playback Capture] Could not persist timeline event:", error);
    });
  }

  function stopCapture(capture, reason) {
    if (!capture || capture.stopRequested) return;
    capture.stopRequested = true;
    capture.stopReason = reason;
    capture.finalSession = sessionManager.finish(reason, Date.now());
    if (capture.finalSession) status.elapsed_ms = capture.finalSession.elapsedMs;
    appendEvent(capture, "capture_stopping", {reason});
    if (capture.recorder && capture.recorder.state !== "inactive") {
      try { capture.recorder.stop(); }
      catch (error) {
        capture.writeError = capture.writeError || String(error && error.message || error);
        void finalizeCapture(capture);
      }
    } else if (capture.preparationFinished) {
      void finalizeCapture(capture);
    }
  }

  function queueChunk(capture, blob) {
    if (!blob || blob.size === 0 || capture.finalized) return;
    if (capture.bytesWritten + blob.size > capture.maxBytes) {
      capture.writeError = "The temporary playback capture reached its available-storage safety limit.";
      stopCapture(capture, "error");
      return;
    }
    capture.bytesWritten += blob.size;
    if (activeCapture === capture) status.bytes_written = capture.bytesWritten;
    capture.chunkWriter.enqueue(blob).catch(error => {
      capture.writeError = String(error && error.message || error || "Could not write playback cache.");
      stopCapture(capture, "error");
    });
  }

  async function finalizeCapture(capture) {
    if (!capture || capture.finalized) return;
    capture.finalized = true;
    if (activeCapture === capture) status.state = "finalizing";
    try {
      const shouldSave = !capture.writeError && Core.shouldSaveStopReason(capture.stopReason);
      if (capture.chunkWriter) {
        if (!shouldSave) {
          await capture.chunkWriter.abort(capture.writeError || "Capture discarded.");
        } else {
          await capture.chunkWriter.close();
          capture.writerClosed = true;
        }
      }
      if (capture.stream) {
        for (const track of capture.stream.getTracks()) {
          try { track.stop(); } catch (_) {}
        }
      }

      if (!shouldSave) {
        await removeCaptureFile(capture.filename);
        await patchHistory(capture.id, {
          status: capture.writeError ? "failed" : "discarded",
          error: capture.writeError || null,
          endedAt: Date.now(),
          durationMs: capture.finalSession ? capture.finalSession.elapsedMs : 0,
          bytes: capture.bytesWritten,
          fileAvailable: false
        }, {type: capture.writeError ? "capture_failed" : "capture_discarded", at: Date.now()});
        if (activeCapture === capture) {
          status.state = capture.writeError ? "error" : (status.enabled ? "armed" : "disabled");
          status.error = capture.writeError || null;
          status.filename = null;
        }
        return;
      }

      if (!capture.fileHandle) throw new Error("Capture storage was not ready before recording stopped.");
      const file = await capture.fileHandle.getFile();
      if (file.size === 0) {
        await removeCaptureFile(capture.filename);
        await patchHistory(capture.id, {
          status: "discarded", endedAt: Date.now(), bytes: 0, fileAvailable: false
        }, {type: "empty_capture_removed", at: Date.now()});
        if (activeCapture === capture) status.state = status.enabled ? "armed" : "disabled";
        return;
      }

      capture.endedAt = Date.now();
      await patchHistory(capture.id, {
        status: "completed",
        endedAt: capture.endedAt,
        durationMs: capture.finalSession ? capture.finalSession.elapsedMs : 0,
        bytes: file.size,
        fileAvailable: true,
        error: null
      }, {type: "recording_finalized", at: capture.endedAt, reason: capture.stopReason});

      try {
        const download = await requestBrowserDownload(file, capture.filename, capture.id);
        await patchHistory(capture.id, {
          status: "downloading",
          downloadId: download.download_id,
          fileAvailable: true
        }, {type: "download_started", at: Date.now()});
        if (activeCapture === capture) {
          status.state = "download_started";
          status.bytes_written = file.size;
          status.filename = capture.filename;
          status.error = null;
          status.completed_at_ms = Date.now();
        }
      } catch (downloadError) {
        const message = String(downloadError && downloadError.message || downloadError);
        await patchHistory(capture.id, {
          status: "download_failed", error: message, fileAvailable: true
        }, {type: "download_failed", at: Date.now(), error: message});
        if (activeCapture === capture) {
          status.state = "download_failed";
          status.filename = capture.filename;
          status.error = message;
        }
      }
    } catch (error) {
      const message = String(error && error.message || error || "Playback capture failed.");
      if (!capture.writerClosed) await removeCaptureFile(capture.filename);
      await patchHistory(capture.id, {
        status: "failed", error: message, endedAt: Date.now(),
        durationMs: capture.finalSession ? capture.finalSession.elapsedMs : 0,
        bytes: capture.bytesWritten, fileAvailable: !!capture.writerClosed
      }, {type: "capture_failed", at: Date.now(), error: message}).catch(() => {});
      if (activeCapture === capture) {
        status.state = "error";
        status.error = message;
        status.filename = capture.writerClosed ? capture.filename : null;
      }
    } finally {
      if (activeCapture === capture) activeCapture = null;
      if (capture.resolveFinished) capture.resolveFinished();
    }
  }

  async function startCapture(video, titleOverride) {
    if (activeCapture) return activeCapture.video === video ? statusSnapshot() : null;
    if (!status.enabled || navigationInProgress || !video || !video.isConnected || video.ended || isAdvertisement(video)) return null;
    const identity = currentVideoContext(video, titleOverride);
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

    const startedAt = Date.now();
    const capture = {
      id: randomId(), video, identity, recorder: null, stream: null,
      writer: null, chunkWriter: null, fileHandle: null, directory: null,
      filename: identity.filename, videoKey: identity.key,
      videoId: identity.videoId, videoTitle: identity.title,
      canonicalUrl: identity.canonicalUrl, mimeType,
      bytesWritten: 0, maxBytes: MAX_CAPTURE_BYTES,
      writeError: null,
      stopReason: null, stopRequested: false, finalized: false,
      preparationFinished: false, writerClosed: false,
      manualPaused: false, playerPaused: false,
      startedAt, endedAt: null, finalSession: null,
      resolveFinished: null
    };
    capture.finished = new Promise(resolve => { capture.resolveFinished = resolve; });
    capture.session = sessionManager.begin(identity, startedAt);
    capture.historyRecord = {
      id: capture.id, sessionId: capture.session.id,
      videoId: identity.videoId, title: identity.title,
      canonicalUrl: identity.canonicalUrl, filename: identity.filename,
      mimeType, status: "preparing", startedAt, endedAt: null,
      durationMs: 0, bytes: 0, fileAvailable: false,
      downloadId: null, error: null,
      events: [{type: "capture_preparing", at: startedAt}]
    };
    activeCapture = capture;
    status.state = "preparing";
    status.bytes_written = 0;
    status.filename = capture.filename;
    status.error = null;
    status.mime_type = mimeType;
    status.started_at_ms = startedAt;
    status.completed_at_ms = null;
    status.video_id = identity.videoId;
    status.video_title = identity.title;
    status.canonical_url = identity.canonicalUrl;
    status.elapsed_ms = 0;

    try {
      await putHistory(capture.historyRecord);
      const estimate = await navigator.storage.estimate();
      if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
        const available = Math.max(0, estimate.quota - estimate.usage);
        capture.maxBytes = Math.min(MAX_CAPTURE_BYTES, Math.floor(available * 0.8));
        if (capture.maxBytes < 16 * 1024 * 1024) {
          throw new Error("Not enough available browser storage for a video capture.");
        }
      }
      if (!status.enabled || activeCapture !== capture || capture.stopRequested || navigationInProgress
          || !Core.sameVideoIdentity(currentVideoContext(video), identity) || video.ended || !video.isConnected) {
        capture.preparationFinished = true;
        if (!capture.stopRequested) {
          capture.stopRequested = true;
          capture.stopReason = "disabled";
          capture.finalSession = sessionManager.finish("disabled", Date.now());
        }
        void finalizeCapture(capture);
        return;
      }

      const opened = await openCaptureFile(capture.filename);
      capture.directory = opened.directory;
      capture.fileHandle = opened.fileHandle;
      capture.writer = opened.writer;
      capture.chunkWriter = new Core.SerializedChunkWriter(opened.writer);
      await patchHistory(capture.id, {fileAvailable: true}, {type: "temporary_file_opened", at: Date.now()});

      if (!status.enabled || activeCapture !== capture || capture.stopRequested || navigationInProgress
          || !Core.sameVideoIdentity(currentVideoContext(video), identity) || video.ended || !video.isConnected) {
        capture.preparationFinished = true;
        if (!capture.stopRequested) {
          capture.stopRequested = true;
          capture.stopReason = "disabled";
          capture.finalSession = sessionManager.finish("disabled", Date.now());
        }
        void finalizeCapture(capture);
        return;
      }

      capture.stream = captureMethod();
      if (!capture.stream.getVideoTracks().length) {
        throw new Error("The player did not expose a capturable video track.");
      }
      capture.recorder = new MediaRecorder(capture.stream, {
        mimeType,
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
      status.mime_type = mimeType;
      appendEvent(capture, "recording_started", {mimeType});
      await patchHistory(capture.id, {status: "recording", mimeType}, null);
      return statusSnapshot();
    } catch (error) {
      capture.writeError = String(error && error.message || error || "Could not start playback capture.");
      capture.preparationFinished = true;
      if (!capture.stopRequested) {
        capture.stopRequested = true;
        capture.stopReason = "error";
        capture.finalSession = sessionManager.finish("error", Date.now());
      }
      void finalizeCapture(capture);
      return statusSnapshot();
    }
  }

  function resumeFromPlayer(video) {
    if (!activeCapture || activeCapture.video !== video || !activeCapture.playerPaused) return;
    if (activeCapture.recorder && activeCapture.recorder.state === "paused" && !activeCapture.manualPaused) {
      try {
        activeCapture.recorder.resume();
        activeCapture.playerPaused = false;
        sessionManager.resume(Date.now(), "player");
        status.state = "recording";
        appendEvent(activeCapture, "resumed", {source: "player"});
      } catch (_) {}
    }
  }

  function onPlaying(video) {
    if (!isPlayerVideo(video) || isAdvertisement(video) || !status.enabled || navigationInProgress) return;
    const incomingIdentity = currentVideoContext(video);
    if (activeCapture) {
      const previous = activeCapture;
      const sameVideo = previous.video === video && Core.sameVideoIdentity(previous.identity, incomingIdentity);
      if (sameVideo && !previous.stopRequested) {
        resumeFromPlayer(video);
        return;
      }
      stopCapture(previous, "source_changed");
      void previous.finished.then(() => {
        if (status.enabled && !navigationInProgress && !video.paused && !video.ended
            && video.isConnected && Core.sameVideoIdentity(currentVideoContext(video), incomingIdentity)) {
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
        try {
          activeCapture.recorder.pause();
          activeCapture.playerPaused = true;
          sessionManager.pause(Date.now(), "player");
          status.state = "paused";
          appendEvent(activeCapture, "paused", {source: "player"});
        } catch (_) {}
      }
    });
    video.addEventListener("ended", () => {
      if (activeCapture && activeCapture.video === video) {
        const reason = isAdvertisement(video)
          ? "ad"
          : Core.sameVideoIdentity(currentVideoContext(video), activeCapture.identity) ? "complete" : "source_changed";
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
  }

  function scanVideos(root = document) {
    const videos = new Set();
    if (root instanceof HTMLVideoElement) videos.add(root);
    if (root.querySelectorAll) {
      for (const video of root.querySelectorAll("#movie_player video, video.html5-main-video, ytd-reel-video-renderer video")) {
        videos.add(video);
      }
    }
    for (const video of videos) {
      watchVideo(video);
      if (!video.paused) onPlaying(video);
    }
  }

  function pauseCapture() {
    if (!activeCapture || !activeCapture.recorder || activeCapture.recorder.state !== "recording") {
      throw new Error("There is no active recording to pause.");
    }
    activeCapture.recorder.pause();
    activeCapture.manualPaused = true;
    activeCapture.playerPaused = false;
    sessionManager.pause(Date.now(), "manual");
    status.state = "paused";
    appendEvent(activeCapture, "paused", {source: "manual"});
    return statusSnapshot();
  }

  function resumeCapture() {
    if (!activeCapture || !activeCapture.recorder || activeCapture.recorder.state !== "paused") {
      throw new Error("There is no paused recording to resume.");
    }
    activeCapture.recorder.resume();
    activeCapture.manualPaused = false;
    activeCapture.playerPaused = false;
    sessionManager.resume(Date.now(), "manual");
    status.state = "recording";
    appendEvent(activeCapture, "resumed", {source: "manual"});
    return statusSnapshot();
  }

  async function splitCapture() {
    if (!activeCapture) throw new Error("There is no active recording to split.");
    const previous = activeCapture;
    const video = previous.video;
    const identity = previous.identity;
    stopCapture(previous, "split");
    await previous.finished;
    if (status.enabled && !video.paused && !video.ended && video.isConnected
        && Core.sameVideoIdentity(currentVideoContext(video), identity)) {
      await startCapture(video);
    }
    return statusSnapshot();
  }

  function stopAndSave() {
    if (!activeCapture) throw new Error("There is no active recording to stop.");
    status.enabled = false;
    stopCapture(activeCapture, "manual_stop");
    return statusSnapshot();
  }

  function discardCapture() {
    if (!activeCapture) throw new Error("There is no active recording to discard.");
    stopCapture(activeCapture, "discard");
    return statusSnapshot();
  }

  async function recoverCapture(id) {
    const record = await getHistoryRecord(id);
    if (!record) throw new Error("Capture history entry was not found.");
    if (!record.fileAvailable || !(await captureFileExists(record.filename))) {
      throw new Error("The recovery file is no longer available in temporary storage.");
    }
    const directory = await getCaptureDirectory(false);
    const handle = await directory.getFileHandle(record.filename);
    const file = await handle.getFile();
    const result = await requestBrowserDownload(file, record.filename, record.id);
    await patchHistory(record.id, {
      status: "downloading", downloadId: result.download_id, error: null, fileAvailable: true
    }, {type: "recovery_download_started", at: Date.now()});
    return {ok: true, download_id: result.download_id};
  }

  async function deleteCapture(id) {
    const record = await getHistoryRecord(id);
    if (!record) return {ok: false};
    await removeCaptureFile(record.filename);
    await deleteHistoryRecord(id);
    return {ok: true};
  }

  async function getHistory() {
    const records = await listHistory();
    return records.slice(0, 30).map(record => ({...record, events: (record.events || []).slice(-12)}));
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


  async function waitForPlayerVideo(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const video = document.querySelector("#movie_player video.html5-main-video, #movie_player video, video.html5-main-video, ytd-reel-video-renderer video");
      if (video && video.isConnected && video.readyState >= 1) return video;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("YouTube did not create a playable video element within 30 seconds.");
  }

  async function waitForAdvertisementToFinish(video, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let currentVideo = video;
    let playerApi = null;
    const bridge = globalThis.__standaloneYouTubePlayerApiV1;
    while (Date.now() < deadline) {
      if (!currentVideo || !currentVideo.isConnected) {
        currentVideo = await waitForPlayerVideo(Math.min(10000, Math.max(1000, deadline - Date.now())));
        playerApi = null;
      }
      if (!isAdvertisement(currentVideo)) return currentVideo;
      if (!bridge) throw new Error("The YouTube player API adapter is missing while waiting for the advertisement to finish.");
      if (!playerApi) playerApi = await bridge.waitForPlayerApi(document, "", 20000);
      if (currentVideo.paused || currentVideo.ended) {
        // Let a pre-roll ad play out before MediaRecorder attaches to the
        // selected video's decoded playback stream.
        await bridge.startPlayback(playerApi, currentVideo, {timeoutMs:12000});
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("YouTube's advertisement did not finish within 90 seconds. The helper tab is retained so this selection can be retried.");
  }

  async function startYouTubePlayback(video, videoId) {
    const bridge = globalThis.__standaloneYouTubePlayerApiV1;
    if (!bridge) throw new Error("The YouTube player API adapter is missing; reload the helper tab.");
    const api = await bridge.waitForPlayerApi(document, videoId, 30000);
    try {
      await bridge.startPlayback(api, video, {timeoutMs: 15000});
    } catch (error) {
      const detail = String(error && error.message || error || "Playback was rejected.");
      if (/NotAllowedError|autoplay/i.test(detail)) {
        throw new Error(
          "Firefox blocked automatic YouTube playback (NotAllowedError). " +
          "Allow Audio and Video for youtube.com in Firefox Settings > Privacy & Security > Permissions > Autoplay. " + detail
        );
      }
      throw new Error("YouTube's native player API could not start playback: " + detail);
    }
  }

  async function recordRequestedVideo(payload) {
    const videoId = String(payload && payload.videoId || "");
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(videoId) || Core.extractVideoId(location.href) !== videoId) {
      throw new Error("The background player loaded a different video than the one selected.");
    }
    const title = String(payload && payload.title || "").trim().slice(0, 180);
    status.enabled = true;
    status.error = null;
    let video = await waitForPlayerVideo();
    video = await waitForAdvertisementToFinish(video);
    if (video.paused || video.ended) await startYouTubePlayback(video, videoId);
    if (video.paused || video.ended) {
      throw new Error("YouTube's player API returned without starting the selected video.");
    }
    try {
      if (!activeCapture) {
        await withCaptureTimeout(
          startCapture(video, title),
          20000,
          "The recorder did not initialize within 20 seconds. Check Firefox storage and MediaRecorder support."
        );
      }
    } catch (error) {
      throw new Error("Recorder startup failed: " + String(error && error.message || error));
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (activeCapture && activeCapture.video === video
          && activeCapture.recorder && activeCapture.recorder.state === "recording") return statusSnapshot();
      if (status.state === "error") throw new Error(status.error || "The recorder could not start.");
      if (!video.isConnected) throw new Error("The YouTube player was replaced before recording began.");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error("The video did not enter the recording state. Check autoplay permissions and retry.");
  }

  async function getDashboardSnapshot() {
    const video = document.querySelector("#movie_player video.html5-main-video, #movie_player video, video.html5-main-video, ytd-reel-video-renderer video");
    const heading = document.querySelector("h1.ytd-watch-metadata, ytd-watch-metadata h1");
    const title = heading && heading.textContent && heading.textContent.trim()
      ? heading.textContent.trim()
      : document.title.replace(/\s+-\s+YouTube\s*$/i, "");
    const identity = Core.buildVideoIdentity({
      href: location.href,
      title,
      mediaSource: video && (video.currentSrc || video.src) || "",
      at: new Date()
    });
    const history = await getHistory().catch(error => [{
      id: "history-error",
      title: "Capture history unavailable",
      status: "error",
      error: String(error && error.message || error),
      fileAvailable: false,
      events: []
    }]);
    return {
      status: statusSnapshot(),
      video: {
        title: identity.title,
        videoId: identity.videoId,
        canonicalUrl: identity.canonicalUrl,
        href: location.href,
        paused: video ? video.paused : true,
        ended: video ? video.ended : false,
        currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: video && Number.isFinite(video.duration) ? video.duration : 0,
        playbackRate: video ? video.playbackRate : 1,
        hasPlayer: !!video
      },
      history
    };
  }

  async function runCommand(command, payload) {
    switch (command) {
      case "snapshot": return getDashboardSnapshot();
      case "record-video": return recordRequestedVideo(payload);
      case "get": return statusSnapshot();
      case "set": return setEnabled(!!payload);
      case "pause": return pauseCapture();
      case "resume": return resumeCapture();
      case "split": return splitCapture();
      case "stop": return stopAndSave();
      case "discard": return discardCapture();
      case "history": return getHistory();
      case "recover": return recoverCapture(String(payload || ""));
      case "delete": return deleteCapture(String(payload || ""));
      default: throw new Error("Unknown Playback Capture command: " + command);
    }
  }

  Object.defineProperty(globalThis, KEY, {
    value: Object.freeze({runCommand, getStatus: statusSnapshot, setEnabled, getHistory}),
    configurable: false, enumerable: false, writable: false
  });

  function beginYouTubeNavigation() {
    navigationInProgress = true;
    navigationSnapshot = activeCapture ? {
      video: activeCapture.video,
      videoKey: activeCapture.videoKey,
      mediaSource: activeCapture.video.currentSrc || activeCapture.identity.mediaSource || ""
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
      const identity = currentVideoContext(candidate);
      const source = String(candidate.currentSrc || candidate.src || "");
      if (identity.key === outgoing.videoKey) continue;
      if (candidate === outgoing.video && source === outgoing.mediaSource) continue;
      onPlaying(candidate);
      break;
    }
  }

  document.addEventListener("yt-navigate-start", beginYouTubeNavigation, true);
  document.addEventListener("yt-navigate-finish", finishYouTubeNavigation, true);
  document.addEventListener("yt-page-data-updated", () => {
    if (activeCapture && !Core.sameVideoIdentity(currentVideoContext(activeCapture.video), activeCapture.identity)) {
      stopCapture(activeCapture, "source_changed");
    }
  }, true);
  window.addEventListener("popstate", () => {
    beginYouTubeNavigation();
    queueMicrotask(finishYouTubeNavigation);
  });

  scanVideos();
  void cleanupExpiredCaptures();
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
