"use strict";

const byId = id => document.getElementById(id);
const armButton = byId("arm-button");
const targetDot = byId("target-dot");
const targetState = byId("target-state");
const targetDetail = byId("target-detail");
const statusDot = byId("status-dot");
const captureStatus = byId("capture-status");
const meterFill = byId("meter-fill");
let activeTab = null;
let currentStatus = null;
let refreshing = false;

function isYouTubeTab(tab) {
  try {
    const url = new URL(tab && tab.url || "");
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "youtube.com" || host.endsWith(".youtube.com"));
  } catch (_) { return false; }
}

async function executePageCommand(command, enabled) {
  if (!activeTab || !Number.isInteger(activeTab.id)) throw new Error("Firefox could not identify the active tab.");
  const results = await browser.scripting.executeScript({
    target: {tabId: activeTab.id},
    world: "MAIN",
    func: function(action, value) {
      const api = globalThis.__standalonePlaybackDownloadV1;
      if (!api) return {state:"unavailable",error:"Capture script is not ready. Reload this YouTube tab and reopen Playback Capture."};
      return action === "set" ? api.setEnabled(value) : api.getStatus();
    },
    args: [command, enabled]
  });
  const status = results && results[0] && results[0].result;
  if (!status) throw new Error("The active tab did not return capture status.");
  if (status.state === "unavailable") throw new Error(status.error || "Playback capture is unavailable.");
  return status;
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1073741824) return (value / 1073741824).toFixed(2) + " GiB";
  if (value >= 1048576) return (value / 1048576).toFixed(1) + " MiB";
  if (value >= 1024) return (value / 1024).toFixed(0) + " KiB";
  return value + " B";
}

function renderStatus(status) {
  currentStatus = status;
  const enabled = status.enabled === true;
  armButton.disabled = false;
  armButton.textContent = enabled ? "DISARM DOWNLOAD" : "ARM DOWNLOAD";
  armButton.classList.toggle("armed", enabled);
  statusDot.className = "status-dot " + (status.state === "error" ? "bad" : enabled ? "good" : "");
  meterFill.style.width = enabled && status.state === "recording" ? "100%" : "0%";
  const size = formatSize(status.bytes_written);
  switch (status.state) {
    case "armed": captureStatus.textContent = "ARMED · start playback to begin capture."; break;
    case "preparing": captureStatus.textContent = "PREPARING · opening temporary capture storage."; break;
    case "recording": captureStatus.textContent = "RECORDING · " + size + " written."; break;
    case "finalizing": captureStatus.textContent = "FINALIZING · closing the WebM file."; break;
    case "download_started": captureStatus.textContent = "DOWNLOAD STARTED · " + (status.filename || "playback.webm"); break;
    case "error": captureStatus.textContent = "ERROR · " + (status.error || "Playback capture failed."); break;
    case "disabled": captureStatus.textContent = "OFF · no playback is being captured."; break;
    default: captureStatus.textContent = String(status.state || "unknown").toUpperCase() + (status.bytes_written ? " · " + size : "");
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const tabs = await browser.tabs.query({active:true,currentWindow:true});
    activeTab = tabs && tabs[0];
    if (!activeTab || !isYouTubeTab(activeTab)) {
      currentStatus = null;
      armButton.disabled = true;
      targetDot.className = "target-dot bad";
      targetState.textContent = "UNSUPPORTED TAB";
      targetDetail.textContent = "Open an HTTPS page on youtube.com to use playback capture.";
      statusDot.className = "status-dot";
      captureStatus.textContent = "Waiting for a supported YouTube tab.";
      meterFill.style.width = "0";
      return;
    }
    targetDot.className = "target-dot good";
    targetState.textContent = "YOUTUBE TAB DETECTED";
    targetDetail.textContent = "Capture runs locally in this tab. No Intercept server is required.";
    renderStatus(await executePageCommand("get", false));
  } catch (error) {
    armButton.disabled = true;
    statusDot.className = "status-dot bad";
    captureStatus.textContent = error && error.message || String(error);
    if (activeTab && isYouTubeTab(activeTab)) {
      targetDot.className = "target-dot good";
      targetState.textContent = "YOUTUBE TAB DETECTED";
      targetDetail.textContent = "Reload this tab once if the extension was just installed.";
    }
  } finally { refreshing = false; }
}

armButton.addEventListener("click", async () => {
  if (!currentStatus || !activeTab) return;
  armButton.disabled = true;
  try { renderStatus(await executePageCommand("set", !currentStatus.enabled)); }
  catch (error) {
    statusDot.className = "status-dot bad";
    captureStatus.textContent = error && error.message || String(error);
  } finally { armButton.disabled = false; }
});

void refresh();
window.setInterval(() => { void refresh(); }, 1200);
