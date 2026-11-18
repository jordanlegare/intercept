/* Firefox MV3 event-page background script. All listeners are registered at top level. */
"use strict";

const URL_FILTERS = [
  "https://youtube.com/*", "https://*.youtube.com/*",
  "https://googlevideo.com/*", "https://*.googlevideo.com/*",
  "https://googleapis.com/*", "https://*.googleapis.com/*"
];
const inFlight = new Map();
let pendingEvents = [];
let flushTimer = null;
let flushActive = false;
let activeSession = null;

const MEDIA_TRACE_URL_FILTERS = [
  "https://youtube.com/*", "https://*.youtube.com/*",
  "https://googlevideo.com/*", "https://*.googlevideo.com/*",
  "https://googleapis.com/*", "https://*.googleapis.com/*",
  "http://localhost/*", "http://*.localhost/*", "http://127.0.0.1/*"
];
let mediaTrace = null;
const mediaTraceInFlight = new Map();
let mediaTraceWriteQueue = Promise.resolve();
const mediaTraceReady = browser.storage.local.get("mediaTrace").then(stored => {
  const saved = stored.mediaTrace;
  if (saved && saved.schema === "intercept-media-request-trace" && saved.schema_version === 1) {
    mediaTrace = saved;
  }
}).catch(() => {});

let sessionChangeRevision = 0;
const sessionReady = browser.storage.local.get("nativeSession").then(stored => {
  if (sessionChangeRevision === 0) activeSession = stored.nativeSession || null;
}).catch(() => {});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, "nativeSession")) return;
  sessionChangeRevision++;
  activeSession = changes.nativeSession.newValue || null;
  if (!activeSession) {
    pendingEvents = [];
    inFlight.clear();
  }
});

function uuid() {
  return (globalThis.crypto && typeof crypto.randomUUID === "function")
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
}
function parseUrl(value) { try { return new URL(value); } catch (_) { return null; } }
function hostOnly(value) {
  const parsed = parseUrl(value);
  return parsed ? parsed.hostname.toLowerCase() : "absent";
}
function safeTarget(url) {
  const host = url.hostname.toLowerCase(), path = url.pathname;
  let label = "other", operation = "";
  let match = path.match(/^\/\$rpc\/google\.internal\.waa\.v1\.Waa\/(Create|GenerateIT)$/);
  if (match) { label = "waa_rpc"; operation = match[1]; }
  else if ((match = path.match(/^\/api\/jnn\/v1\/(Create|GenerateIT)$/))) {
    label = "waa_rpc"; operation = match[1];
  } else if (path === "/youtubei/v1/att/get") { label = "attestation_resource"; operation = "AttGet"; }
  else if (path === "/youtubei/v1/att/log") { label = "attestation_resource"; operation = "AttLog"; }
  else if (["/youtubei/v1/player", "/youtubei/v1/get_watch", "/youtubei/v1/next"].includes(path)) {
    label = "innertube_player";
  } else if (path === "/videoplayback") {
    label = url.searchParams.has("sabr") ? "sabr_media" : "media";
  } else if (/^\/s\/player\/[^/]+\/base\.js$/.test(path)) label = "player_bundle";
  else if (path.startsWith("/youtubei/v1/")) label = "innertube_other";
  return {target: host + "/" + label, operation: operation || label, host};
}
async function activeSessionFor(details) {
  await sessionReady;
  const session = activeSession;
  if (!session || !Number.isInteger(session.tabId) || details.tabId !== session.tabId) return null;
  return session;
}
function queueEvent(session, kind, target, detail) {
  pendingEvents.push({
    kind, target: String(target || "").slice(0, 220),
    detail: String(detail || "").slice(0, 280)
  });
  if (pendingEvents.length >= 30) void flushEvents(session);
  else if (!flushTimer) flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushEvents(session);
  }, 200);
}
async function flushEvents(sessionHint) {
  if (flushActive || pendingEvents.length === 0) return;
  flushActive = true;
  try {
    const stored = await browser.storage.local.get("nativeSession");
    const session = stored.nativeSession || sessionHint;
    if (!session || !session.id || !session.token || !session.server) {
      pendingEvents = [];
      return;
    }
    const batch = pendingEvents.splice(0, 100);
    let response;
    try {
      response = await fetch(session.server + "/api/native/sessions/" + encodeURIComponent(session.id) + "/events", {
        method: "POST",
        headers: {"authorization": "Bearer " + session.token, "content-type": "application/json"},
        body: JSON.stringify(batch), cache: "no-store"
      });
    } catch (_) {
      pendingEvents = batch.concat(pendingEvents).slice(-500);
      return;
    }
    if (!response.ok) {
      pendingEvents = batch.concat(pendingEvents).slice(-500);
      if (response.status === 401 || response.status === 404) {
        await browser.storage.local.remove("nativeSession");
        pendingEvents = [];
      }
    }
  } finally {
    flushActive = false;
    if (pendingEvents.length > 0 && !flushTimer) flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushEvents(sessionHint);
    }, 1500);
  }
}
function recordRequestStart(details) {
  void activeSessionFor(details).then(session => {
    if (!session) return;
    const parsed = parseUrl(details.url);
    if (!parsed) return;
    const safe = safeTarget(parsed), id = uuid();
    inFlight.set(details.requestId, {
      id, startedAt: details.timeStamp || Date.now(), target: safe.target
    });
    queueEvent(session, "native_request_start", safe.target,
      "rid=" + id + " method=" + String(details.method || "OTHER").toUpperCase()
      + " type=" + String(details.type || "other").slice(0, 24)
      + " operation=" + safe.operation + " tab=" + details.tabId
      + " frame=" + details.frameId
      + " initiator_host=" + hostOnly(details.originUrl || details.documentUrl));
  }).catch(() => {});
}
function safeHeaderValue(headers, name) {
  const item = (headers || []).find(header => String(header.name || "").toLowerCase() === name);
  if (!item) return null;
  if (name === "origin" || name === "referer") return hostOnly(item.value || "");
  const raw = String(item.value || "").split(";", 1)[0].trim().toLowerCase();
  if (name === "sec-fetch-site") return ["none", "same-origin", "same-site", "cross-site"].includes(raw) ? raw : "other";
  if (name === "sec-fetch-mode") return ["cors", "navigate", "no-cors", "same-origin", "websocket"].includes(raw) ? raw : "other";
  if (name === "sec-fetch-dest") return /^[a-z-]{1,24}$/.test(raw) ? raw : "other";
  if (name === "content-type" || name === "accept") {
    const mime = raw.split(",", 1)[0].trim();
    return /^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/.test(mime) ? mime : "other";
  }
  if (name === "content-length") return /^\d{1,15}$/.test(raw) ? raw : "absent";
  if (name === "content-encoding") return /^[a-z0-9._-]{1,24}$/.test(raw) ? raw : "other";
  return "present";
}
function recordRequestHeaders(details) {
  void activeSessionFor(details).then(session => {
    if (!session) return;
    const request = inFlight.get(details.requestId);
    if (!request) return;
    const headers = details.requestHeaders || [];
    const names = new Set(headers.map(header => String(header.name || "").toLowerCase()));
    const fields = [
      "rid=" + request.id,
      "origin_host=" + (safeHeaderValue(headers, "origin") || "absent"),
      "referer_host=" + (safeHeaderValue(headers, "referer") || "absent"),
      "sec_fetch_site=" + (safeHeaderValue(headers, "sec-fetch-site") || "absent"),
      "sec_fetch_mode=" + (safeHeaderValue(headers, "sec-fetch-mode") || "absent"),
      "sec_fetch_dest=" + (safeHeaderValue(headers, "sec-fetch-dest") || "absent"),
      "content_type=" + (safeHeaderValue(headers, "content-type") || "absent"),
      "cookie_present=" + names.has("cookie"),
      "authorization_present=" + names.has("authorization"),
      "api_key_header_present=" + names.has("x-goog-api-key"),
      "visitor_header_present=" + names.has("x-goog-visitor-id")
    ];
    queueEvent(session, "native_request_headers", request.target, fields.join(" "));
  }).catch(() => {});
}
function recordResponseHeaders(details) {
  void activeSessionFor(details).then(session => {
    if (!session) return;
    const request = inFlight.get(details.requestId);
    if (!request) return;
    const headers = details.responseHeaders || [];
    const names = new Set(headers.map(header => String(header.name || "").toLowerCase()));
    const fields = [
      "rid=" + request.id, "status=" + details.statusCode,
      "mime=" + (safeHeaderValue(headers, "content-type") || "absent"),
      "content_length=" + (safeHeaderValue(headers, "content-length") || "absent"),
      "content_encoding=" + (safeHeaderValue(headers, "content-encoding") || "absent"),
      "set_cookie_present=" + names.has("set-cookie"),
      "cors_allow_origin_present=" + names.has("access-control-allow-origin")
    ];
    queueEvent(session, "native_response_headers", request.target, fields.join(" "));
  }).catch(() => {});
}
function recordRequestComplete(details) {
  const request = inFlight.get(details.requestId);
  inFlight.delete(details.requestId);
  void activeSessionFor(details).then(session => {
    if (!session || !request) return;
    const elapsed = Math.max(0, Math.round((details.timeStamp || Date.now()) - request.startedAt));
    queueEvent(session, "native_request_complete", request.target,
      "rid=" + request.id + " status=" + details.statusCode + " elapsed_ms=" + elapsed);
  }).catch(() => {});
}
function safeNetworkError(value) {
  const error = String(value || "");
  if (/^NS_ERROR_[A-Z0-9_]{1,48}$/.test(error)) return error;
  if (/^net::ERR_[A-Z0-9_]{1,48}$/.test(error)) return error;
  return "other";
}
function recordRequestError(details) {
  const request = inFlight.get(details.requestId);
  inFlight.delete(details.requestId);
  void activeSessionFor(details).then(session => {
    if (!session || !request) return;
    queueEvent(session, "native_request_error", request.target,
      "rid=" + request.id + " error=" + safeNetworkError(details.error));
  }).catch(() => {});
}


function mediaHostClass(host) {
  host = String(host || "").toLowerCase();
  if (host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
  if (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) return "googlevideo";
  if (host === "googleapis.com" || host.endsWith(".googleapis.com")) return "googleapis";
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  if (host === "127.0.0.1" || host === "::1") return "loopback";
  return "other";
}
function mediaTraceModeForUrl(value) {
  const url = parseUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:" && (host === "youtube.com" || host.endsWith(".youtube.com"))) {
    return "native_youtube";
  }
  if (url.protocol === "http:" && url.port === "5000"
      && (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1")) {
    return "reverse_proxy";
  }
  return null;
}
function classifyMediaRequest(value) {
  const url = parseUrl(value);
  if (!url) return {category: "other", host_class: "other", transport: "unknown", is_media: false};
  const requestHost = url.hostname.toLowerCase();
  let targetHost = requestHost;
  let targetPath = url.pathname;
  const transport = mediaHostClass(requestHost) === "localhost" || mediaHostClass(requestHost) === "loopback"
    ? "proxy" : "native";

  if (transport === "proxy") {
    const marker = "/_/https/";
    const markerIndex = targetPath.indexOf(marker);
    if (markerIndex >= 0) {
      const routedTarget = targetPath.slice(markerIndex + marker.length);
      const slash = routedTarget.indexOf("/");
      if (slash > 0) {
        targetHost = routedTarget.slice(0, slash).toLowerCase();
        targetPath = routedTarget.slice(slash);
      }
    }
  }

  const hostClass = mediaHostClass(targetHost);
  let category = "other";
  if (hostClass === "googlevideo" && targetPath === "/videoplayback") {
    category = url.searchParams.has("sabr") ? "sabr_media" : "media";
  } else if (hostClass === "googlevideo" && /\/sabr_media\/?$/.test(targetPath)) {
    category = "sabr_media";
  } else if (/^\/youtubei\/v1\/(att\/get|att\/log)$/.test(targetPath)) {
    category = "attestation_resource";
  } else if (/^\/\$rpc\/google\.internal\.waa\.v1\.Waa\/(Create|GenerateIT)$/.test(targetPath)
      || /^\/api\/jnn\/v1\/(Create|GenerateIT)$/.test(targetPath)) {
    category = "attestation_rpc";
  } else if (/^\/youtubei\/v1\/(player|get_watch|next)$/.test(targetPath)) {
    category = "innertube_player";
  } else if (targetPath.startsWith("/youtubei/v1/")) {
    category = "innertube_other";
  } else if (/^\/s\/player\/[^/]+\/base\.js$/.test(targetPath)) {
    category = "player_bundle";
  }
  return {
    category,
    host_class: hostClass,
    transport,
    is_media: category === "media" || category === "sabr_media"
  };
}
function mediaTraceSnapshot(includeEvents) {
  if (!mediaTrace) return {status: "not_started"};
  const result = {
    status: mediaTrace.active ? "active" : "stopped",
    schema: mediaTrace.schema,
    schema_version: mediaTrace.schema_version,
    mode: mediaTrace.mode,
    started_at: mediaTrace.started_at,
    stopped_at: mediaTrace.stopped_at || null,
    updated_at: mediaTrace.updated_at || null,
    totals: mediaTrace.totals,
    by_category: mediaTrace.by_category,
    event_count: mediaTrace.events.length,
    dropped_events: mediaTrace.dropped_events,
    in_flight_requests: mediaTraceInFlight.size
  };
  if (includeEvents) result.events = mediaTrace.events.slice();
  return result;
}
function persistMediaTraceMutation(mutation) {
  const task = mediaTraceWriteQueue.then(async () => {
    await mediaTraceReady;
    const changed = await mutation();
    if (changed && mediaTrace) {
      mediaTrace.updated_at = new Date().toISOString();
      await browser.storage.local.set({mediaTrace});
    }
    return mediaTraceSnapshot(false);
  });
  mediaTraceWriteQueue = task.catch(() => null);
  return task;
}
function pushMediaTraceEvent(event) {
  const MAX_EVENTS = 500;
  mediaTrace.events.push(event);
  if (mediaTrace.events.length > MAX_EVENTS) {
    mediaTrace.events.shift();
    mediaTrace.dropped_events++;
  }
}
function categoryCounters(trace, category) {
  if (!trace.by_category[category]) {
    trace.by_category[category] = {
      started: 0, completed: 0, failed: 0, http_error_responses: 0, status_codes: {}
    };
  }
  return trace.by_category[category];
}
function traceRelativeTime(trace, timestamp) {
  return Math.max(0, Math.round((Number(timestamp) || Date.now()) - trace.started_at_ms));
}
function recordMediaRequestStart(details) {
  void persistMediaTraceMutation(() => {
    if (!mediaTrace || !mediaTrace.active || details.tabId !== mediaTrace.tab_id) return false;
    const target = classifyMediaRequest(details.url);
    const method = /^[A-Z]{3,10}$/.test(String(details.method || "").toUpperCase())
      ? String(details.method).toUpperCase() : "OTHER";
    const request = {
      category: target.category,
      host_class: target.host_class,
      transport: target.transport,
      is_media: target.is_media,
      method,
      request_type: String(details.type || "other").slice(0, 24),
      started_at_ms: Number(details.timeStamp) || Date.now()
    };
    mediaTraceInFlight.set(details.requestId, request);
    const counters = categoryCounters(mediaTrace, request.category);
    counters.started++;
    mediaTrace.totals.requests_started++;
    if (request.is_media) mediaTrace.totals.media_requests_started++;
    pushMediaTraceEvent({
      at_ms: traceRelativeTime(mediaTrace, request.started_at_ms),
      event: "start",
      category: request.category,
      host_class: request.host_class,
      transport: request.transport,
      method: request.method,
      request_type: request.request_type
    });
    return true;
  }).catch(() => {});
}
function recordMediaRequestComplete(details) {
  void persistMediaTraceMutation(() => {
    const request = mediaTraceInFlight.get(details.requestId);
    if (!request) return false;
    mediaTraceInFlight.delete(details.requestId);
    if (!mediaTrace || details.tabId !== mediaTrace.tab_id) return false;
    const status = Number.isInteger(details.statusCode) ? details.statusCode : 0;
    const elapsed = Math.max(0, Math.round((Number(details.timeStamp) || Date.now()) - request.started_at_ms));
    const counters = categoryCounters(mediaTrace, request.category);
    counters.completed++;
    if (status >= 400) counters.http_error_responses++;
    if (status) counters.status_codes[String(status)] = (counters.status_codes[String(status)] || 0) + 1;
    mediaTrace.totals.requests_completed++;
    if (request.is_media) mediaTrace.totals.media_requests_completed++;
    if (status >= 400) mediaTrace.totals.http_error_responses++;
    pushMediaTraceEvent({
      at_ms: traceRelativeTime(mediaTrace, details.timeStamp),
      event: "complete",
      category: request.category,
      host_class: request.host_class,
      transport: request.transport,
      request_type: request.request_type,
      status_code: status,
      elapsed_ms: elapsed,
      from_cache: !!details.fromCache
    });
    return true;
  }).catch(() => {});
}
function recordMediaRequestError(details) {
  void persistMediaTraceMutation(() => {
    const request = mediaTraceInFlight.get(details.requestId);
    if (!request) return false;
    mediaTraceInFlight.delete(details.requestId);
    if (!mediaTrace || details.tabId !== mediaTrace.tab_id) return false;
    const elapsed = Math.max(0, Math.round((Number(details.timeStamp) || Date.now()) - request.started_at_ms));
    categoryCounters(mediaTrace, request.category).failed++;
    mediaTrace.totals.requests_failed++;
    if (request.is_media) mediaTrace.totals.media_requests_failed++;
    pushMediaTraceEvent({
      at_ms: traceRelativeTime(mediaTrace, details.timeStamp),
      event: "error",
      category: request.category,
      host_class: request.host_class,
      transport: request.transport,
      request_type: request.request_type,
      elapsed_ms: elapsed,
      network_error: safeNetworkError(details.error)
    });
    return true;
  }).catch(() => {});
}

browser.webRequest.onBeforeRequest.addListener(recordMediaRequestStart, {urls: MEDIA_TRACE_URL_FILTERS});
browser.webRequest.onCompleted.addListener(recordMediaRequestComplete, {urls: MEDIA_TRACE_URL_FILTERS});
browser.webRequest.onErrorOccurred.addListener(recordMediaRequestError, {urls: MEDIA_TRACE_URL_FILTERS});
browser.webRequest.onBeforeRequest.addListener(recordRequestStart, {urls: URL_FILTERS});
browser.webRequest.onBeforeSendHeaders.addListener(recordRequestHeaders, {urls: URL_FILTERS}, ["requestHeaders"]);
browser.webRequest.onHeadersReceived.addListener(recordResponseHeaders, {urls: URL_FILTERS}, ["responseHeaders"]);
browser.webRequest.onCompleted.addListener(recordRequestComplete, {urls: URL_FILTERS});
browser.webRequest.onErrorOccurred.addListener(recordRequestError, {urls: URL_FILTERS});

browser.tabs.onRemoved.addListener(async tabId => {
  try {
    await persistMediaTraceMutation(() => {
      if (!mediaTrace || mediaTrace.tab_id !== tabId || !mediaTrace.active) return false;
      mediaTrace.active = false;
      mediaTrace.stopped_at = new Date().toISOString();
      mediaTraceInFlight.clear();
      return true;
    });
  } catch (_) {}
  const stored = await browser.storage.local.get("nativeSession");
  if (stored.nativeSession && stored.nativeSession.tabId === tabId) {
    const session = stored.nativeSession;
    try {
      await fetch(session.server + "/api/native/sessions/" + encodeURIComponent(session.id), {
        method: "DELETE", headers: {"authorization": "Bearer " + session.token}, cache: "no-store"
      });
    } catch (_) {}
    await browser.storage.local.remove("nativeSession");
    pendingEvents = [];
    inFlight.clear();
  }
});
browser.runtime.onMessage.addListener(async message => {
  if (!message || typeof message.type !== "string") return null;
  if (message.type === "intercept-native:flush") {
    await flushEvents();
    return {ok: true};
  }
  if (message.type === "intercept-media-trace:start") {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) throw new Error("A valid active tab is required.");
    const tab = await browser.tabs.get(tabId);
    const actualMode = mediaTraceModeForUrl(tab && tab.url);
    if (!actualMode || actualMode !== message.mode) {
      throw new Error("The active tab origin changed or is not a supported YouTube/Intercept page.");
    }
    return persistMediaTraceMutation(() => {
      mediaTraceInFlight.clear();
      mediaTrace = {
        schema: "intercept-media-request-trace",
        schema_version: 1,
        mode: actualMode,
        tab_id: tabId,
        active: true,
        started_at: new Date().toISOString(),
        started_at_ms: Date.now(),
        stopped_at: null,
        updated_at: null,
        totals: {
          requests_started: 0,
          requests_completed: 0,
          requests_failed: 0,
          media_requests_started: 0,
          media_requests_completed: 0,
          media_requests_failed: 0,
          http_error_responses: 0
        },
        by_category: {},
        events: [],
        dropped_events: 0
      };
      return true;
    });
  }
  if (message.type === "intercept-media-trace:snapshot"
      || message.type === "intercept-media-trace:stop"
      || message.type === "intercept-media-trace:export") {
    const tabId = Number(message.tabId);
    const result = await persistMediaTraceMutation(() => {
      if (!mediaTrace || mediaTrace.tab_id !== tabId) return false;
      if (message.type === "intercept-media-trace:stop" && mediaTrace.active) {
        mediaTrace.active = false;
        mediaTrace.stopped_at = new Date().toISOString();
        mediaTraceInFlight.clear();
        return true;
      }
      return false;
    });
    if (!mediaTrace || mediaTrace.tab_id !== tabId) return {status: "not_started"};
    return message.type === "intercept-media-trace:export"
      ? mediaTraceSnapshot(true) : result;
  }
  return null;
});
