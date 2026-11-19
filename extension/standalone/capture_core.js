((root, factory) => {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.defineProperty(root, "__standalonePlaybackCoreV1", {
    value: api, configurable: false, enumerable: false, writable: false
  });
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function safeTitle(value) {
    return String(value || "youtube-playback")
      .replace(/\s+-\s+YouTube\s*$/i, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 110) || "youtube-playback";
  }

  function extractVideoId(href) {
    let url;
    try { url = new URL(href); } catch (_) { return ""; }
    const pathMatch = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{1,24})/i);
    const hostMatch = url.hostname.toLowerCase() === "youtu.be"
      ? url.pathname.match(/^\/([A-Za-z0-9_-]{1,24})/)
      : null;
    const raw = url.searchParams.get("v") || (pathMatch && pathMatch[1]) || (hostMatch && hostMatch[1]) || "";
    return /^[A-Za-z0-9_-]{1,24}$/.test(raw) ? raw : "";
  }

  function buildVideoIdentity({href, title, mediaSource = "", at = new Date()} = {}) {
    let url;
    try { url = new URL(href || "https://www.youtube.com/"); }
    catch (_) { url = new URL("https://www.youtube.com/"); }
    const videoId = extractVideoId(url.href);
    const safe = safeTitle(title);
    const key = videoId
      ? "youtube:" + videoId
      : "page:" + url.origin + url.pathname + "|media:" + String(mediaSource || "");
    const canonicalUrl = videoId
      ? (/^\/shorts\//i.test(url.pathname)
        ? "https://www.youtube.com/shorts/" + videoId
        : "https://www.youtube.com/watch?v=" + videoId)
      : url.origin + url.pathname;
    const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
    return Object.freeze({
      key, videoId, title: safe, canonicalUrl,
      mediaSource: String(mediaSource || ""),
      filename: safe + (videoId ? "-" + videoId : "") + "-" + stamp + ".webm"
    });
  }

  function sameVideoIdentity(a, b) {
    if (!a || !b) return false;
    if (a.videoId && b.videoId) return a.videoId === b.videoId;
    return a.key === b.key;
  }

  function shouldSaveStopReason(reason) {
    return ["complete", "source_changed", "manual_stop", "split"].includes(reason);
  }

  class CaptureSessionManager {
    constructor() {
      this.active = null;
      this.sequence = 0;
    }

    begin(identity, at = Date.now()) {
      if (this.active) throw new Error("A capture session is already active.");
      this.active = {
        id: "session-" + (++this.sequence),
        videoKey: identity.key,
        videoId: identity.videoId || "",
        title: identity.title,
        canonicalUrl: identity.canonicalUrl,
        filename: identity.filename,
        state: "recording",
        startedAt: at,
        endedAt: null,
        pausedAt: null,
        pausedMs: 0,
        stopReason: null,
        events: [{type: "recording_started", at}]
      };
      return this.snapshot(at);
    }

    matches(identity) {
      return !!this.active && this.active.videoKey === identity.key;
    }

    pause(at = Date.now(), source = "manual") {
      if (!this.active || this.active.state !== "recording") return false;
      this.active.state = "paused";
      this.active.pausedAt = at;
      this.active.events.push({type: "paused", source, at});
      return true;
    }

    resume(at = Date.now(), source = "manual") {
      if (!this.active || this.active.state !== "paused") return false;
      this.active.pausedMs += Math.max(0, at - this.active.pausedAt);
      this.active.pausedAt = null;
      this.active.state = "recording";
      this.active.events.push({type: "resumed", source, at});
      return true;
    }

    finish(reason, at = Date.now()) {
      if (!this.active) return null;
      const session = this.active;
      if (session.state === "paused" && session.pausedAt !== null) {
        session.pausedMs += Math.max(0, at - session.pausedAt);
        session.pausedAt = null;
      }
      session.state = "finalizing";
      session.stopReason = reason;
      session.endedAt = at;
      session.events.push({type: "recording_stopped", reason, at});
      const result = this.snapshot(at);
      this.active = null;
      return result;
    }

    snapshot(at = Date.now()) {
      if (!this.active) return null;
      const s = this.active;
      const pausedNow = s.pausedAt === null ? 0 : Math.max(0, at - s.pausedAt);
      return {
        ...s,
        events: s.events.map(event => ({...event})),
        elapsedMs: Math.max(0, at - s.startedAt - s.pausedMs - pausedNow)
      };
    }
  }

  return Object.freeze({
    safeTitle, extractVideoId, buildVideoIdentity, sameVideoIdentity,
    shouldSaveStopReason, CaptureSessionManager
  });
});
