# Intercept

Intercept is a loopback browser proxy that loads one public HTTP/HTTPS origin through http://127.0.0.1:5000 and adds one fixed authority banner at the bottom of the page. Rust enforces the timer for state-changing HTTP requests.

## Status

This is an initial working implementation, not a general-purpose transparent MITM proxy. It is intentionally **one upstream origin per session**. The browser address changes to a local /p/<session-id> URL.

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
      - same-origin URL routing rewrites
      - minimal bottom authority banner
      - per-session authorization gate
              |  HTTP or verified HTTPS (rustls)
              v
          Upstream origin

A single reqwest Client is created for each session and reused, so its HTTP keep-alive connection pool is reused for that origin. DNS is resolved when the session is created, non-public answers are rejected, and the client is pinned to those resolved addresses to reduce DNS-rebinding/SSRF risk. TLS certificate verification remains enabled.

## Authority behavior

- The proxied page is left visually intact. Intercept adds only a fixed authority banner at the bottom with a decimal-seconds input, **[START]**, state, and countdown.
- Intercept does not instrument DOM events, monkey-patch page event listeners, wrap fetch/XHR, record input values, or display an event stream.
- Same-origin URL attributes are internally routed through the session so ordinary page navigation and assets continue through the proxy. These routing changes are not visible page UI.
- Rust holds POST, PUT, PATCH, and DELETE requests until the timer expires. Request bodies are buffered up to 8 MiB while waiting; responses are limited to 32 MiB. GET, HEAD, and OPTIONS requests are allowed while the timer is pending.

This is a **method-based HTTP authorization gate**, not a universal JavaScript sandbox. Page-side JavaScript can still perform local effects before a request, and applications can mutate state through GET endpoints. Those behaviors are not blocked. The timer is authoritative for the mutating HTTP methods listed above.

## Rewrite directory

The rewrites/ directory contains the authority-banner stylesheet and the extension point for future site-specific rewrite rules. The HTML transformer changes same-origin URL attributes only to route them through the active session, then appends the banner.

## Boundaries and limitations

- **Not transparent HTTPS interception:** the browser uses local HTTP and sees the local proxy URL. Rust independently establishes upstream HTTPS with normal certificate verification. This workflow does not need a browser-installed CA because the browser connection to Intercept is HTTP. It does not preserve the original https://host/ address bar.
- Preserving original HTTPS hostnames while inspecting their traffic requires configuring the browser/network to send traffic through a CONNECT proxy and trusting a local interception CA in that browser. This code does not implement that MITM mode.
- One upstream origin is pinned per session. Same-origin URLs present in HTML attributes (links, scripts, images, media, and forms) are routed through the local session. Runtime-generated fetch/XHR URLs are not rewritten or intercepted by JavaScript instrumentation. Third-party requests and external navigation are not routed through this single-origin session; third-party static resources may still load directly and therefore are not inspected.
- WebSockets, HTTP/3, service workers, download streaming, complex CSP/non-UTF-8 HTML, and full cookie semantics are not implemented.
- Applications that construct absolute URLs dynamically or rely on unusual history/base-URL behavior may issue requests outside the session.
- Browser page scripts execute in the local proxy origin. **Only open websites you trust.** A proxied page is not isolated from the local dashboard/API, so this version must not be treated as a security boundary against hostile website JavaScript.
- The IP checks and per-session DNS pinning reduce common SSRF/DNS-rebinding paths, but this is an early-stage development tool, not an audited security product.

## Configuration

The default listener is intentionally fixed to 127.0.0.1:5000. Restarting the process clears sessions and timers. Logs use the RUST_LOG environment variable (default: intercept=info).

## Tests

    cargo fmt --all -- --check
    cargo test
    cargo clippy --all-targets -- -D warnings
