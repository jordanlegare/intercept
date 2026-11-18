"use strict";
const byId = id => document.getElementById(id);
const serverInput = byId("server"), targetInput = byId("target");
const startButton = byId("start"), activePanel = byId("active"), message = byId("message");
function normalizeServer(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)
      || !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.port !== "5000" || url.username || url.password || url.search || url.hash) {
    throw new Error("Server must be http://127.0.0.1:5000 or http://localhost:5000.");
  }
  return url.origin;
}
function normalizeYouTubeTarget(value) {
  const url = new URL(value), host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host === "youtube.com" || host.endsWith(".youtube.com"))
      || url.username || url.password) throw new Error("Enter an HTTPS URL on youtube.com or one of its subdomains.");
  url.hash = "";
  return url.href;
}
async function apiRequest(session, suffix, options = {}) {
  const response = await fetch(session.server + "/api/native/sessions/"
    + encodeURIComponent(session.id) + suffix, {
      ...options,
      headers: {...(options.headers || {}), "authorization": "Bearer " + session.token},
      cache: "no-store"
    });
  if (!response.ok) {
    const text = await response.text();
    throw new Error("Intercept backend returned " + response.status + (text ? ": " + text.slice(0, 180) : ""));
  }
  return response.status === 204 ? null : response.json();
}
function renderEvents(events) {
  const list = byId("events");
  list.replaceChildren();
  for (const event of (events || []).slice(-25).reverse()) {
    const item = document.createElement("li"), title = document.createElement("strong");
    title.textContent = event.kind + " ";
    const detail = document.createElement("span");
    detail.textContent = (event.target || "") + " " + (event.detail || "");
    item.append(title, detail); list.append(item);
  }
  byId("event-count").textContent = (events || []).length + " events stored in this Intercept session.";
}
async function refreshEvents() {
  const stored = await browser.storage.local.get("nativeSession"), session = stored.nativeSession;
  if (!session) return;
  await browser.runtime.sendMessage({type: "intercept-native:flush"});
  renderEvents(await apiRequest(session, "/events"));
  byId("session-id").textContent = "SESSION " + session.id + " · TAB " + session.tabId;
}
async function exportObservations() {
  const button = byId("export");
  button.disabled = true;
  message.textContent = "Collecting the complete session event log…";
  try {
    const stored = await browser.storage.local.get("nativeSession"), session = stored.nativeSession;
    if (!session) throw new Error("There is no active native-origin session to export.");
    // Flush events still queued in the extension before requesting the backend's full session log.
    await browser.runtime.sendMessage({type: "intercept-native:flush"});
    const events = await apiRequest(session, "/events");
    renderEvents(events);
    const exportedAt = new Date();
    const payload = {
      format: "intercept-native-observations",
      format_version: 1,
      exported_at: exportedAt.toISOString(),
      session: {
        id: session.id,
        tab_id: session.tabId,
        created_at: session.createdAt ? new Date(session.createdAt).toISOString() : null
      },
      event_count: events.length,
      events
    };
    const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
      type: "application/json;charset=utf-8"
    });
    const objectUrl = URL.createObjectURL(blob);
    const stamp = exportedAt.toISOString().replace(/[:.]/g, "-");
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "intercept-native-observations-" + stamp + ".json";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    message.textContent = "Exported " + events.length + " events as JSON.";
  } catch (error) {
    message.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
}
async function stopSession() {
  const stored = await browser.storage.local.get("nativeSession"), session = stored.nativeSession;
  if (!session) return;
  await apiRequest(session, "", {method: "DELETE"});
  await browser.storage.local.remove("nativeSession");
  activePanel.hidden = true; startButton.disabled = false;
  message.textContent = "Observation stopped. The YouTube tab remains open and continues directly to YouTube.";
}
async function loadState() {
  const stored = await browser.storage.local.get(["nativeSession", "server"]);
  if (stored.server) serverInput.value = stored.server;
  if (stored.nativeSession) {
    activePanel.hidden = false; startButton.disabled = true;
    byId("session-id").textContent = "SESSION " + stored.nativeSession.id + " · TAB " + stored.nativeSession.tabId;
    try { await refreshEvents(); } catch (error) { message.textContent = error.message || String(error); }
  }
}
startButton.addEventListener("click", async () => {
  startButton.disabled = true; message.textContent = "Creating native-origin observation session…";
  let blankTab = null;
  try {
    const server = normalizeServer(serverInput.value.trim()), target = normalizeYouTubeTarget(targetInput.value.trim());
    const prior = await browser.storage.local.get("nativeSession");
    if (prior.nativeSession) {
      try { await apiRequest(prior.nativeSession, "", {method: "DELETE"}); } catch (_) {}
      await browser.storage.local.remove("nativeSession");
    }
    blankTab = await browser.tabs.create({url: "about:blank", active: true});
    const response = await fetch(server + "/api/sessions", {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({url: target, policy: "standard", rules: [], native_origin: true}),
      cache: "no-store"
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error("Could not create native session (" + response.status + ")" + (text ? ": " + text.slice(0, 180) : ""));
    }
    const created = await response.json();
    if (!created.native_token || !created.id) throw new Error("Backend did not return a native-session capability. Update and restart the Intercept server.");
    const session = {id: created.id, token: created.native_token, server, target,
      tabId: blankTab.id, createdAt: Date.now()};
    await browser.storage.local.set({nativeSession: session, server});
    await browser.tabs.update(blankTab.id, {url: target});
    activePanel.hidden = false;
    byId("session-id").textContent = "SESSION " + session.id + " · TAB " + session.tabId;
    message.textContent = "YouTube opened on its native origin. Intercept is observing metadata only.";
    await refreshEvents();
  } catch (error) {
    if (blankTab && blankTab.id !== undefined) { try { await browser.tabs.remove(blankTab.id); } catch (_) {} }
    startButton.disabled = false; message.textContent = error.message || String(error);
  }
});
byId("refresh").addEventListener("click", async () => {
  try { await refreshEvents(); message.textContent = ""; }
  catch (error) { message.textContent = error.message || String(error); }
});
byId("export").addEventListener("click", exportObservations);
byId("stop").addEventListener("click", async () => {
  try { await stopSession(); } catch (error) { message.textContent = error.message || String(error); }
});
serverInput.addEventListener("change", async () => {
  try {
    const server = normalizeServer(serverInput.value.trim()); serverInput.value = server;
    await browser.storage.local.set({server}); message.textContent = "";
  } catch (error) { message.textContent = error.message || String(error); }
});
loadState().catch(error => { message.textContent = error.message || String(error); });
