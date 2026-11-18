# Intercept Firefox Native Origin

This add-on opens YouTube directly in Firefox, preserving the real `https://www.youtube.com` document origin, native cookies, worker origins, browser request context, and upstream TLS validation. In an active native-origin session it routes selected HTTPS connections through an authenticated, session-scoped HTTP CONNECT tunnel on the local Intercept server. TLS remains end-to-end between Firefox and each upstream host; the tunnel does not terminate or decrypt TLS.

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

The popup opens an about:blank tab first, creates a native-origin session and a loopback CONNECT listener in the Rust server, stores the session capability and ephemeral proxy port in Firefox extension storage, activates the tab-scoped proxy policy, and then navigates that tab directly to YouTube. Only HTTPS requests from that tab to the fixed YouTube/Google host allowlist are routed through the session tunnel. Other tabs and unrelated destinations are not selected by this session's proxy policy. The popup can refresh the retained session event log, export it as timestamped JSON, or stop the session; stopping closes its tunnel and leaves the YouTube tab open to continue directly. Export before stopping or closing the monitored tab, because deleting a session also deletes its in-memory event log.

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

## Native-origin CONNECT tunnel: capabilities and boundaries

The Firefox extension uses `browser.proxy.onRequest` for a narrowly scoped HTTP proxy policy. The Rust server accepts only HTTP CONNECT to port 443, requires the unguessable per-session bearer capability in `Proxy-Authorization`, and allows only YouTube/Google service domains used by the page and media stack. The server resolves the destination and refuses non-public IP addresses. Each native-origin session receives its own loopback listener; stopping or deleting the session closes its active tunnels.

The proxy is a byte-for-byte TCP tunnel. Firefox performs the TLS handshake with the actual upstream host and validates the upstream certificate. Intercept never presents a substitute certificate, terminates TLS, modifies BotGuard/WebPO data, or fabricates attestation tokens. This preserves the browser's real YouTube origin and cryptographic endpoint context while letting Intercept route and account for the selected upstream connections.

Because TLS is end-to-end, the Rust tunnel cannot inspect HTTP paths, query parameters, headers, request/response bodies, response status codes, or media payloads. Firefox's `webRequest` observer can still report browser-visible request metadata for the selected tab, but those observations do not give Rust control over individual encrypted HTTP requests. Standard/Strict/Custom path-level holds, request replay, response rewriting, and the reverse-proxy cache are unavailable in native-origin mode. Those features remain in reverse-proxy mode.

The Rust backend stores native-origin browser events and CONNECT lifecycle events in the per-session event queue and includes the session in the active-session dashboard. Native sessions are labelled **NATIVE ORIGIN · TLS PASSTHROUGH** and are not routed through `/p/{id}`.

## Development notes

- Manifest V3 uses Firefox's non-persistent background scripts (event page); event listeners are registered at top level.
- The extension uses webRequest observation only. It does not request webRequestBlocking, modify headers, redirect requests, or call filterResponseData.
- A per-session bearer capability protects native event retrieval, ingestion, and session deletion. It is returned only when native_origin: true is used at session creation and is stored in extension-local storage.
- Environment capture uses browser.scripting.executeScript with world: MAIN and therefore requires Firefox 128 or newer. The activeTab permission grants temporary access when the user invokes the extension; no permanent site-wide host permission is requested for page capture.
