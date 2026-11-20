"use strict";

const byId = id => document.getElementById(id);
const armButton = byId("arm-button");
const pauseButton = byId("pause-button");
const resumeButton = byId("resume-button");
const splitButton = byId("split-button");
const stopButton = byId("stop-button");
const discardButton = byId("discard-button");
const targetDot = byId("target-dot");
const targetState = byId("target-state");
const targetDetail = byId("target-detail");
const statusDot = byId("status-dot");
const captureStatus = byId("capture-status");
const meterFill = byId("meter-fill");
const videoTitle = byId("video-title");
const videoId = byId("video-id");
const elapsed = byId("elapsed");
const elapsedStat = byId("elapsed-stat");
const stats = byId("stats");
const fileSize = byId("file-size");
const mimeType = byId("mime-type");
const timeline = byId("timeline");
const historyEmpty = byId("history-empty");
const historyCount = byId("history-count");
const notice = byId("notice");

let activeTab = null;
let currentStatus = null;
let refreshing = false;
let actionPending = false;

function isYouTubeTab(tab) {
  try {
    const url = new URL(tab && tab.url || "");
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "youtube.com" || host.endsWith(".youtube.com"));
  } catch (_) { return false; }
}

async function executePageCommand(command, payload) {
  if (!activeTab || !Number.isInteger(activeTab.id)) throw new Error("Firefox could not identify the active tab.");
  const results = await browser.scripting.executeScript({
    target: {tabId: activeTab.id},
    world: "MAIN",
    func: async function(action, value) {
      const api = globalThis.__standalonePlaybackDownloadV1;
      if (!api) return {state:"unavailable",error:"Capture script is not ready. Reload this YouTube tab and reopen Playback Capture."};
      return api.runCommand(action, value);
    },
    args: [command, payload]
  });
  const result = results && results[0] && results[0].result;
  if (!result) throw new Error("The active tab did not return a result.");
  if (result.state === "unavailable") throw new Error(result.error || "Playback capture is unavailable.");
  return result;
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1073741824) return (value / 1073741824).toFixed(2) + " GiB";
  if (value >= 1048576) return (value / 1048576).toFixed(1) + " MiB";
  if (value >= 1024) return (value / 1024).toFixed(0) + " KiB";
  return value + " B";
}

function formatDuration(milliseconds) {
  const total = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? [hours, minutes, seconds].map(v => String(v).padStart(2, "0")).join(":")
    : [minutes, seconds].map(v => String(v).padStart(2, "0")).join(":");
}

function shouldShowElapsed(status) {
  return ["recording", "paused", "finalizing", "download_started", "download_failed"].includes(status && status.state)
    || Number(status && status.elapsed_ms || 0) > 0
    || Number(status && status.bytes_written || 0) > 0;
}

function formatTime(timestamp) {
  if (!timestamp) return "—";
  try { return new Date(timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); }
  catch (_) { return "—"; }
}

function showNotice(message, isError = false) {
  notice.textContent = message || "";
  notice.classList.toggle("error", !!isError);
}

function renderStatus(status) {
  currentStatus = status;
  const enabled = status.enabled === true;
  const isActive = status.can_stop === true;
  armButton.disabled = actionPending || !activeTab;
  armButton.textContent = enabled ? "DISARM CAPTURE" : "ARM CAPTURE";
  armButton.classList.toggle("armed", enabled);
  pauseButton.disabled = actionPending || !status.can_pause;
  resumeButton.disabled = actionPending || !status.can_resume;
  splitButton.disabled = actionPending || !status.can_split;
  stopButton.disabled = actionPending || !isActive;
  discardButton.disabled = actionPending || !status.can_discard;

  statusDot.className = "status-dot " + (status.state === "error" || status.state === "download_failed"
    ? "bad" : (enabled || isActive) ? "good" : "");
  meterFill.style.width = enabled && (status.state === "recording" || status.state === "paused")
    ? "100%" : "0%";
  videoTitle.textContent = status.video_title || "No active video";
  videoId.textContent = status.video_id ? "YOUTUBE ID · " + status.video_id : "Video identity will appear when capture starts.";
  const showElapsed = shouldShowElapsed(status);
  elapsedStat.hidden = !showElapsed;
  stats.classList.toggle("without-elapsed", !showElapsed);
  elapsed.textContent = formatDuration(status.elapsed_ms);
  fileSize.textContent = formatSize(status.bytes_written);
  mimeType.textContent = String(status.mime_type || "WEBM").toUpperCase();

  const size = formatSize(status.bytes_written);
  switch (status.state) {
    case "armed": captureStatus.textContent = "ARMED · waiting for video playback."; break;
    case "preparing": captureStatus.textContent = "PREPARING · opening a new video-specific file."; break;
    case "recording": captureStatus.textContent = "RECORDING · " + size + " written."; break;
    case "paused": captureStatus.textContent = "PAUSED · " + size + " written."; break;
    case "finalizing": captureStatus.textContent = "FINALIZING · flushing the last recording chunk."; break;
    case "download_started": captureStatus.textContent = "DOWNLOAD STARTED · " + (status.filename || "playback.webm"); break;
    case "download_failed": captureStatus.textContent = "DOWNLOAD FAILED · recording retained for recovery."; break;
    case "error": captureStatus.textContent = "ERROR · " + (status.error || "Playback capture failed."); break;
    case "disabled": captureStatus.textContent = "OFF · no playback is being captured."; break;
    default: captureStatus.textContent = String(status.state || "unknown").toUpperCase();
  }
}

function eventLabel(event) {
  const labels = {
    capture_preparing:"Preparing file",
    recording_started:"Recording started",
    paused:"Paused" + (event.source === "player" ? " by player" : ""),
    resumed:"Resumed",
    capture_stopping:"Capture stopped · " + (event.reason || "unknown"),
    recording_finalized:"WebM finalized",
    download_started:"Firefox download started",
    download_completed:"Download completed",
    download_interrupted:"Download interrupted",
    download_failed:"Download failed",
    recovery_download_started:"Recovery download started",
    capture_discarded:"Recording discarded",
    capture_failed:"Capture failed",
    temporary_copy_removed:"Temporary recovery copy expired"
  };
  return labels[event.type] || String(event.type || "Event").replace(/_/g, " ");
}

function renderHistory(records) {
  timeline.replaceChildren();
  historyCount.textContent = records.length + (records.length === 1 ? " ITEM" : " ITEMS");
  historyEmpty.hidden = records.length > 0;
  if (!records.length) return;

  for (const record of records) {
    const item = document.createElement("li");
    item.className = "timeline-item";
    const titleRow = document.createElement("div");
    titleRow.className = "timeline-title";
    const title = document.createElement("strong");
    title.textContent = record.title || record.filename || "Untitled capture";
    const state = document.createElement("span");
    state.className = "history-status";
    state.textContent = String(record.status || "unknown").replace(/_/g, " ");
    titleRow.append(title, state);

    const meta = document.createElement("div");
    meta.className = "timeline-meta";
    meta.textContent = formatTime(record.startedAt) + " · " + formatDuration(record.durationMs)
      + " · " + formatSize(record.bytes) + (record.videoId ? " · " + record.videoId : "");

    const events = document.createElement("div");
    events.className = "event-line";
    events.textContent = (record.events || []).slice(-4).map(eventLabel).join("  →  ");

    item.append(titleRow, meta, events);
    const actions = document.createElement("div");
    actions.className = "history-actions";
    if (record.fileAvailable && ["download_failed","failed","completed"].includes(record.status)) {
      const recover = document.createElement("button");
      recover.className = "recover";
      recover.type = "button";
      recover.textContent = "RECOVER DOWNLOAD";
      recover.addEventListener("click", () => perform("recover", record.id, "Recovery download started."));
      actions.append(recover);
    }
    if (!["preparing","recording","finalizing"].includes(record.status)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "DELETE";
      remove.addEventListener("click", () => perform("delete", record.id, "Capture removed from history."));
      actions.append(remove);
    }
    if (actions.childElementCount) item.append(actions);
    timeline.append(item);
  }
}

async function perform(command, payload, successMessage) {
  if (actionPending) return;
  actionPending = true;
  try {
    const result = await executePageCommand(command, payload);
    if (command === "history") renderHistory(result);
    else if (command === "delete") await refreshHistory();
    else if (command !== "get") {
      if (result && result.state) renderStatus(result);
      showNotice(successMessage || "Command completed.");
      await refreshHistory();
    }
  } catch (error) {
    showNotice(error && error.message || String(error), true);
  } finally {
    actionPending = false;
    if (currentStatus) renderStatus(currentStatus);
  }
}

async function refreshHistory() {
  try {
    const records = await executePageCommand("history");
    renderHistory(records);
  } catch (error) {
    historyEmpty.textContent = error && error.message || "Capture history is unavailable.";
    historyEmpty.hidden = false;
  }
}

async function refresh() {
  if (refreshing || actionPending) return;
  refreshing = true;
  try {
    const tabs = await browser.tabs.query({active:true,currentWindow:true});
    activeTab = tabs && tabs[0];
    if (!activeTab || !isYouTubeTab(activeTab)) {
      currentStatus = null;
      for (const button of [armButton,pauseButton,resumeButton,splitButton,stopButton,discardButton]) button.disabled = true;
      targetDot.className = "target-dot bad";
      targetState.textContent = "UNSUPPORTED TAB";
      targetDetail.textContent = "Open an HTTPS page on youtube.com to use playback capture.";
      statusDot.className = "status-dot";
      captureStatus.textContent = "Waiting for a supported YouTube tab.";
      videoTitle.textContent = "No active video";
      videoId.textContent = "Video identity unavailable.";
      meterFill.style.width = "0";
      return;
    }
    targetDot.className = "target-dot good";
    targetState.textContent = "YOUTUBE TAB DETECTED";
    targetDetail.textContent = "Video changes are tracked independently. Capture history is stored locally.";
    renderStatus(await executePageCommand("get"));
    await refreshHistory();
  } catch (error) {
    armButton.disabled = true;
    statusDot.className = "status-dot bad";
    captureStatus.textContent = error && error.message || String(error);
    if (activeTab && isYouTubeTab(activeTab)) {
      targetDot.className = "target-dot good";
      targetState.textContent = "YOUTUBE TAB DETECTED";
      targetDetail.textContent = "Reload this tab if the extension was just installed.";
    }
  } finally { refreshing = false; }
}

armButton.addEventListener("click", () => perform("set", !(currentStatus && currentStatus.enabled), "Capture setting updated."));
pauseButton.addEventListener("click", () => perform("pause", null, "Recording paused."));
resumeButton.addEventListener("click", () => perform("resume", null, "Recording resumed."));
splitButton.addEventListener("click", () => perform("split", null, "Recording split into a new file."));
stopButton.addEventListener("click", () => perform("stop", null, "Recording stopped and saved."));
discardButton.addEventListener("click", () => perform("discard", null, "Recording discarded."));

void refresh();
window.setInterval(() => { void refresh(); }, 1000);
