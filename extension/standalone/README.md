# Playback Capture for Firefox 1.3.7

Playback Capture is a standalone Firefox add-on that queues selected YouTube videos, starts playback through YouTube's exposed player API, and records the decoded player output to WebM files. It has its own background queue, capture session manager, temporary file library, recovery flow, toolbar dashboard, and Firefox download bridge. It does not connect to the Intercept Rust server.

## 1.3.7 — Native YouTube player API

- Player startup now uses the exposed `#movie_player` API. The extension waits for the selected video ID and the required methods, calls `wakeUpControls()` when available, then calls `playVideo()`.
- Startup listens for the YouTube `onStateChange` event and verifies both the `PLAYING` state and advancing playback time before initializing MediaRecorder. A visible Play button is no longer the primary startup mechanism.
- The helper tab is temporarily brought to the foreground during startup and returned to the background after recording is confirmed. The user's own tab switch is respected.
- Startup and player readiness have bounded timeouts and actionable errors. The one-at-a-time capture queue and serialized Firefox download queue are retained.

### Required Firefox autoplay permission

**For unattended queue processing, allow autoplay for YouTube before selecting videos.** Calling YouTube's `playVideo()` method is still an autoplay request; the player API cannot override Firefox's autoplay policy. Firefox normally blocks media with sound by default, and it can also defer autoplay in a background tab until that tab is brought to the foreground.

Recommended site-specific setup:

1. Open `https://www.youtube.com` in Firefox.
2. Open Firefox **Settings → Privacy & Security → Permissions → Autoplay → Settings…**.
3. Find `youtube.com` in the site list and set its permission to **Allow Audio and Video**. If it is not listed yet, use the autoplay permission control in the address bar while YouTube is open, or open Page Info → Permissions → Autoplay and change the site from its default.
4. Click **Save Changes**, then reload YouTube.

You can instead set **Default for all websites → Allow Audio and Video** in the Autoplay settings. That is a broader permission and affects other sites too; a specific YouTube site permission takes precedence over the default.

When this permission is blocked, a queued job may stop in the `ALLOW PLAY` state. That label means the first automatic playback attempt was rejected and the job is waiting for a retry. Clicking it requeues the job and retries startup with the helper tab foregrounded; it does **not** grant Firefox autoplay permission. Change the permission first, then click `ALLOW PLAY` to retry the waiting job. New queue selections should then start automatically, subject to YouTube/player readiness and network conditions.

## Use

1. Install the XPI (see **Install for testing** below), set YouTube's autoplay permission as described above, and reload any YouTube tabs that were already open.
2. Browse YouTube normally. Red `REC` controls appear on supported video cards and beside the like controls on a watch page.
3. Click a card's `REC` control to add that video to the persistent FIFO capture queue without navigating the browsing tab. The extension opens a dedicated YouTube helper tab, briefly activates it for playback startup, starts the recording when playback is confirmed, and restores the previously active tab.
4. Capture jobs run one at a time. Finalized WebM files enter a separate FIFO download queue, with only one Firefox download started at a time.
5. While a video is recording, its button pulses red. Click it again to stop and save. A completed video is finalized automatically when playback ends.
6. Use the Playback Capture toolbar action to open the dark dashboard and view the queue, capture history, timeline, and recovery actions. On a watch page, the `REC` control records the video already open.

If a job remains at `ALLOW PLAY`, verify the site-specific autoplay permission first. If playback still does not start, inspect the job's error/phase in the dashboard; a player error, ad, unavailable video, or network issue can also prevent startup.

## Earlier changes

### 1.3.6 — Automated startup attempt

- Added player readiness checks, a foreground helper-tab startup phase, playback-progress verification, and an explicit Firefox autoplay error.
- The helper tab is returned to the previous tab after recording is confirmed, provided the user has not switched tabs in the meantime.

### 1.3.5 — Persistent ordered queue

- Added persistent ordered REC selections and retained source-path tracking.
- Capture workers and Firefox downloads run sequentially.

### 1.3.4 — Thumbnail REC placement

- Moved the REC control into the thumbnail link as a top overlay. Clicking REC cancels the thumbnail navigation; clicking elsewhere on the thumbnail still opens the video normally.

### 1.3.3 — Thumbnail control placement

- Moved the thumbnail REC control to the left side.

### 1.3.0 — Initial background queue

- Added per-video REC controls, helper YouTube tabs, WebM capture, a dark queue overlay, and serialized download handling.

## Install for testing

1. Download [youtube-playback-download-1.3.7.xpi](../youtube-playback-download-1.3.7.xpi).
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on** and select the downloaded XPI.
4. Reload any YouTube tab that was already open.
5. Pin Playback Capture from Firefox's Extensions menu.

Temporary installations are removed when Firefox restarts. This repository XPI is an unsigned development package. Standard Firefox release builds require a Mozilla-signed add-on for normal, persistent installation.

## Independent operation and permissions

The extension does not connect to Intercept, create an Intercept session, inspect media network requests, rewrite traffic, or depend on the original Intercept extension. It requests `activeTab`, `scripting`, `downloads`, `storage`, and `unlimitedStorage`; content scripts are restricted to HTTPS YouTube domains.

Capture files use the browser's origin-private file system (OPFS), and history records use IndexedDB. A downloaded temporary copy is retained for up to 24 hours to support recovery. Failed and interrupted files are retained for up to seven days. If a tab closes before MediaRecorder writes its finalization data, a retained partial recording is offered for best-effort recovery and may not play correctly. Deleting a history item also deletes its temporary file.

## Technical limits

- **Autoplay is browser-controlled.** The native YouTube player API does not bypass Firefox autoplay permissions or browser user-activation requirements. Allow Audio and Video for YouTube for automatic queued startup. The extension temporarily foregrounds the helper tab because Firefox may defer background-tab autoplay.
- **This is a decoded playback capture.** It records the rendered player output through `captureStream()` and `MediaRecorder`, re-encoded as WebM. It is not YouTube's original media file, a dump of Firefox's HTTP cache, or a copy of the original network segments. Quality, size, timing, and codec may differ from the source.
- **DRM/EME-protected playback may not expose capturable tracks.** The add-on does not bypass DRM, decrypt protected media, retrieve source segments, or defeat access controls.
- YouTube can change its internal player interface. If the exposed player methods or event behavior changes, startup may need an adapter update. Player errors, advertisements, network conditions, Firefox settings, and available storage can also affect capture.
- Captures have a 2 GiB safety limit and are also bounded by available origin-private storage.

## Source layout

- `manifest.json` — Firefox Manifest V3 permissions and YouTube-only content-script scope.
- `capture_core.js` — deterministic identity, filename, and session-state primitives shared by runtime and tests.
- `youtube_player_api.js` — readiness checks and adapter for YouTube's exposed player API, player-state events, and playback confirmation.
- `video_download.js` — media-element capture, OPFS file lifecycle, session state, IndexedDB history, and recovery API.
- `download_bridge.js` — isolated-world bridge for Firefox download lifecycle messages.
- `background.js` — validates source tabs, schedules one capture job at a time, foregrounds helper tabs for startup, and serializes Firefox downloads.
- `overlay.js` — dark dashboard, background capture queue, mount lifecycle, and player/SPA refresh handling.
- `inline_record.js` — per-video red `REC` buttons, card discovery, watch-page placement, and job-state synchronization.
- `popup.html`, `popup.css`, `popup.js` — retained extension-page dashboard assets; the toolbar action activates the in-page overlay.
- `tests/capture_core.test.js` — capture-session and identity tests.
- `tests/youtube_player_api.test.js` — player readiness, API startup, playback confirmation, and autoplay-rejection tests.

The XPI is built from this directory with the manifest at the archive root.
