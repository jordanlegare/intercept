# Playback Capture for Firefox

An independent Firefox add-on that extracts only the playback-download capability from Intercept's Firefox extension and gives it a new, self-contained interface.

## What it does

1. Open a YouTube video in Firefox.
2. Open the Playback Capture toolbar popup and choose **ARM DOWNLOAD** before playback begins.
3. Play the video. The add-on captures the audio/video tracks exposed by the page's media element with Firefox's MediaRecorder.
4. When playback ends, the add-on finalizes a WebM file and hands it to Firefox's Downloads API.

Pauses suspend recording and playback resumes it. Disarming during a capture discards the in-progress recording. Each recording is bound to the selected YouTube video ID. YouTube single-page navigation finalizes the outgoing recording as its own WebM (retaining that video's title and ID) and starts a fresh file for the newly selected video. The capture starts disabled after a full navigation or reload.

## Independent operation

This add-on does not connect to the Intercept Rust server, create an Intercept session, use Intercept storage, inspect network requests, rewrite traffic, or depend on the original Intercept extension. It contains its own toolbar popup, background download handler, and content-script bridge.

The extension requests only these WebExtension permissions:

- `activeTab` and `scripting` to control the currently selected tab after the user opens the toolbar popup.
- `downloads` to save the completed WebM file.

Its page scripts are restricted to HTTPS YouTube domains. It does not request access to all websites.

## Technical limits

This records decoded playback output, not YouTube's original media file or Firefox's internal HTTP cache. The output is re-encoded as WebM and may differ from the source in quality, size, timing, or codec. Enable it before playback to capture from the beginning. It has a 2 GiB safety limit, also bounded by available origin-private storage. Temporary capture data is removed after the download is handed to Firefox, with a one-hour cleanup fallback.

DRM/EME-protected playback may not expose capturable media tracks. This add-on does not bypass DRM, decrypt protected media, retrieve source segments, or defeat access controls. Firefox/player behavior and available storage can also affect capture.

## Install for testing

1. Download `youtube-playback-download.xpi` from this directory.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…** and select the XPI.
4. Reload any YouTube tab that was already open.
5. Pin **Playback Capture** from Firefox's Extensions menu.

Temporary installations are removed when Firefox restarts. Standard Firefox release builds require Mozilla-signed add-ons for normal, persistent installation. This repository XPI is an unsigned development package and must be submitted for Mozilla signing before normal end-user distribution.

## Source layout

- `manifest.json` — minimal Manifest V3 permissions and YouTube-only content-script scope.
- `video_download.js` — media-element capture and WebM recording logic adapted from Intercept's Firefox playback-download implementation.
- `download_bridge.js` — isolated-world bridge to the extension background context.
- `background.js` — validates the source tab and saves completed WebM blobs through Firefox Downloads.
- `popup.html`, `popup.css`, `popup.js` — standalone toolbar interface.

The XPI is built from these files with the manifest at the archive root.
