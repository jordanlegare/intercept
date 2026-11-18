"use strict";
const byId = id => document.getElementById(id);
const serverInput = byId("server"), targetInput = byId("target");
const startButton = byId("start"), activePanel = byId("active"), message = byId("message");

function capturePageEnvironment() {
  const safe = fn => { try { return fn(); } catch (_) { return "unavailable"; } };
  const hostClass = host => {
    host = String(host || "").toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
    if (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) return "googlevideo";
    if (host === "googleapis.com" || host.endsWith(".googleapis.com")) return "googleapis";
    if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
    if (host === "127.0.0.1" || host === "::1") return "loopback";
    return "other";
  };
  const pathClass = path => {
    if (path === "/" || !path) return "root";
    if (/^\/watch\/?$/.test(path)) return "watch";
    if (/^\/embed\//.test(path)) return "embed";
    if (/^\/shorts\//.test(path)) return "shorts";
    if (/^\/s\/player\/[^/]+\/base\.js$/.test(path)) return "player_bundle";
    if (path === "/videoplayback") return "media";
    if (/^\/youtubei\/v1\/player$/.test(path)) return "innertube_player";
    if (/^\/youtubei\/v1\//.test(path)) return "innertube";
    return "other";
  };
  const originClass = value => {
    const parsed = new URL(value);
    return parsed.protocol + "//" + hostClass(parsed.hostname) + (parsed.port ? ":" + parsed.port : "");
  };
  const host = location.hostname.toLowerCase();
  const mode = hostClass(host) === "localhost" || hostClass(host) === "loopback"
    ? "reverse_proxy"
    : hostClass(host) === "youtube" ? "native_youtube" : "unclassified";
  const resources = {total: 0, initiators: {}, hosts: {}, paths: {}};
  safe(() => performance.getEntriesByType("resource").slice(-1000).forEach(entry => {
    const url = new URL(entry.name, location.href);
    const h = hostClass(url.hostname), p = pathClass(url.pathname);
    const initiator = String(entry.initiatorType || "other").slice(0, 32);
    resources.total++;
    resources.initiators[initiator] = (resources.initiators[initiator] || 0) + 1;
    resources.hosts[h] = (resources.hosts[h] || 0) + 1;
    resources.paths[p] = (resources.paths[p] || 0) + 1;
  }));
  const storage = {
    local_storage_accessible: safe(() => { const value = localStorage.getItem("__intercept_probe__"); return true; }) === true,
    session_storage_accessible: safe(() => { const value = sessionStorage.getItem("__intercept_probe__"); return true; }) === true,
    indexed_db_available: typeof indexedDB !== "undefined",
    storage_manager_available: !!(navigator.storage && navigator.storage.estimate)
  };
  return {
    schema: "intercept-page-environment",
    schema_version: 1,
    mode,
    location: {
      protocol: location.protocol,
      hostname_class: hostClass(host),
      port: location.port || "default",
      path_class: pathClass(location.pathname),
      window_origin_class: safe(() => originClass(window.origin)),
      self_origin_class: safe(() => originClass(self.origin)),
      document_domain_class: safe(() => hostClass(document.domain))
    },
    security: {
      is_secure_context: !!globalThis.isSecureContext,
      cross_origin_isolated: !!globalThis.crossOriginIsolated,
      top_level_frame: safe(() => window.top === window.self),
      document_visibility: document.visibilityState,
      document_ready_state: document.readyState,
      cookie_enabled: !!navigator.cookieEnabled
    },
    workers: {
      worker_constructor: typeof Worker === "function",
      shared_worker_constructor: typeof SharedWorker === "function",
      service_worker_api: !!navigator.serviceWorker,
      service_worker_controller_present: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      service_worker_container_constructor: typeof ServiceWorkerContainer === "function",
      worklet_api: typeof Worklet === "function",
    },
    network: {
      fetch: typeof fetch === "function",
      xhr: typeof XMLHttpRequest === "function",
      request: typeof Request === "function",
      response: typeof Response === "function",
      readable_stream: typeof ReadableStream === "function",
      abort_controller: typeof AbortController === "function",
      web_socket: typeof WebSocket === "function",
      web_transport: typeof WebTransport === "function"
    },
    media: {
      media_source: typeof MediaSource === "function",
      media_source_is_type_supported: typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function",
      eme_request_access: typeof navigator.requestMediaKeySystemAccess === "function",
      media_capabilities: !!(navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo),
      video_decoder: typeof VideoDecoder === "function",
      audio_decoder: typeof AudioDecoder === "function",
      video_can_play_type: typeof HTMLVideoElement !== "undefined" && typeof HTMLVideoElement.prototype.canPlayType === "function",
      media_session: !!navigator.mediaSession
    },
    storage,
    resources
  };
}

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
function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
    type: "application/json;charset=utf-8"
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}
async function exportObservations() {
  const button = byId("export");
  button.disabled = true;
  message.textContent = "Collecting the complete session event log…";
  try {
    const stored = await browser.storage.local.get("nativeSession"), session = stored.nativeSession;
    if (!session) throw new Error("There is no active native-origin session to export.");
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
    downloadJson("intercept-native-observations-" + exportedAt.toISOString().replace(/[:.]/g, "-") + ".json", payload);
    message.textContent = "Exported " + events.length + " events as JSON.";
  } catch (error) {
    message.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
}
function flatten(value, prefix = "", output = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? prefix + "." + key : key, output);
  } else {
    output[prefix] = JSON.stringify(value);
  }
  return output;
}
function compareSnapshots(snapshots) {
  const native = (snapshots.native_youtube || []).slice(-1)[0];
  const proxy = (snapshots.reverse_proxy || []).slice(-1)[0];
  if (!native || !proxy) return {native, proxy, differences: []};
  const left = flatten(native), right = flatten(proxy);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const differences = keys.filter(key => key !== "mode" && key !== "captured_at"
      && left[key] !== right[key]).map(key => ({
        field: key,
        native: left[key] === undefined ? "not_recorded" : JSON.parse(left[key]),
        proxy: right[key] === undefined ? "not_recorded" : JSON.parse(right[key])
      }));
  return {native, proxy, differences};
}
async function renderComparison() {
  const stored = await browser.storage.local.get("environmentSnapshots");
  const snapshots = stored.environmentSnapshots || {native_youtube: [], reverse_proxy: [], unclassified: []};
  const comparison = compareSnapshots(snapshots);
  const status = byId("compare-status"), list = byId("differences");
  list.replaceChildren();
  const nativeCount = (snapshots.native_youtube || []).length;
  const proxyCount = (snapshots.reverse_proxy || []).length;
  if (!nativeCount && !proxyCount) {
    status.textContent = "No environment snapshots captured yet.";
    return;
  }
  status.textContent = "Native captures: " + nativeCount + " · Proxy captures: " + proxyCount
    + (comparison.native && comparison.proxy ? " · " + comparison.differences.length + " differing fields" : " · capture the other mode to compare");
  for (const difference of comparison.differences.slice(0, 18)) {
    const item = document.createElement("li");
    item.textContent = difference.field + ": native=" + JSON.stringify(difference.native)
      + " | proxy=" + JSON.stringify(difference.proxy);
    list.append(item);
  }
  if (comparison.differences.length > 18) {
    const item = document.createElement("li");
    item.textContent = "…and " + (comparison.differences.length - 18) + " more differences (included in export).";
    list.append(item);
  }
}
async function captureEnvironment() {
  const button = byId("capture-env");
  button.disabled = true;
  try {
    const [tab] = await browser.tabs.query({active: true, currentWindow: true});
    if (!tab || !Number.isInteger(tab.id)) throw new Error("Could not identify the active tab.");
    if (!tab.url) throw new Error("Firefox did not provide the active tab URL.");
    const activeUrl = new URL(tab.url);
    if (!["http:", "https:"].includes(activeUrl.protocol)) {
      throw new Error("Environment capture requires an HTTP or HTTPS page.");
    }
    const tabOriginPattern = activeUrl.origin + "/*";
    const alreadyAllowed = await browser.permissions.contains({origins: [tabOriginPattern]});
    if (!alreadyAllowed) {
      const granted = await browser.permissions.request({origins: [tabOriginPattern]});
      if (!granted) {
        throw new Error("Firefox did not grant access to this tab's origin. Allow the requested site permission and try again.");
      }
    }
    const results = await browser.scripting.executeScript({
      target: {tabId: tab.id},
      world: "MAIN",
      func: capturePageEnvironment
    });
    const page = results && results[0] && results[0].result;
    if (!page || !page.mode) throw new Error("The page did not return an environment snapshot.");
    if (page.mode === "unclassified") {
      throw new Error("Active tab is neither a recognized YouTube origin nor a localhost Intercept proxy session.");
    }
    const snapshot = {...page, captured_at: new Date().toISOString()};
    const stored = await browser.storage.local.get("environmentSnapshots");
    const snapshots = stored.environmentSnapshots || {native_youtube: [], reverse_proxy: [], unclassified: []};
    if (!Array.isArray(snapshots[snapshot.mode])) snapshots[snapshot.mode] = [];
    snapshots[snapshot.mode].push(snapshot);
    snapshots[snapshot.mode] = snapshots[snapshot.mode].slice(-5);
    await browser.storage.local.set({environmentSnapshots: snapshots});
    message.textContent = "Captured " + snapshot.mode + " environment from active tab.";
    await renderComparison();
  } catch (error) {
    message.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
}
async function exportComparison() {
  const button = byId("export-comparison");
  button.disabled = true;
  try {
    const stored = await browser.storage.local.get("environmentSnapshots");
    const snapshots = stored.environmentSnapshots || {native_youtube: [], reverse_proxy: [], unclassified: []};
    const comparison = compareSnapshots(snapshots);
    if (!comparison.native || !comparison.proxy) {
      throw new Error("Capture one native YouTube tab and one localhost proxy tab before exporting the comparison.");
    }
    const exportedAt = new Date();
    downloadJson("intercept-environment-comparison-" + exportedAt.toISOString().replace(/[:.]/g, "-") + ".json", {
      format: "intercept-environment-comparison",
      format_version: 1,
      exported_at: exportedAt.toISOString(),
      snapshots,
      latest_comparison: comparison.differences,
      notes: [
        "Snapshots execute in the page MAIN world.",
        "Resource entries are aggregated by initiator type, sanitized host class, and sanitized path class.",
        "No full URLs, query strings, cookies, tokens, request bodies, or response bodies are recorded.",
        "Differences identify environment variance; they do not by themselves prove causation."
      ]
    });
    message.textContent = "Exported environment comparison (" + comparison.differences.length + " differing fields).";
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
  await renderComparison();
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
byId("capture-env").addEventListener("click", captureEnvironment);
byId("export-comparison").addEventListener("click", exportComparison);
serverInput.addEventListener("change", async () => {
  try {
    const server = normalizeServer(serverInput.value.trim()); serverInput.value = server;
    await browser.storage.local.set({server}); message.textContent = "";
  } catch (error) { message.textContent = error.message || String(error); }
});
loadState().catch(error => { message.textContent = error.message || String(error); });
