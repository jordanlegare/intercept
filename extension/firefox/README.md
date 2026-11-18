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

The **ENVIRONMENT COMPARISON** panel captures the currently active tab in the page's main JavaScript world. Capture once while viewing YouTube directly (native mode), then again while viewing the same site through an Intercept synthetic localhost origin (proxy mode). The add-on classifies youtube.com as native and localhost origins as reverse proxy. It retains up to five snapshots per mode in extension-local storage.

The comparison includes:

- Page origin characteristics: protocol, sanitized host/origin classes, port, path class, and sanitized document-domain class.
- Security context: secure-context status, cross-origin isolation, top-level-frame status, document visibility/readiness, and cookie-enabled boolean.
- Worker capabilities: Worker, SharedWorker, ServiceWorker API/controller, and Worklet availability.
- Network capabilities: Fetch, XHR, Request/Response, streams, AbortController, WebSocket, and WebTransport availability.
- Media capabilities: MediaSource, EME, MediaCapabilities, WebCodecs, video canPlayType, and Media Session availability.
- Storage capabilities: local/session storage access, IndexedDB, and StorageManager availability.
- Resource timing aggregates grouped by initiator type, sanitized host class, and sanitized path class.

After capturing both modes, choose **EXPORT COMPARISON**. The timestamped JSON contains the snapshots and a field-by-field comparison of the latest native and proxy captures. The popup also shows a short list of differences. Capture both modes at comparable points in page load/playback for more useful resource-timing comparisons.

This is a diagnostic comparison, not a complete browser fingerprint or a proof of causation. The extension executes the snapshot function in the page MAIN world, but it does not instrument worker globals or inspect worker memory. Worker script activity is represented only indirectly through resource timing and the existing request lifecycle observer. API availability does not prove that a particular API was used successfully.

The snapshot deliberately excludes full URLs, query strings, fragments, page text, video identifiers, cookies, tokens, request/response bodies, and arbitrary header values. Resource entries are reduced to counts; no resource URL is exported. Snapshots stay in Firefox extension storage until cleared through Firefox's extension storage controls or replaced by later captures (five per mode are retained).

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
- Environment capture uses browser.scripting.executeScript with world: MAIN and therefore requires Firefox 128 or newer.
