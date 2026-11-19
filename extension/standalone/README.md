# Playback Capture for Firefox 1.3.0

An independent Firefox add-on that captures decoded playback output from YouTube and saves it as WebM files. It has its own capture session manager, local capture library, recovery flow, toolbar dashboard, and download bridge. It does not connect to the Intercept Rust server.

## What changed in 1.3.0

- Per-video record buttons: red `REC` controls appear on video thumbnails across YouTube browse/search/channel surfaces, and immediately before the like controls on a watch page.
- Background recording queue: selecting a thumbnail opens an inactive YouTube player tab, starts ordinary playback, streams the decoded player output through MediaRecorder into extension-managed OPFS storage, then asks Firefox Downloads to save the WebM. The helper tab closes after the download finishes.
- Concurrent jobs: the background scheduler runs up to three capture tabs concurrently and queues additional selections. Each capture has an independent page recorder and file writer; the dark overlay shows active jobs and allows stop/cancel.
- Autoplay handling: background playback depends on Firefox and YouTube autoplay permissions. When autoplay is blocked, the job is marked failed with an explanation; the extension does not report a recording as active.

- In-page controls: click the toolbar icon on a regular HTTPS `www.youtube.com` page to bootstrap the capture runtime if the tab predates installation, then inject a video-adjacent overlay. It exposes arm/disarm, pause, resume, split, stop/save, discard, history, recovery and deletion without a toolbar popup.
- Dark mode: the overlay uses a fixed dark palette in an isolated Shadow DOM, so YouTube's theme and page styles do not leak into its controls.
- Live page synchronization: the isolated overlay communicates through the extension background to the capture API in the page's main world. It refreshes on player events, YouTube SPA navigation and DOM changes, with a 1.2-second polling fallback. Overlay messages are accepted only from a top-level `www.youtube.com` tab.

## Earlier 1.2.0 improvements

- On-demand dark overlay, Shadow DOM isolation, SPA refresh synchronization and toolbar bootstrap for tabs open before installation.

## Earlier 1.1.0 improvements

- Video-aware sessions: every capture is bound to a stable YouTube video identity (watch, Shorts, Live and embed paths). YouTube SPA navigation, back/forward navigation, and player replacement split sessions at the video boundary. Outgoing recordings retain their original title and ID.
- Capture history and recovery: metadata and a timestamped event timeline are stored in IndexedDB. Closed WebM files remain in Firefox origin-private storage until a successful download has aged out. Interrupted or failed downloads can be retried from the popup for up to seven days. A tab close during recording is reconciled on the next visit; any retained partial file is clearly marked as potentially incomplete.
- Expanded controls: arm/disarm, manual pause/resume, split into a second WebM, stop and save, and discard.
- Capture dashboard: current title and video ID, elapsed recording time, bytes written, codec, live state, and a recent capture timeline with recovery/delete actions.
- Automated tests: Node's test runner covers video identity extraction, SPA video transitions, filename isolation, session pause/resume accounting, split/stop/discard save policy, and rapid consecutive video changes.

## Use

1. Open YouTube in Firefox. Red `REC` controls appear on supported video cards; on a watch page, the control sits immediately before the like button.
2. Click a card's `REC` control to queue that video without changing the active tab. The extension opens an inactive player tab and attempts to start playback.
3. While recording, the button pulses red. Click it again to stop and save; completed videos also finalize automatically when playback ends.
4. Use the toolbar action to open the dark dashboard and view the background job queue, capture history and recovery actions.
5. On a watch page, the `REC` button records the video already open.
4. Playback pauses suspend recording; use the popup controls to pause, resume, split, stop and save, or discard.
5. When a video changes, the outgoing capture is finalized as its own WebM and a new capture starts for the selected video when playback is active.
7. Use the overlay's Capture Timeline to retry interrupted/failed downloads or remove history entries.

## Independent operation and permissions

The extension does not connect to Intercept, create an Intercept session, inspect media network requests, rewrite traffic, or depend on the original Intercept extension. It requests activeTab, scripting, and downloads; content scripts are restricted to HTTPS YouTube domains.

Capture files use the browser's origin-private file system (OPFS); their history records use IndexedDB. A downloaded temporary copy is retained for up to 24 hours to support recovery. Failed and interrupted files are retained for up to seven days. If a tab closes before MediaRecorder writes its finalization data, a retained partial recording is offered for best-effort recovery and may not play correctly. Deleting a history item also deletes its temporary file.

## Technical limits

This records decoded playback output, not YouTube's original media file or Firefox's internal HTTP cache. Output is re-encoded as WebM and may differ from the source in quality, size, timing, or codec. It has a 2 GiB safety limit, also bounded by available origin-private storage.

DRM/EME-protected playback may not expose capturable media tracks. This add-on does not bypass DRM, decrypt protected media, retrieve source segments, or defeat access controls. Firefox/player behavior and available storage can also affect capture.

## Install for testing

1. Download youtube-playback-download.xpi.
2. Open about:debugging#/runtime/this-firefox.
3. Choose Load Temporary Add-on and select the XPI.
4. Reload any YouTube tab that was already open.
5. Pin Playback Capture from Firefox's Extensions menu.

Temporary installations are removed when Firefox restarts. Standard Firefox release builds require Mozilla-signed add-ons for normal, persistent installation. This repository XPI is an unsigned development package and must be submitted for Mozilla signing before normal end-user distribution.

## Source layout

- manifest.json — minimal Manifest V3 permissions and YouTube-only content-script scope.
- capture_core.js — deterministic identity, filename and session-state primitives shared by runtime and automated tests.
- video_download.js — media-element capture, OPFS file lifecycle, session state, IndexedDB history and recovery API.
- download_bridge.js — isolated-world bridge for Firefox download lifecycle messages.
- background.js — validates the source tab and saves WebM blobs through Firefox Downloads.
- overlay.js — on-demand in-page dark dashboard, background capture queue, mount lifecycle and player/SPA refresh handling.
- inline_record.js — per-video red `REC` buttons, card discovery, watch-page like-row placement and job-state synchronization.
- popup.html, popup.css, popup.js — retained extension-page dashboard assets; the toolbar action now activates the in-page overlay.
- tests/capture_core.test.js — Node unit tests for the session manager and identity rules.

Background playback requires autoplay permission for YouTube. A job that cannot autoplay is reported as failed rather than saved as an empty file. Up to three background capture workers run concurrently. YouTube browse cards do not expose a reusable media stream, so each selected card is played in a separate inactive tab; the watch-page button records the existing player instead.

The XPI is built from the standalone source with the manifest at the archive root.
