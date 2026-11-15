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

- The proxied page is left visually intact. Intercept adds only a fixed authority banner at the bottom with a decimal-seconds input, **[START]**, state, and countdown.
- HTML links, forms, scripts, images, media, srcset, inline CSS, and style blocks are rewritten to local session paths. External CSS url() and @import references are rewritten too.
- Network URLs created at runtime through fetch, XHR, sendBeacon, EventSource, workers, window.open, dynamic URL attributes, and CSS setters are routed through the same local server. Static and dynamic JavaScript module imports (including root-relative and relative specifiers) and classic-worker `importScripts()` URLs are rewritten as well.
- Each upstream origin has its own pooled, DNS-pinned client. Cookies are scoped to that origin's local proxy path so cookies from different hosts do not collide.
- Static assets are cached per session in memory (64 MiB total; 8 MiB per entry; five-minute default TTL). HTML and API responses are fetched live so login state and application data are not served stale.
- Rust holds POST, PUT, PATCH, and DELETE requests from every proxied origin until the timer expires. Request bodies are buffered up to 8 MiB; responses are limited to 32 MiB. GET, HEAD, and OPTIONS requests are allowed while the timer is pending.

This is a method-based HTTP authorization gate, not a universal JavaScript sandbox. Page-side JavaScript can still perform local effects before a request, and applications can mutate state through GET endpoints. Those behaviors are not blocked. The timer is authoritative for the mutating HTTP methods listed above.

## Rewrite directory

The rewrites/ directory contains the authority-banner stylesheet and the extension point for future site-specific rewrite rules. The HTML/CSS/JavaScript transformers change network URLs only to route resources through the active session, then append the banner. The injected JavaScript shim handles runtime-generated HTTP requests without observing page events or changing page UI.

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


For routing diagnostics, run with `RUST_LOG=intercept=debug cargo run`. Debug logs show each localhost session URI translated to its upstream URL. Unmatched localhost requests and upstream non-success responses are logged separately so a local route miss can be distinguished from an upstream 404.

## Tests

    cargo fmt --all -- --check
    cargo test
    cargo clippy --all-targets -- -D warnings
