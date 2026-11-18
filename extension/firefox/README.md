# Intercept Firefox Native Origin

This add-on opens YouTube directly in Firefox and observes selected request metadata through browser.webRequest. It does **not** redirect traffic through the reverse proxy. That preserves Firefox's real https://www.youtube.com execution origin, native cookies, worker origins, browser request context, and TLS connection.

## Requirements

- Firefox 128 or newer.
- Intercept Rust server running on 127.0.0.1:5000 (or localhost:5000).
- The add-on folder at extension/firefox.

## Temporary installation

1. Open about:debugging#/runtime/this-firefox.
2. Choose **Load Temporary Add-on…**.
3. Select extension/firefox/manifest.json.
4. Pin **Intercept · Native Origin** from the Extensions menu if desired.
5. Open the add-on popup, confirm the local server address, and choose **OPEN NATIVE-ORIGIN SESSION**.

The popup opens an about:blank tab first, creates a native-origin session in the Rust server, stores its one-time capability in Firefox extension storage, and then navigates that tab directly to YouTube. The extension only observes requests from that tab. The popup can refresh the session event list, export the complete retained event log as a timestamped JSON file, or stop observation; stopping leaves the YouTube tab open. Export before stopping or closing the monitored tab, because deleting a session also deletes its in-memory event log.

## Native/proxy environment comparison

The **ENVIRONMENT COMPARISON** panel captures the currently active tab in the page's main JavaScript world. Capture once while viewing YouTube directly (native mode), then again while viewing the same site through an Intercept synthetic localhost origin (proxy mode). The add-on classifies youtube.com as native and localhost origins as reverse proxy. It uses Firefox's activeTab permission, granted temporarily when the user invokes the extension, to inspect the current tab without requesting permanent access to the site. It retains up to five snapshots per mode in extension-local storage. Firefox match patterns do not support port restrictions, so the manifest matches the localhost hostnames and the probe itself exits unless the document is HTTP on port 5000.

The comparison includes:

- Top-level video-element snapshots: count, paused/ended/seeking state, current time/duration, playback rate, ready/network state, dimensions, source-presence booleans, MediaSource/MediaStream attachment class, buffered ranges, decoded/dropped/corrupted frame counters where available, and media error code. At most eight elements are recorded; source URLs are never captured.
- A count of Resource Timing entries with a nonzero `workerStart` value. This is only a timing-exposure indicator; zero does not prove a service worker was unused.

- Page origin characteristics: protocol, sanitized host/origin classes, port, path class, and sanitized document-domain class.
- Security context: secure-context status, cross-origin isolation, top-level-frame status, document visibility/readiness, and cookie-enabled boolean.
- Worker capabilities: Worker, SharedWorker, ServiceWorker API/controller, and Worklet availability; sanitized ServiceWorker registration scopes and script URLs; controller/registration states; and early document-created Worker/SharedWorker constructor observations.
- Network capabilities: Fetch, XHR, Request/Response, streams, AbortController, WebSocket, and WebTransport availability.
- Media capabilities: MediaSource, EME, MediaCapabilities, WebCodecs, video canPlayType, and Media Session availability.
- Storage capabilities: local/session storage access, IndexedDB, and StorageManager availability.
- Document Resource Timing aggregates grouped by initiator type, sanitized host class, and sanitized path class, with duration/transfer-size totals and a timing window. Worker-constructor observations are reported separately so they are not misrepresented as worker-internal Resource Timing.
- Proxy Resource Timing routes are classified against their embedded upstream host/path envelope (for example, an Intercept `/_/https/` route is categorized as Googlevideo media without retaining the route or query string).

After capturing both modes, choose **EXPORT COMPARISON**. The timestamped JSON contains the snapshots and a field-by-field comparison of the latest native and proxy captures. The popup also shows a short list of differences. Capture both modes at comparable points in page load/playback for more useful resource-timing comparisons.

This is a diagnostic comparison, not a complete browser fingerprint or a proof of causation. A document-start MAIN-world probe records sanitized dedicated/shared Worker constructor calls; page scripts can detect or interfere with MAIN-world instrumentation. Its localhost host match is narrowed at runtime to port 5000, because Firefox does not support port numbers in extension match patterns. It does not instrument worker globals, inspect worker memory, or read worker-local Performance timelines. The document Resource Timing snapshot describes only the document's timeline. API availability does not prove that a particular API was used successfully.

The snapshots and media trace deliberately exclude full URLs, query strings, fragments, page text, video identifiers, cookies, tokens, request/response bodies, arbitrary header values, and SharedWorker names. Resource entries are reduced to sanitized host/path classes and aggregate timing/size values; no resource URL or worker script URL is exported. Snapshots stay in Firefox extension storage until cleared through Firefox's extension storage controls or replaced by later captures (five per mode are retained).

## Playback and browser media-request trace

The **PLAYBACK / REQUEST DIAGNOSTICS** panel can arm a trace for the currently active native YouTube or Intercept localhost:5000 tab. Start/reset the trace before reloading the page or starting playback. The trace follows that tab ID across reloads. After playback or a failure, choose **REFRESH TRACE** or **CAPTURE ACTIVE TAB**; the environment snapshot includes the trace counters. **STOP TRACE** freezes collection, and **EXPORT TRACE JSON** downloads the complete bounded event sample and aggregate counters.

The observer uses Firefox `webRequest` events independently from page Resource Timing. Native requests are classified by their YouTube/Google host and path. Proxy requests are classified by unwrapping only the fixed `/_/https/<host>/<path>` route envelope; session IDs, original URLs, and query values are never exported. It records category, sanitized host class, method, request type, lifecycle event, HTTP status, elapsed time, cache boolean, and an allowlisted network-error code. Events are bounded to 500 per trace; aggregate counters continue increasing. It does not measure actual response-body bytes, inspect request/response bodies, or capture headers.

The video snapshot examines up to eight `video` elements in the top-level document at capture time. It is a point-in-time state read, not a continuous player event recorder. Video elements hidden inside closed shadow roots or separate frames may not be visible to this snapshot.

## What is observed

The extension emits request-start, request-header-profile, response-header-profile, completion, and network-error events for YouTube and Google API/media hosts. It records only sanitized host/path classifications, HTTP method/type, browser origin/referrer host, Fetch Metadata enums, selected content metadata, header-presence booleans, status, duration, and an opaque request correlation ID.

It never stores full URLs, URL query strings, fragments, request or response bodies, cookies, Authorization values, PO tokens, API-key values, visitor IDs, or arbitrary error text. WAA RPCs and attestation resource requests are classified by path without recording query parameters.

## Current limitation: observation-only

This initial native-origin mode does **not** enforce Standard, Strict, or Custom request authorization; hold/replay requests; rewrite request or response bodies; cache resources; or stream network bytes through Rust. These operations remain in reverse-proxy mode. It deliberately does not use blocking listeners or response stream filters in order to leave YouTube's native request path unmodified.

The Rust backend stores native-origin events in the same per-session event queue and includes the session in the active-session dashboard. Native sessions are labelled **NATIVE ORIGIN · OBSERVE ONLY** and are not routed through /p/{id}.

## Development notes

- Manifest V3 uses Firefox's non-persistent background scripts (event page); event listeners are registered at top level.
- The extension uses webRequest observation only. It does not request webRequestBlocking, modify headers, redirect requests, or call filterResponseData.
- A per-session bearer capability protects native event retrieval, ingestion, and session deletion. It is returned only when native_origin: true is used at session creation and is stored in extension-local storage.
- Environment capture uses browser.scripting.executeScript with world: MAIN and therefore requires Firefox 128 or newer. The activeTab permission grants temporary access when the user invokes the extension; no permanent site-wide host permission is requested for page capture.


## Dashboard session status and activity

The local Intercept dashboard lists the native-origin session created by this extension. The background script reports a one-minute heartbeat while the monitored tab remains available, so the dashboard can distinguish **CONNECTED**, **STALE**, and **WAITING FOR EXTENSION** instead of displaying the reverse-proxy authorization gate as the native session's status. The activity control opens the retained sanitized browser request observations.

Native-origin mode keeps TLS end-to-end between Firefox and YouTube. Intercept therefore cannot inspect response bodies or populate the server-side HTTP asset cache for this session. Use the dashboard folder control on a reverse-proxy session to inspect files actually retained in the proxy cache.

 
## Download completed native-origin playback

The session panel includes **DOWNLOAD WHEN VIDEO COMPLETES**. Enable it before starting the video. The MAIN-world playback hook captures the rendered YouTube player through Firefox's media-element capture stream and MediaRecorder, writes bounded chunks to a temporary file in the origin-private file system, and passes the completed WebM file to Firefox's Downloads API when the player fires its ended event. Pauses suspend the recorder; recording resumes with playback. Disabling the toggle discards an in-progress capture.

This is intentionally not described as an export of Firefox's internal HTTP cache. WebExtensions do not receive an API to enumerate and export the browser's HTTP cache as a video file. The feature captures the decoded playback output in real time and re-encodes it as WebM; it is not the original YouTube media stream and may differ in quality, size, or codec from the source. Enable it before playback to capture from the beginning. Enabling it mid-playback only captures from the point at which recording starts. Live streams do not produce an automatic download until the player emits ended. DRM/EME-protected playback may not expose capturable audio/video tracks; this feature does not bypass DRM.

Temporary capture data is stored under the YouTube origin's Origin Private File System in the intercept-playback-downloads directory, with a 2 GiB per-video safety cap. The completed file is handed to the browser's download flow and the temporary copy is removed after one hour. Browser download preferences and player behavior may affect automatic download initiation.
