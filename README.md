# Intercept

Intercept is a loopback reverse proxy that loads a website through http://127.0.0.1:5000, routes its HTTP/HTTPS resources and application requests back through Rust, caches static assets per session, and adds one fixed authority banner. Rust enforces the timer for state-changing HTTP requests.

## Status

This is a localhost reverse-proxy workflow, not a CONNECT/MITM proxy. The browser address changes to a local /p/<session-id> URL. The submitted website is the primary origin; linked public HTTP/HTTPS origins are routed through origin-qualified paths in the same session.

## Run

Install a recent stable Rust toolchain, then run:

    cargo fmt
    cargo test
    cargo run

Open http://127.0.0.1:5000, enter the complete upstream URL (including any path and query string), and choose **Open through Intercept**. The session opens that exact resource rather than resetting to the site's homepage. The local session URL retains the destination path, query, and browser-side fragment while Rust pins requests to the submitted upstream origin. A fixed controller bar is injected at the bottom of the page:

1. Enter a delay in seconds; fractional values are supported (from 0.000000001 to 86400 seconds).
2. Press **[START]**.
3. The Rust server owns the deadline. When it expires, state-changing upstream HTTP requests are authorized.

The listener is hard-bound to 127.0.0.1:5000. It is not intended to be exposed on a LAN or the public internet.

## Request path

    Browser
      |  HTTP to 127.0.0.1:5000
      v
    Axum loopback server
      - dashboard + session/timer API
      - multi-origin URL routing and response rewriting
      - bounded per-session static-resource cache
      - minimal bottom authority banner
      - per-session authorization gate
              |  HTTP or verified HTTPS (rustls)
              v
          Upstream origin

One reqwest Client is created per upstream origin and reused. Each new origin is DNS-resolved, non-public answers are rejected, and the client is pinned to the resolved addresses to reduce DNS-rebinding/SSRF risk. TLS certificate verification remains enabled. CSS, JavaScript, images, fonts, and WebAssembly responses are cached in a bounded 64 MiB per-session cache (up to 8 MiB per entry, five-minute default TTL); HTML and API responses are not cached by default.

## Authority behavior

- The proxied page keeps its original layout, with a fixed **INTERCEPT AUTHORITY** banner at the bottom. The banner shows WAITING / AUTHORIZATION COUNTDOWN / AUTHORIZED, a decimal-seconds delay input, **[START]**, the countdown, a notice, and a collapsible event stream.
- The controller observes pointer, click, change, input, and keydown activity; reports selected event-listener registrations; and records fetch, XHR, sendBeacon, and proxied HTTP request metadata. It does not record input values or request bodies.
- While authorization is pending, ordinary anchor navigation and form submission are held in a bounded browser queue (50 actions) and replayed when the Rust timer releases the session. The Rust gate independently holds POST, PUT, PATCH, and DELETE requests.
- Network URLs created at runtime through fetch, XHR, sendBeacon, EventSource, workers, window.open, dynamic URL attributes, and CSS setters are routed through the same local server. Static JavaScript module imports and dynamic imports are rewritten as well.
- **AJAX passthrough:** requests identified by browser Fetch Metadata (\`Sec-Fetch-Dest: empty\`), legacy \`X-Requested-With: XMLHttpRequest\`, an explicit internal AJAX marker, or \`Accept: text/event-stream\` use a dedicated response path. The upstream status, content type, application headers and response bytes are preserved; HTML/CSS/JavaScript rewriting and the static-resource cache are bypassed. Upstream response bodies stream back to the browser instead of being buffered.
- AJAX \`Location\` and \`Set-Cookie\` headers are translated only as required to keep redirects and cookies inside the local session. Hop-by-hop headers are removed. \`Origin\` and \`Referer\` are translated back to the upstream site before forwarding; the internal AJAX marker is never sent upstream.
- AJAX response streams have a 24-hour total request timeout so long-polling and Server-Sent Events can remain open; browser EventSource clients can reconnect after that limit. Request bodies are still buffered and capped at 8 MiB. The AJAX response path has no 32 MiB body-buffering cap.
- Each upstream origin has its own pooled, DNS-pinned client. Cookies are scoped to that origin's local proxy path so cookies from different hosts do not collide.
- Static non-AJAX resources are cached per session in memory (64 MiB total; 8 MiB per entry; five-minute default TTL). HTML and API responses are not cached by default.
- Rust holds POST, PUT, PATCH, and DELETE requests from every proxied origin until the timer expires. GET, HEAD, and OPTIONS are allowed while the timer is pending; this remains a method-based gate, so applications that mutate state through GET are outside that authorization rule.

This is not a universal JavaScript sandbox and cannot suspend arbitrary JavaScript execution. The event stream is observational; it records event metadata, not values. The browser queue defers ordinary anchor navigation and form submission, while the Rust proxy is authoritative for POST, PUT, PATCH, and DELETE. A page's custom click handler may still perform local JavaScript side effects before making a request, and applications can mutate state through GET endpoints. Those behaviors are not universally blocked.

## Rewrite directory

The rewrites/ directory contains the authority-banner stylesheet and the extension point for future site-specific rewrite rules. The HTML/CSS/JavaScript transformers change network URLs only to route resources through the active session, then append the banner. The injected JavaScript controller routes runtime-generated HTTP requests, observes page-action metadata, and defers link/form navigation until timer authorization. Rust classifies AJAX requests independently and streams their upstream responses without document/resource transformations.

## Boundaries and limitations

- **Not transparent HTTPS interception:** the browser uses local HTTP and sees the local proxy URL. Rust independently establishes upstream HTTPS with normal certificate verification. This workflow does not need a browser-installed CA because the browser connection to Intercept is HTTP. It does not preserve the original https://host/ address bar.
- Preserving original HTTPS hostnames while inspecting their traffic requires configuring the browser/network to send traffic through a CONNECT proxy and trusting a local interception CA in that browser. This code does not implement that MITM mode.
- All HTTP and HTTPS resources for public origins can be routed through the session. WebSockets, WebTransport, HTTP/3, service workers, browser-native navigation APIs that bypass URL attributes, and download streaming are not implemented.
- The browser origin is localhost, not the original upstream origin. Origin-sensitive applications may still behave differently even though request URLs, Origin, Referer, and cookies are translated where possible. This is a reverse proxy, not a browser-origin emulator.
- The in-memory asset cache is per process and per session; restarting Intercept clears it. Dynamic HTML and API responses are deliberately not cached.
- CSP source directives are adapted to allow the localhost-routed resources. This changes the effective security policy of the proxied page; only browse sites you trust.
- Browser page scripts execute in the local proxy origin. **Only open websites you trust.** A proxied page is not isolated from the local dashboard/API, so this version must not be treated as a security boundary against hostile website JavaScript.
- The IP checks and per-session DNS pinning reduce common SSRF/DNS-rebinding paths, but this is an early-stage development tool, not an audited security product.

## Configuration

The default listener is intentionally fixed to 127.0.0.1:5000. Restarting the process clears sessions and timers. Logs use the RUST_LOG environment variable (default: intercept=info).

## Tests

    cargo fmt --all -- --check
    cargo test
    cargo clippy --all-targets -- -D warnings
