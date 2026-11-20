# Firefox Extensions

This directory contains the Firefox add-ons maintained with Intercept.

## Playback Capture — standalone YouTube recorder

**Current package:** [Playback Capture 1.3.8](./youtube-playback-download-1.3.8.xpi)

Playback Capture adds per-video `REC` controls to YouTube, queues selected videos, starts playback through YouTube's exposed player API, records decoded playback output as WebM, and downloads completed captures. It runs independently of the Intercept Rust server.

### Important: enable YouTube autoplay first

For the capture queue to start playback automatically without an `ALLOW PLAY` retry, Firefox must allow autoplay for YouTube. The extension's call to YouTube's `playVideo()` API is still subject to Firefox's autoplay policy.

1. Open YouTube in Firefox.
2. Go to **Settings → Privacy & Security → Permissions → Autoplay → Settings…**.
3. Set `youtube.com` to **Allow Audio and Video**. You can set the site's permission specifically, or use **Default for all websites → Allow Audio and Video** (which applies more broadly).
4. Click **Save Changes**, then reload YouTube.

A site-specific block can override the global default. When Firefox rejects startup, the REC control displays **ALLOW PLAY**. This is a retry prompt, not a permission grant: change the Firefox autoplay permission first, then click it to retry the waiting capture. With the site permission enabled, the extension can start new queued captures automatically, subject to player, ad, and network readiness. The helper tab is temporarily foregrounded during startup because Firefox may defer autoplay in background tabs. Transient startup failures now retain the helper tab and display RETRY instead of closing it immediately; retry resumes the same queue item.

### Install the development XPI

1. Download [youtube-playback-download-1.3.7.xpi](./youtube-playback-download-1.3.7.xpi).
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose the XPI.
4. Reload YouTube tabs that were already open.

Temporary add-ons are removed when Firefox restarts. The repository XPI is an unsigned development package; persistent installation in standard Firefox requires Mozilla signing.

See [standalone source, detailed usage, and technical limits](./standalone/README.md). The separate [native-origin diagnostics extension](./firefox/README.md) is documented independently.

### Recording limitations

Playback Capture records decoded player output to WebM; it does not retrieve YouTube's original media file or Firefox's HTTP cache. DRM/EME-protected media may not expose capturable tracks. The extension does not bypass DRM or access controls.
