"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../capture_core.js");

test("watch URLs identify the video independently of playlist and time parameters", () => {
  const first = Core.buildVideoIdentity({
    href: "https://www.youtube.com/watch?v=AbCd_123&list=PL123&index=1&t=20",
    title: "First video",
    mediaSource: "blob:first",
    at: 1000
  });
  const refreshed = Core.buildVideoIdentity({
    href: "https://www.youtube.com/watch?v=AbCd_123&list=PL999&index=7&t=240",
    title: "First video (updated)",
    mediaSource: "blob:refreshed",
    at: 2000
  });
  assert.equal(first.videoId, "AbCd_123");
  assert.equal(Core.sameVideoIdentity(first, refreshed), true);
  assert.notEqual(first.filename, refreshed.filename);
});

test("changing the selected video produces a new identity even when the player node is reused", () => {
  const first = Core.buildVideoIdentity({
    href: "https://www.youtube.com/watch?v=VIDEO_A",
    title: "Video A",
    mediaSource: "blob:same-element",
    at: 1000
  });
  const second = Core.buildVideoIdentity({
    href: "https://www.youtube.com/watch?v=VIDEO_B",
    title: "Video B",
    mediaSource: "blob:same-element",
    at: 2000
  });
  assert.equal(Core.sameVideoIdentity(first, second), false);
  assert.match(first.filename, /Video A-VIDEO_A-/);
  assert.match(second.filename, /Video B-VIDEO_B-/);
});

test("Shorts, live and embed paths produce stable video IDs", () => {
  assert.equal(Core.extractVideoId("https://www.youtube.com/shorts/SHORT_01"), "SHORT_01");
  assert.equal(Core.extractVideoId("https://www.youtube.com/live/LIVE_01"), "LIVE_01");
  assert.equal(Core.extractVideoId("https://www.youtube.com/embed/EMBED_01"), "EMBED_01");
  assert.equal(Core.extractVideoId("https://youtu.be/SHORT_URL_1"), "SHORT_URL_1");
});

test("filenames are sanitized and always include a video identity", () => {
  const identity = Core.buildVideoIdentity({
    href: "https://www.youtube.com/watch?v=FILE_ID",
    title: '  A "Title" / With: Unsafe Bits  ',
    at: 1234
  });
  assert.equal(identity.title, "A _Title_ _ With_ Unsafe Bits");
  assert.match(identity.filename, /^A _Title_ _ With_ Unsafe Bits-FILE_ID-/);
  assert.ok(identity.filename.endsWith(".webm"));
});

test("session manager accounts for pause time and exposes the lifecycle timeline", () => {
  const identity = Core.buildVideoIdentity({
    href: "https://www.youtube.com/watch?v=SESSION_A",
    title: "Session A",
    at: 0
  });
  const manager = new Core.CaptureSessionManager();
  manager.begin(identity, 1000);
  assert.equal(manager.pause(4000), true);
  assert.equal(manager.snapshot(6000).elapsedMs, 3000);
  assert.equal(manager.resume(9000), true);
  assert.equal(manager.snapshot(12000).elapsedMs, 6000);
  const ended = manager.finish("manual_stop", 15000);
  assert.equal(ended.stopReason, "manual_stop");
  assert.equal(ended.elapsedMs, 9000);
  assert.equal(ended.events.filter(event => event.type === "paused").length, 1);
  assert.equal(manager.snapshot(), null);
});

test("split and source-change sessions finalize separately", () => {
  const manager = new Core.CaptureSessionManager();
  const first = Core.buildVideoIdentity({href:"https://www.youtube.com/watch?v=ONE",title:"One",at:1});
  const second = Core.buildVideoIdentity({href:"https://www.youtube.com/watch?v=TWO",title:"Two",at:2});
  const one = manager.begin(first, 10);
  const closed = manager.finish("source_changed", 20);
  const two = manager.begin(second, 30);
  assert.notEqual(one.id, two.id);
  assert.equal(closed.videoId, "ONE");
  assert.equal(closed.stopReason, "source_changed");
  assert.equal(two.videoId, "TWO");
});

test("only completed, source-changed, split and manual-stop captures are saved", () => {
  for (const reason of ["complete", "source_changed", "split", "manual_stop"]) {
    assert.equal(Core.shouldSaveStopReason(reason), true, reason);
  }
  for (const reason of ["discard", "disabled", "error", "ad"]) {
    assert.equal(Core.shouldSaveStopReason(reason), false, reason);
  }
});

test("rapid consecutive video changes cannot merge session identities", () => {
  const manager = new Core.CaptureSessionManager();
  const identities = ["A","B","C","D"].map((id, index) =>
    Core.buildVideoIdentity({
      href: "https://www.youtube.com/watch?v=" + id,
      title: "Video " + id,
      at: index + 1
    })
  );
  const sessions = [];
  for (let i = 0; i < identities.length; i++) {
    sessions.push(manager.begin(identities[i], i * 100));
    if (i < identities.length - 1) {
      const ended = manager.finish("source_changed", i * 100 + 50);
      assert.equal(ended.videoId, identities[i].videoId);
    }
  }
  assert.equal(new Set(sessions.map(session => session.id)).size, 4);
  assert.deepEqual(sessions.map(session => session.videoId), ["A","B","C","D"]);
});


test("a document reload reconciles in-flight captures into explicit recoverable or interrupted states", () => {
  const withFile = Core.reconcileInterruptedCapture("recording", true);
  assert.equal(withFile.status, "failed");
  assert.equal(withFile.fileAvailable, true);
  assert.match(withFile.error, /may be incomplete/);

  const withoutFile = Core.reconcileInterruptedCapture("finalizing", false);
  assert.equal(withoutFile.status, "interrupted");
  assert.equal(withoutFile.fileAvailable, false);
  assert.match(withoutFile.error, /recoverable recording file/);

  assert.equal(Core.reconcileInterruptedCapture("downloaded", true), null);
});


test("serialized recording writer flushes the final recorder chunk before closing", async () => {
  const written = [];
  const fakeWriter = {
    async write(chunk) {
      await Promise.resolve();
      written.push(chunk.label);
    },
    async close() { written.push("closed"); },
    async abort(reason) { written.push("aborted:" + reason); }
  };
  const writer = new Core.SerializedChunkWriter(fakeWriter);
  writer.enqueue({size: 10, label: "periodic-chunk"});
  writer.enqueue({size: 5, label: "final-dataavailable-chunk"});
  await writer.close();
  assert.deepEqual(written, ["periodic-chunk", "final-dataavailable-chunk", "closed"]);
  await assert.rejects(writer.enqueue({size: 1, label: "too-late"}), /already closed/);
});

test("discard aborts the serialized recording writer after queued chunks settle", async () => {
  const written = [];
  const fakeWriter = {
    async write(chunk) { written.push(chunk.label); },
    async close() { written.push("closed"); },
    async abort(reason) { written.push("aborted:" + reason); }
  };
  const writer = new Core.SerializedChunkWriter(fakeWriter);
  writer.enqueue({size: 7, label: "partial-chunk"});
  await writer.abort("user discarded");
  assert.deepEqual(written, ["partial-chunk", "aborted:user discarded"]);
});


test("overlay activation accepts only HTTPS www.youtube.com tabs", () => {
  assert.equal(Core.isSupportedOverlayUrl("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(Core.isSupportedOverlayUrl("https://www.youtube.com/shorts/abc"), true);
  assert.equal(Core.isSupportedOverlayUrl("http://www.youtube.com/watch?v=abc"), false);
  assert.equal(Core.isSupportedOverlayUrl("https://youtube.com/watch?v=abc"), false);
  assert.equal(Core.isSupportedOverlayUrl("https://m.youtube.com/watch?v=abc"), false);
  assert.equal(Core.isSupportedOverlayUrl("https://music.youtube.com/watch?v=abc"), false);
  assert.equal(Core.isSupportedOverlayUrl("https://www.youtube.com:444/watch?v=abc"), false);
});
