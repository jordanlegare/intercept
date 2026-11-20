const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "youtube_player_api.js"), "utf8");
const KEY = "__standaloneYouTubePlayerApiV1";

function loadBridge() {
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Number,
    Array,
    Set,
    Object,
    String,
    Error,
    Math
  });
  vm.runInContext(source, context, {filename: "youtube_player_api.js"});
  return context[KEY];
}

function makePlayer(video, initialId = "video-123") {
  let state = 2;
  let currentTime = 8;
  let videoId = initialId;
  const listeners = new Set();
  const calls = [];
  const exposed = [
    "playVideo", "getPlayerState", "getCurrentTime", "getVideoData",
    "wakeUpControls", "addEventListener", "removeEventListener"
  ];
  const player = {
    isConnected: true,
    getApiInterface() { return exposed; },
    getVideoData() { return {video_id: videoId}; },
    getPlayerState() { return state; },
    getCurrentTime() { return currentTime; },
    wakeUpControls() { calls.push("wakeUpControls"); },
    addEventListener(name, callback) {
      assert.equal(name, "onStateChange");
      listeners.add(callback);
    },
    removeEventListener(name, callback) {
      assert.equal(name, "onStateChange");
      listeners.delete(callback);
    },
    playVideo() {
      calls.push("playVideo");
      setTimeout(() => {
        state = 3;
        for (const listener of listeners) listener(3);
      }, 15);
      setTimeout(() => {
        state = 1;
        currentTime += 0.5;
        video.paused = false;
        for (const listener of listeners) listener({data: 1});
      }, 80);
    },
    setVideoId(value) { videoId = value; },
    calls,
    listenerCount() { return listeners.size; }
  };
  return player;
}

test("waits for the player API to expose the selected video", async () => {
  const bridge = loadBridge();
  const video = {paused: true, ended: false, isConnected: true, currentTime: 0, error: null};
  const player = makePlayer(video, "stale-video");
  const doc = {getElementById: () => player, querySelector: () => player};

  setTimeout(() => player.setVideoId("video-123"), 30);
  const api = await bridge.waitForPlayerApi(doc, "video-123", 600);

  assert.equal(api.player, player);
  assert.equal(api.videoId, "video-123");
  assert.ok(api.methods.has("playVideo"));
});

test("wakes YouTube controls, calls playVideo, and confirms PLAYING plus time advance", async () => {
  const bridge = loadBridge();
  const video = {paused: true, ended: false, isConnected: true, currentTime: 8, error: null};
  const player = makePlayer(video);
  const doc = {getElementById: () => player, querySelector: () => player};
  const api = await bridge.waitForPlayerApi(doc, "video-123", 100);
  const result = await bridge.startPlayback(api, video, {timeoutMs: 900});

  assert.deepEqual(player.calls, ["wakeUpControls", "playVideo"]);
  assert.equal(result.state, 1);
  assert.ok(result.currentTime > 8.12);
  assert.equal(player.listenerCount(), 0);
});

test("reports Firefox autoplay rejection when the player API cannot start playback", async () => {
  const bridge = loadBridge();
  const video = {
    paused: true,
    ended: false,
    isConnected: true,
    currentTime: 0,
    error: null,
    play() {
      const error = new Error("The request is not allowed by the user agent.");
      error.name = "NotAllowedError";
      return Promise.reject(error);
    }
  };
  const player = makePlayer(video);
  player.playVideo = () => {};
  const doc = {getElementById: () => player, querySelector: () => player};
  const api = await bridge.waitForPlayerApi(doc, "video-123", 100);

  await assert.rejects(
    bridge.startPlayback(api, video, {timeoutMs: 120}),
    /Firefox blocked automatic YouTube playback \(NotAllowedError\)/
  );
  assert.equal(player.listenerCount(), 0);
});