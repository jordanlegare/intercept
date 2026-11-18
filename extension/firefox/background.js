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
  const stored = await browser.storage.local.get("nativeSession");
  const session = stored.nativeSession;
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
  if (name === "content-length") return /^\\d{1,15}$/.test(raw) ? raw : "absent";
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

browser.webRequest.onBeforeRequest.addListener(recordRequestStart, {urls: URL_FILTERS});
browser.webRequest.onBeforeSendHeaders.addListener(recordRequestHeaders, {urls: URL_FILTERS}, ["requestHeaders"]);
browser.webRequest.onHeadersReceived.addListener(recordResponseHeaders, {urls: URL_FILTERS}, ["responseHeaders"]);
browser.webRequest.onCompleted.addListener(recordRequestComplete, {urls: URL_FILTERS});
browser.webRequest.onErrorOccurred.addListener(recordRequestError, {urls: URL_FILTERS});

browser.tabs.onRemoved.addListener(async tabId => {
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
  if (!message || message.type !== "intercept-native:flush") return null;
  await flushEvents();
  return {ok: true};
});
