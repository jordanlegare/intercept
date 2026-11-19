(() => {
  "use strict";

  const HOST = "www.youtube.com";
  const ROOT_ID = "playback-capture-overlay-root";
  const CONTROLLER_KEY = "__playbackCaptureOverlayControllerV1";
  if (location.protocol !== "https:" || location.hostname.toLowerCase() !== HOST
      || (location.port && location.port !== "443")) return;

  const previous = globalThis[CONTROLLER_KEY];
  if (previous) {
    previous.open();
    return;
  }

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("aria-label", "Playback Capture dark overlay");
  root.style.cssText = "display:block;position:relative;width:100%;max-width:340px;z-index:2147483646;color-scheme:dark;";

  const shadow = root.attachShadow({mode: "open"});
  const css = [
    ":host{all:initial;display:block;color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#eef3e8}",
    "*{box-sizing:border-box}",
    ".panel{width:100%;min-width:260px;background:#11150f;color:#eef3e8;border:1px solid #3b4931;border-radius:9px;box-shadow:0 12px 36px rgba(0,0,0,.5);overflow:hidden;font-size:12px}",
    ".head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#171d14;border-bottom:1px solid #303b29}",
    ".mark{width:8px;height:8px;border-radius:50%;background:#baff60;box-shadow:0 0 10px #baff6066;flex:0 0 auto}",
    ".brand{flex:1;color:#baff60;font:800 10px ui-monospace,SFMono-Regular,monospace;letter-spacing:.13em}",
    ".ver{color:#839078;font:8px ui-monospace,SFMono-Regular,monospace}",
    ".icon{border:0;background:transparent;color:#aab69e;padding:3px 5px;cursor:pointer;font-size:16px;line-height:1}",
    ".body{padding:12px;background:#11150f}",
    ".eyebrow{color:#89977f;font:8px ui-monospace,SFMono-Regular,monospace;letter-spacing:.15em}",
    ".title{margin:5px 0 3px;color:#f2f6ec;font-size:14px;line-height:1.25;font-weight:750;overflow-wrap:anywhere}",
    ".identity{color:#829179;font:8px ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}",
    ".stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin:11px 0}",
    ".stat{padding:7px 6px;background:#20271c;border:1px solid #35412d;min-width:0}",
    ".stat span{display:block;color:#89967f;font:7px ui-monospace,SFMono-Regular,monospace;letter-spacing:.08em}",
    ".stat strong{display:block;margin-top:4px;color:#edf4e5;font:700 11px ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}",
    ".state{display:flex;align-items:center;gap:7px;min-height:22px;color:#c8d2be;font:9px ui-monospace,SFMono-Regular,monospace}",
    ".dot{width:7px;height:7px;border-radius:50%;background:#72816b;flex:0 0 auto}",
    ".dot.live{background:#baff60;box-shadow:0 0 9px #baff6080}",
    ".dot.error{background:#ff8273}",
    ".meter{height:3px;background:#303a2a;margin:7px 0 10px;overflow:hidden}",
    ".meter span{display:block;height:100%;width:0;background:#baff60;transition:width .2s}",
    ".controls{display:grid;grid-template-columns:1fr 1fr;gap:6px}",
    "button.action{min-height:30px;border:1px solid #46533d;border-radius:4px;background:#242d20;color:#e7efdc;padding:6px 7px;cursor:pointer;font:800 8px ui-monospace,SFMono-Regular,monospace;letter-spacing:.07em}",
    "button.action:hover:not(:disabled){border-color:#baff60;background:#2d3926}",
    "button.action:disabled{opacity:.32;cursor:not-allowed}",
    "button.primary{grid-column:span 2;background:#baff60;color:#14200c;border-color:#baff60}",
    "button.primary.armed{background:#47351f;border-color:#82613b;color:#ffe0ad}",
    "button.danger{color:#ffa99c;border-color:#70483e}",
    ".hint{margin:9px 0 0;color:#87947f;font-size:9px;line-height:1.4}",
    ".section{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:13px 0 6px;color:#baff60;font:800 8px ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em}",
    ".count{color:#87947f;font-weight:500}",
    ".history{max-height:190px;overflow:auto;border-top:1px solid #303a2a}",
    ".record{padding:8px 0;border-bottom:1px solid #283124}",
    ".record:last-child{border-bottom:0}",
    ".record-top{display:flex;justify-content:space-between;gap:8px;align-items:start}",
    ".record-title{min-width:0;color:#edf3e8;font-size:10px;font-weight:700;line-height:1.25;overflow-wrap:anywhere}",
    ".record-status{flex:0 0 auto;color:#b2c0a7;font:7px ui-monospace,SFMono-Regular,monospace;text-transform:uppercase}",
    ".record-meta{margin-top:4px;color:#85917c;font:7px ui-monospace,SFMono-Regular,monospace}",
    ".record-events{margin-top:4px;color:#a4b19a;font-size:8px;line-height:1.3;overflow-wrap:anywhere}",
    ".record-actions{display:flex;gap:5px;margin-top:5px}",
    ".record-actions button{border:1px solid #4d5b40;background:#222c1d;color:#d6e2ca;border-radius:3px;padding:4px 6px;font:700 7px ui-monospace,SFMono-Regular,monospace;cursor:pointer}",
    ".record-actions button.recover{color:#baff60}",
    ".empty{padding:9px 0;color:#87947f;font-size:9px;line-height:1.4}",
    ".notice{min-height:12px;margin-top:8px;color:#baff60;font:8px ui-monospace,SFMono-Regular,monospace;line-height:1.35;overflow-wrap:anywhere}",
    ".notice.error{color:#ff9d8f}",
    ".collapsed .body{display:none}",
    ".collapsed .panel{width:auto}",
    "a{color:#baff60;text-decoration:none}",
    "@media(prefers-reduced-motion:reduce){*{transition:none!important}}"
  ].join("\n");
  const markup = '<section class="panel">' +
    '<div class="head"><span class="mark"></span><span class="brand">PLAYBACK CAPTURE</span><span class="ver">1.2.0 · DARK</span>' +
    '<button class="icon" id="minimize" title="Minimize" aria-label="Minimize">−</button>' +
    '<button class="icon" id="close" title="Close overlay" aria-label="Close">×</button></div>' +
    '<div class="body">' +
    '<div class="eyebrow">CURRENT YOUTUBE VIDEO</div><div class="title" id="video-title">Connecting to YouTube…</div>' +
    '<div class="identity" id="video-id">Waiting for player metadata</div>' +
    '<div class="stats"><div class="stat"><span>ELAPSED</span><strong id="elapsed">00:00</strong></div>' +
    '<div class="stat"><span>SIZE</span><strong id="size">0 B</strong></div>' +
    '<div class="stat"><span>PLAYER</span><strong id="player-state">—</strong></div></div>' +
    '<div class="state"><span class="dot" id="dot"></span><span id="status">Connecting to capture manager…</span></div>' +
    '<div class="meter"><span id="meter-fill"></span></div>' +
    '<div class="controls"><button class="action primary" id="arm">ARM CAPTURE</button>' +
    '<button class="action" id="pause" disabled>PAUSE</button><button class="action" id="resume" disabled>RESUME</button>' +
    '<button class="action" id="split" disabled>SPLIT FILE</button><button class="action" id="stop" disabled>STOP &amp; SAVE</button>' +
    '<button class="action danger" id="discard" disabled>DISCARD</button></div>' +
    '<p class="hint">Dark, page-adjacent controls synchronized with YouTube playback. Switching videos creates a separate WebM.</p>' +
    '<div class="section"><span>CAPTURE TIMELINE</span><span class="count" id="history-count">0 RECORDS</span></div>' +
    '<div class="history" id="history"><div class="empty">Capture history will appear here.</div></div>' +
    '<div class="notice" id="notice" aria-live="polite"></div>' +
    '</div></section>';
  shadow.innerHTML = "<style>" + css + "</style>" + markup;

  const $ = id => shadow.getElementById(id);
  const controller = {dismissed: false, refresh: null, open: null};
  globalThis[CONTROLLER_KEY] = controller;

  function formatSize(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1073741824) return (value / 1073741824).toFixed(2) + " GiB";
    if (value >= 1048576) return (value / 1048576).toFixed(1) + " MiB";
    if (value >= 1024) return (value / 1024).toFixed(0) + " KiB";
    return value + " B";
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours
      ? [hours, minutes, remainder].map(value => String(value).padStart(2, "0")).join(":")
      : [minutes, remainder].map(value => String(value).padStart(2, "0")).join(":");
  }

  function formatClock(timestamp) {
    if (!timestamp) return "—";
    try { return new Date(timestamp).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }
    catch (_) { return "—"; }
  }

  function send(command, payload) {
    return browser.runtime.sendMessage({
      type: "playback-capture:overlay-command",
      command,
      payload
    }).then(response => {
      if (!response || !response.ok) throw new Error(response && response.error || "Capture manager did not respond.");
      return response.result;
    });
  }

  function setNotice(message, error = false) {
    $("notice").textContent = message || "";
    $("notice").classList.toggle("error", !!error);
  }

  function eventSummary(record) {
    return (record.events || []).slice(-3).map(event => {
      if (event.type === "recording_started") return "recording started";
      if (event.type === "recording_finalized") return "WebM finalized";
      if (event.type === "download_completed") return "download completed";
      if (event.type === "download_interrupted") return "download interrupted";
      if (event.type === "download_failed") return "download failed";
      if (event.type === "capture_interrupted_by_tab_close") return "tab closed unexpectedly";
      if (event.type === "paused") return "paused";
      if (event.type === "resumed") return "resumed";
      return String(event.type || "event").replace(/_/g, " ");
    }).join(" · ");
  }

  function renderHistory(records) {
    const container = $("history");
    container.replaceChildren();
    $("history-count").textContent = records.length + (records.length === 1 ? " RECORD" : " RECORDS");
    if (!records.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No captures yet. Arm capture before playback starts.";
      container.append(empty);
      return;
    }

    for (const record of records) {
      const item = document.createElement("div");
      item.className = "record";
      const top = document.createElement("div");
      top.className = "record-top";
      const title = document.createElement("div");
      title.className = "record-title";
      title.textContent = record.title || record.filename || "Untitled capture";
      const state = document.createElement("span");
      state.className = "record-status";
      state.textContent = String(record.status || "unknown").replace(/_/g, " ");
      top.append(title, state);

      const meta = document.createElement("div");
      meta.className = "record-meta";
      meta.textContent = formatClock(record.startedAt) + " · " + formatDuration(record.durationMs)
        + " · " + formatSize(record.bytes) + (record.videoId ? " · " + record.videoId : "");

      const events = document.createElement("div");
      events.className = "record-events";
      events.textContent = eventSummary(record);
      item.append(top, meta, events);

      const actions = document.createElement("div");
      actions.className = "record-actions";
      if (record.fileAvailable && ["download_failed", "failed", "completed"].includes(record.status)) {
        const recover = document.createElement("button");
        recover.className = "recover";
        recover.textContent = "RECOVER";
        recover.addEventListener("click", () => perform("recover", record.id, "Recovery download started."));
        actions.append(recover);
      }
      if (!["preparing", "recording", "finalizing"].includes(record.status)) {
        const remove = document.createElement("button");
        remove.textContent = "DELETE";
        remove.addEventListener("click", () => perform("delete", record.id, "History entry deleted."));
        actions.append(remove);
      }
      if (actions.childElementCount) item.append(actions);
      container.append(item);
    }
  }

  function renderSnapshot(snapshot) {
    const state = snapshot.status || {};
    const page = snapshot.video || {};
    $("video-title").textContent = page.title || state.video_title || "Waiting for video";
    $("video-id").textContent = page.videoId
      ? "VIDEO ID · " + page.videoId + " · " + (page.canonicalUrl || "")
      : "No video ID detected on this page";
    $("elapsed").textContent = formatDuration(state.elapsed_ms);
    $("size").textContent = formatSize(state.bytes_written);
    $("player-state").textContent = !page.hasPlayer ? "NO PLAYER"
      : page.ended ? "ENDED" : page.paused ? "PAUSED" : "PLAYING";
    $("dot").className = "dot " + (state.state === "error" || state.state === "download_failed"
      ? "error" : state.enabled || state.can_stop ? "live" : "");
    const labels = {
      disabled: "OFF · capture is disarmed",
      armed: "ARMED · waiting for playback",
      preparing: "PREPARING · opening video-specific storage",
      recording: "RECORDING · " + formatSize(state.bytes_written) + " written",
      paused: "PAUSED · " + formatSize(state.bytes_written) + " written",
      finalizing: "FINALIZING · flushing the last media chunk",
      download_started: "DOWNLOAD STARTED · " + (state.filename || "WebM"),
      download_failed: "DOWNLOAD FAILED · recording available for recovery",
      error: "ERROR · " + (state.error || "capture failed")
    };
    $("status").textContent = labels[state.state] || String(state.state || "Connecting").toUpperCase();

    $("arm").textContent = state.enabled ? "DISARM CAPTURE" : "ARM CAPTURE";
    $("arm").classList.toggle("armed", state.enabled);
    $("pause").disabled = !state.can_pause;
    $("resume").disabled = !state.can_resume;
    $("split").disabled = !state.can_split;
    $("stop").disabled = !state.can_stop;
    $("discard").disabled = !state.can_discard;
    $("meter-fill").style.width = state.enabled && (state.state === "recording" || state.state === "paused")
      ? "100%" : "0%";
    renderHistory(snapshot.history || []);
  }

  let refreshPending = false;
  let refreshTimer = null;
  async function refresh() {
    if (refreshPending || controller.dismissed) return;
    refreshPending = true;
    try {
      const snapshot = await send("snapshot");
      renderSnapshot(snapshot);
      if (snapshot.video && snapshot.video.videoId) {
        root.setAttribute("data-video-id", snapshot.video.videoId);
      }
      setNotice("");
    } catch (error) {
      $("dot").className = "dot error";
      $("status").textContent = "CONNECTION ERROR";
      setNotice(error && error.message || String(error), true);
    } finally {
      refreshPending = false;
    }
  }

  function scheduleRefresh() {
    if (controller.dismissed) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 220);
  }

  async function perform(command, payload, message) {
    try {
      await send(command, payload);
      setNotice(message || "Updated.");
      await refresh();
    } catch (error) {
      setNotice(error && error.message || String(error), true);
    }
  }

  $("arm").addEventListener("click", () => {
    const armed = $("arm").textContent === "DISARM CAPTURE";
    void perform("set", !armed, armed ? "Capture disarmed." : "Capture armed.");
  });
  $("pause").addEventListener("click", () => void perform("pause", null, "Recording paused."));
  $("resume").addEventListener("click", () => void perform("resume", null, "Recording resumed."));
  $("split").addEventListener("click", () => void perform("split", null, "Current file finalized; next file started."));
  $("stop").addEventListener("click", () => void perform("stop", null, "Recording stopped and saved."));
  $("discard").addEventListener("click", () => void perform("discard", null, "Recording discarded."));

  $("minimize").addEventListener("click", () => {
    root.classList.toggle("collapsed");
    $("minimize").textContent = root.classList.contains("collapsed") ? "+" : "−";
  });
  $("close").addEventListener("click", () => {
    controller.dismissed = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    root.remove();
  });

  function mountOverlay() {
    if (controller.dismissed || root.isConnected) return;
    const secondary = document.querySelector("#secondary-inner, #secondary");
    const below = document.querySelector("#below");
    const player = document.querySelector("#player-container-outer, #player-container");
    if (secondary) {
      secondary.prepend(root);
      root.style.cssText = "display:block;position:sticky;top:76px;width:100%;max-width:340px;margin:0 0 12px;z-index:2147483646;color-scheme:dark;";
    } else if (below) {
      below.prepend(root);
      root.style.cssText = "display:block;position:relative;width:min(100%,360px);margin:12px 0;z-index:2147483646;color-scheme:dark;";
    } else if (player && player.parentNode) {
      player.parentNode.insertBefore(root, player.nextSibling);
      root.style.cssText = "display:block;position:relative;width:min(100%,360px);margin:12px 0;z-index:2147483646;color-scheme:dark;";
    } else {
      (document.body || document.documentElement).append(root);
      root.style.cssText = "display:block;position:fixed;top:112px;right:20px;width:min(340px,calc(100vw - 24px));z-index:2147483646;color-scheme:dark;";
    }
  }

  controller.open = () => {
    controller.dismissed = false;
    root.classList.remove("collapsed");
    $("minimize").textContent = "−";
    mountOverlay();
    void refresh();
  };
  controller.refresh = refresh;

  mountOverlay();
  void refresh();

  const watched = new WeakSet();
  function attachPlayerListeners() {
    const videos = document.querySelectorAll("#movie_player video, video.html5-main-video, ytd-reel-video-renderer video");
    for (const video of videos) {
      if (watched.has(video)) continue;
      watched.add(video);
      for (const eventName of [
        "play", "playing", "pause", "ended", "emptied", "loadedmetadata",
        "durationchange", "ratechange", "seeking", "seeked", "timeupdate"
      ]) {
        video.addEventListener(eventName, scheduleRefresh);
      }
    }
  }

  for (const eventName of [
    "yt-navigate-start", "yt-navigate-finish", "yt-page-data-updated", "yt-player-updated"
  ]) {
    document.addEventListener(eventName, () => {
      mountOverlay();
      attachPlayerListeners();
      scheduleRefresh();
    }, true);
  }
  window.addEventListener("popstate", () => {
    mountOverlay();
    attachPlayerListeners();
    scheduleRefresh();
  });

  const observer = new MutationObserver(() => {
    mountOverlay();
    attachPlayerListeners();
    scheduleRefresh();
  });
  observer.observe(document.documentElement, {childList: true, subtree: true});
  window.setInterval(() => {
    mountOverlay();
    attachPlayerListeners();
    void refresh();
  }, 1200);
})();
