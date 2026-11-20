const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const downloader = fs.readFileSync(path.join(root, "video_download.js"), "utf8");
const apiSource = fs.readFileSync(path.join(root, "youtube_player_api.js"), "utf8");
const inline = fs.readFileSync(path.join(root, "inline_record.js"), "utf8");
const overlay = fs.readFileSync(path.join(root, "overlay.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupCss = fs.readFileSync(path.join(root, "popup.css"), "utf8");
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

test("startup has no deadline and waits for player initialization and pre-roll ads", () => {
  assert.match(background, /for \(let attempt = 1; attempt <= 2; attempt\+\+\)/);
  assert.match(background, /await runCaptureCommand\(job\.tabId,"record-video"/);
  assert.match(background, /Deliberately wait without a startup deadline/);
  assert.doesNotMatch(background, /Startup timed out after|150000|Promise\.race\(\[/);
  assert.match(apiSource, /async function waitForPlayerApi\(doc, expectedVideoId\)\s*\{\s*while \(true\)/);
  assert.match(apiSource, /async function waitForPlaybackToAdvance\(api, video, initialTime, lastEventState\)\s*\{\s*const player = api\.player;\s*while \(true\)/);
  assert.doesNotMatch(apiSource, /timeoutMs|deadline|timed out/);
  assert.match(downloader, /async function waitForAdvertisementToFinish\(video\)\s*\{/);
  assert.match(downloader, /async function waitForPlayerVideo\(\)\s*\{/);
  assert.doesNotMatch(downloader, /withCaptureTimeout|within 30 seconds|within 90 seconds|within 20 seconds/);
  assert.match(downloader, /video = await waitForAdvertisementToFinish\(video\)/);
});

test("REC and dashboard expose retry and cancellation", () => {
  assert.match(inline, /awaiting_retry:"RETRY"/);
  assert.match(inline, /\["failed","interrupted","awaiting_autoplay","awaiting_retry"\]/);
  assert.match(overlay, /"awaiting_autoplay","awaiting_retry"\]\.includes\(job\.state\)/);
});


test("elapsed timer stays hidden during standby and player initialization", () => {
  for (const source of [overlay, popup]) {
    assert.match(source, /function shouldShowElapsed\(status\)/);
    assert.match(source, /\["recording", "paused", "finalizing", "download_started", "download_failed"\]/);
  }
  assert.match(overlay, /\$\("elapsed-stat"\)\.hidden = !showElapsed/);
  assert.match(popup, /elapsedStat\.hidden = !showElapsed/);
  assert.match(popup, /stats\.classList\.toggle\("without-elapsed", !showElapsed\)/);
  assert.match(popupHtml, /id="elapsed-stat"/);
  assert.match(popupCss, /\.stats\.without-elapsed/);
});

test("Firefox autoplay rejection exposes the native permission control and retries the same job", () => {
  assert.match(background, /keepHelperActiveForAutoplay/);
  assert.match(background, /autoplayPermissionHelpOpenedAt/);
  assert.match(background, /Firefox's autoplay-blocked address-bar icon/);
  assert.match(background, /browser\\.tabs\\.update\\(tab\\.id,\\{active:true\\}\\)/);
  assert.match(inline, /awaiting_autoplay:job\\.autoplayPermissionHelpOpened\\?"RETRY":"SET AUTOPLAY"/);
  assert.match(overlay, /job-allow/);
  assert.match(overlay, /SET AUTOPLAY/);
});
