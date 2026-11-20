const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const downloader = fs.readFileSync(path.join(root, "video_download.js"), "utf8");
const inline = fs.readFileSync(path.join(root, "inline_record.js"), "utf8");
const overlay = fs.readFileSync(path.join(root, "overlay.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("capture startup injects the native player API before the recorder runtime", () => {
  assert.match(background, /playerApi:!!globalThis\.__standaloneYouTubePlayerApiV1/);
  assert.match(background, /files:\["youtube_player_api\.js"\]/);
  const probe = background.indexOf("playerApi:!!globalThis.__standaloneYouTubePlayerApiV1");
  const adapter = background.indexOf('files:["youtube_player_api.js"]', probe);
  const runtime = background.indexOf('files:["video_download.js"]', adapter);
  assert.ok(probe >= 0 && adapter > probe && runtime > adapter);
  assert.ok(manifest.content_scripts.some(entry =>
    entry.world === "MAIN"
      && entry.js.indexOf("youtube_player_api.js") < entry.js.indexOf("video_download.js")
  ));
});

test("transient startup failures retain the helper tab and reserve the queue slot", () => {
  assert.match(background, /job\.state=autoplayBlocked \? "awaiting_autoplay" : "awaiting_retry"/);
  assert.match(background, /job\.slot=true/);
  assert.match(background, /Click RETRY to resume this same selection/);
  assert.match(background, /\["awaiting_autoplay","awaiting_retry"\]\.includes\(job\.state\)/);
  assert.match(background, /if\(job\.state==="queued" \|\| job\.state==="awaiting_autoplay" \|\| job\.state==="awaiting_retry"\)/);
});

test("the startup path retries once in-place and waits for a pre-roll ad", () => {
  assert.match(background, /for \(let attempt = 1; attempt <= 2; attempt\+\+\)/);
  assert.match(background, /retrying in the same helper tab/);
  assert.match(downloader, /async function waitForAdvertisementToFinish/);
  assert.match(downloader, /video = await waitForAdvertisementToFinish\(video\)/);
});

test("REC and dashboard expose retry and cancellation", () => {
  assert.match(inline, /awaiting_retry:"RETRY"/);
  assert.match(inline, /\["failed","interrupted","awaiting_autoplay","awaiting_retry"\]/);
  assert.match(overlay, /"awaiting_autoplay","awaiting_retry"\]\.includes\(job\.state\)/);
});
