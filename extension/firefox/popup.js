"use strict";
const byId = id => document.getElementById(id);
const serverInput = byId("server"), targetInput = byId("target");
const startButton = byId("start"), activePanel = byId("active"), message = byId("message");

async function capturePageEnvironment() {
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
  const describeURL = value => {
    try {
      const parsed = new URL(value, location.href);
      const isBlob = parsed.protocol === "blob:";
      let origin = parsed.origin;
      if (isBlob && origin === "null") {
        const match = String(value).match(/^blob:(https?:\/\/[^/]+)/i);
        origin = match ? match[1] : "null";
      }
      if (!origin || origin === "null") {
        return {scheme: parsed.protocol.replace(/:$/, ""), host_class: "other", origin_class: "opaque",
          path_class: isBlob ? "blob_worker" : pathClass(parsed.pathname), port: "unknown"};
      }
      const originUrl = new URL(origin);
      const host = hostClass(originUrl.hostname);
      return {
        scheme: parsed.protocol.replace(/:$/, ""),
        host_class: host,
        origin_class: originUrl.protocol + "//" + host + (originUrl.port ? ":" + originUrl.port : ""),
        path_class: isBlob ? "blob_worker" : pathClass(parsed.pathname),
        port: originUrl.port || "default"
      };
    } catch (_) {
      return {scheme: "unparseable", host_class: "other", origin_class: "opaque", path_class: "other", port: "unknown"};
    }
  };
  const host = location.hostname.toLowerCase();
  const hostKind = hostClass(host);
  const mode = hostKind === "localhost" || hostKind === "loopback"
    ? "reverse_proxy" : hostKind === "youtube" ? "native_youtube" : "unclassified";

  const resources = {
    scope: "document_performance_resource_entries",
    total: 0,
    initiators: {},
    hosts: {},
    paths: {},
    timing: {
      duration_ms_total: 0,
      duration_ms_max: 0,
      transfer_size_bytes_total: 0,
      encoded_body_size_bytes_total: 0,
      decoded_body_size_bytes_total: 0,
      entries_with_timing: 0
    },
    window: {document_age_ms: Math.max(0, Math.round(performance.now())), oldest_start_ms: null, newest_response_end_ms: null}
  };
  const resourceEntries = safe(() => performance.getEntriesByType("resource").slice(-1000));
  if (Array.isArray(resourceEntries)) {
    for (const entry of resourceEntries) {
      const resource = describeURL(entry.name);
      const initiator = String(entry.initiatorType || "other").slice(0, 32);
      resources.total++;
      resources.initiators[initiator] = (resources.initiators[initiator] || 0) + 1;
      resources.hosts[resource.host_class] = (resources.hosts[resource.host_class] || 0) + 1;
      resources.paths[resource.path_class] = (resources.paths[resource.path_class] || 0) + 1;
      const duration = Number(entry.duration);
      if (Number.isFinite(duration) && duration >= 0) {
        resources.timing.duration_ms_total += duration;
        resources.timing.duration_ms_max = Math.max(resources.timing.duration_ms_max, duration);
        resources.timing.entries_with_timing++;
      }
      for (const [key, field] of [
        ["transfer_size_bytes_total", "transferSize"],
        ["encoded_body_size_bytes_total", "encodedBodySize"],
        ["decoded_body_size_bytes_total", "decodedBodySize"]
      ]) {
        const amount = Number(entry[field]);
        if (Number.isFinite(amount) && amount >= 0) resources.timing[key] += amount;
      }
      const startTime = Number(entry.startTime);
      const responseEnd = Number(entry.responseEnd);
      if (Number.isFinite(startTime)) {
        resources.window.oldest_start_ms = resources.window.oldest_start_ms === null
          ? startTime : Math.min(resources.window.oldest_start_ms, startTime);
      }
      if (Number.isFinite(responseEnd)) {
        resources.window.newest_response_end_ms = resources.window.newest_response_end_ms === null
          ? responseEnd : Math.max(resources.window.newest_response_end_ms, responseEnd);
      }
    }
  }
  resources.timing.duration_ms_total = Math.round(resources.timing.duration_ms_total * 100) / 100;
  resources.timing.duration_ms_max = Math.round(resources.timing.duration_ms_max * 100) / 100;

  const workerProbe = safe(() => globalThis.__interceptWorkerProbeV1);
  const workerEvents = workerProbe && Array.isArray(workerProbe.events)
    ? workerProbe.events.slice(-200).map(event => ({
        at_ms: Number.isFinite(event.at_ms) ? event.at_ms : null,
        constructor: event.constructor === "shared" ? "shared" : "dedicated",
        script: event.script && typeof event.script === "object" ? {
          scheme: ["http", "https", "blob", "data", "file", "filesystem", "ftp", "ws", "wss", "unparseable"].includes(event.script.scheme)
            ? event.script.scheme : "unknown",
          origin_scheme: ["http", "https", "file", "ftp", "ws", "wss"].includes(event.script.origin_scheme)
            ? event.script.origin_scheme : "opaque",
          host_class: ["youtube", "googlevideo", "googleapis", "localhost", "loopback", "other"].includes(event.script.host_class)
            ? event.script.host_class : "other",
          origin_class: ["http", "https", "file", "ftp", "ws", "wss"].includes(event.script.origin_scheme)
            ? event.script.origin_scheme + "://" + (["youtube", "googlevideo", "googleapis", "localhost", "loopback", "other"].includes(event.script.host_class) ? event.script.host_class : "other")
              + (/^\d{1,5}$/.test(String(event.script.port || "")) ? ":" + String(event.script.port) : "")
            : "opaque",
          path_class: ["root", "watch", "embed", "shorts", "player_bundle", "media", "innertube_player", "innertube", "blob_worker", "other"].includes(event.script.path_class)
            ? event.script.path_class : "other",
          port: /^\d{1,5}$/.test(String(event.script.port || "")) ? String(event.script.port) : "default"
        } : {scheme: "unknown", host_class: "other", origin_class: "opaque", path_class: "other", port: "unknown"},
        options: {
          type: event.options && (event.options.type === "module" || event.options.type === "classic")
            ? event.options.type : "default",
          credentials: event.options && ["omit", "same-origin", "include"].includes(event.options.credentials)
            ? event.options.credentials : "default",
          name_present: !!(event.options && event.options.name_present)
        },
        outcome: event.outcome === "constructed" ? "constructed" : "constructor_threw"
      }))
    : [];
  const workerConstruction = {
    probe_present: !!workerProbe,
    probe_schema_version: workerProbe && Number.isFinite(workerProbe.schema_version) ? workerProbe.schema_version : null,
    installed_at_ms: workerProbe && Number.isFinite(workerProbe.installed_at_ms) ? workerProbe.installed_at_ms : null,
    dropped_events: workerProbe && Number.isSafeInteger(workerProbe.dropped_events)
      ? Math.max(0, Math.min(workerProbe.dropped_events, 1000000)) : 0,
    instrumentation: workerProbe && workerProbe.instrumentation ? {
      Worker: ["installed", "unavailable", "failed"].includes(workerProbe.instrumentation.Worker)
        ? workerProbe.instrumentation.Worker : "unknown",
      SharedWorker: ["installed", "unavailable", "failed"].includes(workerProbe.instrumentation.SharedWorker)
        ? workerProbe.instrumentation.SharedWorker : "unknown"
    } : {Worker: "missing", SharedWorker: "missing"},
    event_count: workerEvents.length,
    events: workerEvents
  };

  const serviceWorkers = {
    api_available: !!navigator.serviceWorker,
    controller_present: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    controller: null,
    registration_count: null,
    registrations: [],
    registrations_status: "not_checked"
  };
  const summarizeServiceWorker = worker => {
    if (!worker) return null;
    return {
      state: ["installing", "installed", "activating", "activated", "redundant"].includes(worker.state)
        ? worker.state : "unknown",
      script: describeURL(worker.scriptURL)
    };
  };
  if (navigator.serviceWorker) {
    serviceWorkers.controller = summarizeServiceWorker(navigator.serviceWorker.controller);
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      serviceWorkers.registration_count = registrations.length;
      serviceWorkers.registrations_status = "available";
      serviceWorkers.registrations = registrations.slice(0, 100).map(registration => ({
        scope: describeURL(registration.scope),
        update_via_cache: ["imports", "all", "none"].includes(registration.updateViaCache)
          ? registration.updateViaCache : "unknown",
        active: summarizeServiceWorker(registration.active),
        installing: summarizeServiceWorker(registration.installing),
        waiting: summarizeServiceWorker(registration.waiting)
      }));
    } catch (_) {
      serviceWorkers.registrations_status = "unavailable";
    }
  }

  const storage = {
    local_storage_accessible: safe(() => { localStorage.getItem("__intercept_probe__"); return true; }) === true,
    session_storage_accessible: safe(() => { sessionStorage.getItem("__intercept_probe__"); return true; }) === true,
    indexed_db_available: typeof indexedDB !== "undefined",
    storage_manager_available: !!(navigator.storage && navigator.storage.estimate)
  };
  return {
    schema: "intercept-page-environment",
    schema_version: 2,
    mode,
    location: {
      protocol: location.protocol,
      hostname_class: hostKind,
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
      service_worker_controller_present: serviceWorkers.controller_present,
      service_worker_container_constructor: typeof ServiceWorkerContainer === "function",
      worklet_api: typeof Worklet === "function",
      dedicated_shared_worker_construction: workerConstruction,
      service_workers: serviceWorkers,
      worker_resource_timing: {
        observable_from_document: false,
        explanation: "The document Performance timeline does not expose entries from inside dedicated or shared worker execution contexts."
      }
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
    let results;
    try {
      results = await browser.scripting.executeScript({
        target: {tabId: tab.id},
        world: "MAIN",
        func: capturePageEnvironment
      });
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      if (/permission|host|access/i.test(detail)) {
        throw new Error("Firefox denied access to this tab. Reload the updated extension, click its toolbar button while on the page, then choose CAPTURE ACTIVE TAB. The activeTab permission grants temporary access to the current tab.");
      }
      throw error;
    }
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
        "Dedicated/shared Worker constructor calls are observed by an early MAIN-world probe; page scripts can interfere with this instrumentation.",
        "Resource entries are document Performance timeline aggregates; worker-local Performance timelines are not exposed.",
        "Resource entries are aggregated by initiator type, sanitized host class, and sanitized path class.",
        "No full URLs, query strings, worker names, cookies, tokens, request bodies, or response bodies are recorded.",
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
