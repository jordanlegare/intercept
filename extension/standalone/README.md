# Playback Capture for Firefox 1.1.0

An independent Firefox add-on that captures decoded playback output from YouTube and saves it as WebM files. It has its own capture session manager, local capture library, recovery flow, toolbar dashboard, and download bridge. It does not connect to the Intercept Rust server.

## What changed in 1.1.0

- Video-aware sessions: every capture is bound to a stable YouTube video identity (watch, Shorts, Live and embed paths). YouTube SPA navigation, back/forward navigation, and player replacement split sessions at the video boundary. Outgoing recordings retain their original title and ID.
- Capture history and recovery: metadata and a timestamped event timeline are stored in IndexedDB. Closed WebM files remain in Firefox origin-private storage until a successful download has aged out. Interrupted or failed downloads can be retried from the popup for up to seven days. A tab close during recording is reconciled on the next visit; any retained partial file is clearly marked as potentially incomplete.
- Expanded controls: arm/disarm, manual pause/resume, split into a second WebM, stop and save, and discard.
- Capture dashboard: current title and video ID, elapsed recording time, bytes written, codec, live state, and a recent capture timeline with recovery/delete actions.
- Automated tests: Node's test runner covers video identity extraction, SPA video transitions, filename isolation, session pause/resume accounting, split/stop/discard save policy, and rapid consecutive video changes.

## Use

1. Open an HTTPS YouTube video in Firefox.
2. Open the Playback Capture toolbar popup and choose ARM CAPTURE before playback begins.
3. Play the video. The extension captures the audio/video tracks exposed by the player.
4. Playback pauses suspend recording; use the popup controls to pause, resume, split, stop and save, or discard.
5. When a video changes, the outgoing capture is finalized as its own WebM and a new capture starts for the selected video when playback is active.
6. Use History & recovery to retry interrupted/failed downloads or remove history entries.

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
- popup.html, popup.css, popup.js — capture dashboard and history UI.
- tests/capture_core.test.js — Node unit tests for the session manager and identity rules.

The XPI is built from the standalone source with the manifest at the archive root.
