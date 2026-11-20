# Playback Capture for Firefox 1.4.2

## 1.4.2 — Firefox built-in data collection declaration

- Added Firefox's `browser_specific_settings.gecko.data_collection_permissions` declaration with `required: ["none"]`.
- Playback Capture keeps the capture queue, video metadata, session history, and WebM data in the local browser and local download destination. It does not transmit this information to an external service.

## 1.4.1 — Firefox autoplay permission handoff

- When Firefox blocks playback, the helper tab stays foregrounded so Firefox's native autoplay-blocked address-bar control is visible.
- The helper tab stays in front after Firefox blocks playback, exposing Firefox's native autoplay-blocked address-bar control. Click it and allow **Audio and Video** for `www.youtube.com`, then return to the source tab and click **RETRY**.
- The dashboard queue exposes the same **RETRY** action. The extension does not change Firefox preferences or grant autoplay itself; Firefox requires the user to approve the site exception.

## 1.3.9 — Standby timer visibility

- The elapsed-time tile stays hidden while capture is idle, armed, or preparing. It appears after recording starts and remains visible through pause, finalization, and download states.

Playback Capture is a standalone Firefox add-on that queues selected YouTube videos, starts playback through YouTube's exposed player API, and records the decoded player output to WebM files. It has its own background queue, capture session manager, temporary file library, recovery flow, toolbar dashboard, and Firefox download bridge. It does not connect to the Intercept Rust server.

## 1.3.8 — Queue startup recovery

- The queue explicitly injects and verifies the native player API adapter before invoking the recorder, including when reusing an already-open helper tab.
- Player startup gets one bounded retry in the same helper tab for transient initialization failures.
- A pre-roll advertisement is allowed to finish before MediaRecorder attaches to the selected video's playback.
- Startup failures no longer immediately destroy an owned helper tab. The queue retains it and exposes **RETRY** (or **ALLOW PLAY** for a Firefox autoplay rejection); retry reuses the same YouTube player rather than opening a second tab.
- Retained retry jobs survive background-worker restarts and can be cancelled from either the card button or dashboard.

## 1.3.7 — Native YouTube player API

- Player startup now uses the exposed `#movie_player` API. The extension waits for the selected video ID and the required methods, calls `wakeUpControls()` when available, then calls `playVideo()`.
- Startup listens for the YouTube `onStateChange` event and verifies both the `PLAYING` state and advancing playback time before initializing MediaRecorder. A visible Play button is no longer the primary startup mechanism.
- The helper tab is temporarily brought to the foreground during startup and returned to the background after recording is confirmed. The user's own tab switch is respected.
- Startup and player readiness wait without a time limit; actionable errors are still surfaced when YouTube or Firefox explicitly rejects startup. The one-at-a-time capture queue and serialized Firefox download queue are retained.

### Required Firefox autoplay permission

**For unattended queue processing, allow autoplay for YouTube before selecting videos.** Calling YouTube's `playVideo()` method is still an autoplay request; the player API cannot override Firefox's autoplay policy. Firefox normally blocks media with sound by default, and it can also defer autoplay in a background tab until that tab is brought to the foreground.

Recommended site-specific setup:

1. Open `https://www.youtube.com` in Firefox.
2. Open Firefox **Settings → Privacy & Security → Permissions → Autoplay → Settings…**.
3. Find `youtube.com` in the site list and set its permission to **Allow Audio and Video**. If it is not listed yet, use the autoplay permission control in the address bar while YouTube is open, or open Page Info → Permissions → Autoplay and change the site from its default.
4. Click **Save Changes**, then reload YouTube.

You can instead set **Default for all websites → Allow Audio and Video** in the Autoplay settings. That is a broader permission and affects other sites too; a specific YouTube site permission takes precedence over the default.

When this permission is blocked, the helper tab remains foregrounded so Firefox's native autoplay-blocked control is visible beside the address bar. Open it and select **Allow Audio and Video** for `www.youtube.com`. Return to the original YouTube tab and click `RETRY` to resume the same queued selection. The extension cannot open or accept Firefox's native permission panel on the user's behalf. Other transient startup failures show `RETRY`, also reusing the same helper tab. Pre-roll advertisements are allowed to finish before recording begins.

## Use

1. Install the XPI (see **Install for testing** below), use `SET AUTOPLAY` if Firefox blocks playback, and reload any YouTube tabs that were already open.
2. Browse YouTube normally. Red `REC` controls appear on supported video cards and beside the like controls on a watch page.
3. Click a card's `REC` control to add that video to the persistent FIFO capture queue without navigating the browsing tab. The extension opens a dedicated YouTube helper tab, briefly activates it for playback startup, starts the recording when playback is confirmed, and restores the previously active tab.
4. Capture jobs run one at a time. Finalized WebM files enter a separate FIFO download queue, with only one Firefox download started at a time.
5. While a video is recording, its button pulses red. Click it again to stop and save. A completed video is finalized automatically when playback ends.
6. Use the Playback Capture toolbar action to open the dark dashboard and view the queue, capture history, timeline, and recovery actions. On a watch page, the `REC` control records the video already open.

If a job remains at `RETRY` after an autoplay rejection, verify the site-specific autoplay permission first. If playback still does not start, inspect the job's error/phase in the dashboard; a player error, ad, unavailable video, or network issue can also prevent startup.

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

1. Download [youtube-playback-download-1.4.2.xpi](../youtube-playback-download-1.4.2.xpi).
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

The queue has one active capture slot. An autoplay rejection or transient startup failure retains its helper tab and reserves the slot until the job is retried or cancelled. The XPI is built from this directory with the manifest at the archive root.
