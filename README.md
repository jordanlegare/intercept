# Intercept

Intercept is a loopback reverse proxy that loads websites through Rust, routes HTTP/HTTPS resources and application requests through a per-session origin, caches static assets, and presents a separately-originated authority panel. Rust owns the timer and enforces the selected request authorization policy.

## Status

This is a localhost reverse-proxy workflow, not a CONNECT/MITM proxy. A session opens at http://<session-id>.localhost:5000/p/<session-id>/.... Each session has a distinct browser origin, and its dashboard/authority controls are available at http://127.0.0.1:5000 or http://localhost:5000. The submitted website is the primary upstream origin; linked public HTTP/HTTPS origins are routed through origin-qualified paths beneath the same session origin.

## Run

Install a recent stable Rust toolchain, then run:

    cargo fmt
    cargo test
    cargo run

Open http://127.0.0.1:5000 or http://localhost:5000, enter the complete upstream URL (including any path and query string), and choose **Open new session tab**. Each launch creates an independent server-side session and opens it in a separate browser tab; the launcher remains open so you can start more sessions without restarting Intercept. The **Active Sessions** list shows sessions currently held by the process, lets you reopen one in another tab, provides a per-session folder button to browse cached resources, and provides a **KILL** action. The cache browser displays an origin/path folder tree, cached file metadata, text previews, and downloads. The cache is held in process memory rather than a disk directory; it disappears when its session is killed/expired or Intercept restarts. Killing a session removes it from the registry, cancels in-flight upstream requests, and clears its clients and cache without stopping the proxy process. The session opens the exact resource rather than resetting to the site's homepage. The session URL retains the destination path, query, and browser-side fragment. The browser sees a unique `.localhost` host for each session; the trusted authority panel is loaded in a cross-origin iframe. Allow pop-ups for the dashboard origin you use so each launch can open its own tab. Select an authorization policy before opening:

1. **Standard** holds POST, PUT, PATCH, and DELETE while allowing GET, HEAD, and OPTIONS, with narrowly-scoped read-only POST exceptions for YouTube autocomplete (`/youtubei/v1/complete`) and search (`/youtubei/v1/search`). Other POST endpoints remain held.
2. **Strict** permits the initial document bootstrap, then holds all upstream requests until the timer starts and expires.
3. **Custom** evaluates ordered host/path/method rules; unmatched requests use Standard behavior. Example:
   ```json
   [{"host":"example.com","path_prefix":"/api/","methods":["GET"],"hold":true}]
   ```
4. In the authority panel, enter a delay in seconds (0.000000001 to 86400; fractional values are supported) and press **[START]**. Rust owns the deadline and remains authoritative. Repeating the same Start request is idempotent; a different delay is rejected.

The server listens on the IPv4 and IPv6 loopback interfaces where available, and accepts the dashboard hostnames `127.0.0.1:5000` and `localhost:5000`. It is not intended to be exposed on a LAN or the public internet.

## Request path

    Browser
      |  HTTP to 127.0.0.1:5000 or localhost:5000
      v
    Axum loopback server
      - dashboard + session/timer API
      - multi-origin URL routing and response rewriting
      - bounded per-session static-resource cache
      - minimal top authority banner
      - per-session authorization gate
              |  HTTP or verified HTTPS (rustls)
              v
          Upstream origin

One reqwest Client is created per upstream origin and reused. Each new origin is DNS-resolved, non-public answers are rejected, and the client is pinned to the resolved addresses to reduce DNS-rebinding/SSRF risk. TLS certificate verification remains enabled. Regular document and transformable resource requests have a 120-second total upstream deadline; AJAX streams retain their separate 24-hour deadline. Opaque/non-cacheable responses and known resources larger than the cache-entry limit are streamed. Rewritable HTML/CSS/JavaScript and small cacheable assets remain buffered, with a 32 MiB response ceiling. CSS, JavaScript, images, fonts, and WebAssembly responses are cached in a bounded 64 MiB per-session cache (up to 8 MiB per entry, five-minute default TTL); HTML and API responses are not cached by default.

## Authority behavior

- The proxied page keeps its original layout. A fixed cross-origin authority iframe appears at the top with WAITING / AUTHORIZATION COUNTDOWN / AUTHORIZED, a decimal-seconds delay input, **[START]**, the countdown, a notice, an event stream, and session resource metrics.
- The iframe is hosted on the dashboard origin, isolated from the proxied page by the browser's same-origin policy and a closed Shadow DOM host. The session origin cannot access the dashboard control API; API requests are accepted only on either trusted dashboard hostname, with Origin required to match the corresponding hostname.
- Authority status, event polling, and event uploads have full-response deadlines and in-flight guards. The countdown advances locally between server status responses; Rust's monotonic timer remains authoritative. Start retries using the same delay are idempotent.
- The controller observes pointer, click, change, input, and keydown activity; reports selected event-listener registrations; and records fetch, XHR, sendBeacon, and proxied HTTP request metadata. Recent input/change/Enter events receive short-lived IDs attached to subsequent fetch/XHR requests, allowing the event stream to correlate a typed interaction with its AJAX request and upstream response. It records target selectors and event IDs only, never input values or request bodies.
- While authorization is pending, ordinary anchor navigation and form submission are held in a bounded browser queue (50 actions) and replayed when the Rust timer releases the session. The Rust gate independently enforces Standard, Strict, or Custom policy for every routed upstream request.
- Network URLs created at runtime through fetch, XHR, sendBeacon, EventSource, Worker, SharedWorker, service-worker registration, window.open, dynamic URL attributes, and CSS setters are routed through the session. Worker scripts get a bootstrap that routes worker fetch/XHR/importScripts calls and marks fetch/XHR as AJAX. Static and dynamic JavaScript module imports are rewritten too.
- **AJAX passthrough:** requests explicitly marked by the injected fetch/XHR controller (with browser Fetch Metadata and EventSource fallbacks) (\`Sec-Fetch-Dest: empty\`), legacy \`X-Requested-With: XMLHttpRequest\`, an explicit internal AJAX marker, or \`Accept: text/event-stream\` use a dedicated response path. The upstream status, content type, application headers and response bytes are preserved; HTML/CSS/JavaScript rewriting and the static-resource cache are bypassed. Upstream response bodies stream back to the browser instead of being buffered.
- `Location` headers are rewritten to the session URL space. Upstream `Set-Cookie` headers are consumed by the session-owned cookie jar instead of being exposed to the browser’s synthetic `.localhost` cookie store. The jar applies upstream domain and path matching when sending cookies back to each origin. `Origin` and `Referer` are translated back to the upstream site before forwarding; Intercept control headers are never sent upstream.
- AJAX response streams have a 24-hour total request timeout so long-polling and Server-Sent Events can remain open; browser EventSource clients can reconnect after that limit. Request bodies are still buffered and capped at 8 MiB. The AJAX response path has no 32 MiB body-buffering cap.
- Each session has one in-memory cookie jar shared by its pooled, DNS-pinned upstream clients. JavaScript `document.cookie` reads and writes are bridged against the actual upstream document URL, with `HttpOnly` cookies hidden from page JavaScript and bridge capabilities bound to that document’s upstream origin. Cookie state is removed when the session ends or Intercept restarts. `localStorage` and `sessionStorage` keys are namespaced by upstream origin within the session, including filtering of cross-origin storage events. A session may initialize at most 24 upstream-origin clients.
- Static non-AJAX resources are cached per session in memory (64 MiB total; 8 MiB per entry; five-minute default TTL). HTML and API responses are not cached by default. Use the folder button beside **KILL** in the dashboard to browse the live cache by scheme, host, and path, preview text assets, or download cached bytes. This is a virtual browser over RAM entries, not a disk-backed file manager.
- Rust owns authorization. Standard blocks POST/PUT/PATCH/DELETE except the explicit read-only YouTube autocomplete/search routes; Strict holds all proxied traffic after the first bootstrap document; Custom applies ordered path/host/method rules and falls back to Standard. A site's state-changing GET endpoints remain allowed by Standard and must be covered by Custom or Strict.

This is not a universal JavaScript sandbox and cannot suspend arbitrary JavaScript execution. The event stream is observational; it records event metadata, not values. The browser queue defers ordinary anchor navigation and form submission, while the Rust proxy is authoritative for POST, PUT, PATCH, and DELETE. A page's custom click handler may still perform local JavaScript side effects before making a request, and applications can mutate state through GET endpoints. Those behaviors are not universally blocked.

## Rewrite directory

The rewrites/ directory contains the authority-banner stylesheet and the extension point for future site-specific rewrite rules. The HTML/CSS/JavaScript transformers change network URLs only to route resources through the active session, then append the banner. The injected JavaScript controller routes runtime-generated HTTP requests, observes page-action metadata, and defers link/form navigation until timer authorization. Rust classifies AJAX requests independently and streams their upstream responses without document/resource transformations.

## Boundaries and limitations

- **Not transparent HTTPS interception:** the browser uses local HTTP and sees the local proxy URL. Rust independently establishes upstream HTTPS with normal certificate verification. This workflow does not need a browser-installed CA because the browser connection to Intercept is HTTP. It does not preserve the original https://host/ address bar.
- Preserving original HTTPS hostnames while inspecting their traffic requires configuring the browser/network to send traffic through a CONNECT proxy and trusting a local interception CA in that browser. This code does not implement that MITM mode.
- HTTP and HTTPS resources for public origins are routed through the session. Worker and service-worker registration/network hooks are partially supported, but service-worker lifecycle/origin semantics still vary by browser and site. WebSockets, WebTransport, HTTP/3, native navigation APIs that bypass the patched URL surfaces, and transparent TLS interception are not implemented.
- The browser origin is localhost, not the original upstream origin. Origin-sensitive applications may still behave differently even though request URLs, Origin, Referer, and cookies are translated where possible. This is a reverse proxy, not a browser-origin emulator.
- The in-memory asset cache is per process and per session; restarting Intercept clears it. Dynamic HTML and API responses are deliberately not cached.
- CSP source directives are adapted to allow the localhost-routed resources. This changes the effective security policy of the proxied page; only browse sites you trust.
- Proxied page scripts execute in their own per-session origin, separate from the dashboard and authority API. The Host/Origin guard rejects session-origin access to dashboard control endpoints. This reduces cross-session and dashboard exposure, but is not a complete browser sandbox or an audited security boundary; only open websites you trust.
- The IP checks and per-session DNS pinning reduce common SSRF/DNS-rebinding paths, but this is an early-stage development tool, not an audited security product.

## Configuration

The server remains loopback-only and accepts both `127.0.0.1:5000` and `localhost:5000`. Restarting the process clears sessions and timers. Logs use the RUST_LOG environment variable (default: intercept=info) and include per-request correlation IDs.

Resource-limit environment variables:

| Variable | Default | Meaning |
|---|---:|---|
| `INTERCEPT_MAX_SESSIONS` | 8 | Maximum active sessions (1–256) |
| `INTERCEPT_SESSION_IDLE_SECONDS` | 1800 | Idle-session expiration (60–86400 seconds) |
| `INTERCEPT_MAX_INFLIGHT_PER_SESSION` | 64 | Concurrent upstream requests per session (1–512) |
| `INTERCEPT_REWRITE_WORKERS` | CPU count | Maximum concurrent blocking rewrite workers |
| `INTERCEPT_AUTH_POLICY` | standard | Default policy when the launcher omits one |

The dashboard reports the active-session count against `INTERCEPT_MAX_SESSIONS` and lists each active session with its target URL, policy, and authorization state. The list is refreshed after each launch or on demand. The authority UI for each tab reports cache bytes, initialized upstream origins, in-flight request counts, selected policy, and last activity. Sessions are pruned every minute; sessions with active requests are retained.

## Tests

    cargo fmt --all -- --check
    cargo test
    cargo clippy --all-targets -- -D warnings
