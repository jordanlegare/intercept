# Intercept

Intercept is a loopback browser proxy that lets you load one public HTTP/HTTPS origin through http://127.0.0.1:5000, observe browser-side activity, and delay authorization of state-changing HTTP requests using a timer enforced by Rust.

## Status

This is an initial working implementation, not a general-purpose transparent MITM proxy. It is intentionally **one upstream origin per session**. The browser address changes to a local /p/<session-id> URL.

## Run

Install a recent stable Rust toolchain, then run:

    cargo fmt
    cargo test
    cargo run

Open http://127.0.0.1:5000, enter an upstream URL such as https://example.com/, and choose **Open through Intercept**. The upstream page is served through the local relay. A fixed controller bar is injected at the bottom of the page:

1. Enter the delay in whole seconds (1–86400).
2. Press **[START]**.
3. The Rust server owns the deadline. When it expires, queued link/form navigation is released and state-changing upstream requests are allowed.

The listener is hard-bound to 127.0.0.1:5000. It is not intended to be exposed on a LAN or the public internet.

## Request path

    Browser
      |  HTTP to 127.0.0.1:5000
      v
    Axum loopback server
      - dashboard + session/timer/event API
      - same-origin HTML/URL rewriting
      - JavaScript event observer + bottom timer toolbar
      - per-session authorization gate
              |  HTTP or verified HTTPS (rustls)
              v
          Upstream origin

A single reqwest Client is created for each session and reused, so its HTTP keep-alive connection pool is reused for that origin. DNS is resolved when the session is created, non-public answers are rejected, and the client is pinned to those resolved addresses to reduce DNS-rebinding/SSRF risk. TLS certificate verification remains enabled.

## What is intercepted

- The injected JavaScript observes pointerdown, click, change, input, and keydown events. It also instruments later addEventListener registrations for those event types and batches sanitized event metadata to the Rust process. Input values are not logged.
- While the gate is closed, same-origin anchor navigation and form submission are held in a bounded browser-side queue and replayed once the Rust timer releases the session.
- The Rust proxy independently holds POST, PUT, PATCH, and DELETE requests until release. A collapsible event stream at the bottom of the page shows recent browser observations and actual proxied HTTP request paths/methods. Request bodies are buffered up to 8 MiB while waiting; responses are limited to 32 MiB.
- GET, HEAD, and OPTIONS requests are allowed so the document and its read-only resources can load while the timer is pending.

This is a **method-based HTTP authorization gate**, not a universal JavaScript sandbox. An application can perform local JavaScript side effects in a custom click handler before making a request; arbitrary page code cannot safely be paused and later resumed in a generic way. Some applications also mutate state through GET endpoints. Those behaviors are not guaranteed to be blocked. The timer is authoritative for the mutating HTTP methods listed above.

## Rewrite directory

The rewrites/ directory contains the injected controller stylesheet and the extension point for future site-specific rewrite rules. The first version rewrites common same-origin HTML URL attributes (links, scripts, images, media, forms, and base URLs). Add a tested transformer here rather than modifying unrelated proxy transport code.

## Boundaries and limitations

- **Not transparent HTTPS interception:** the browser uses local HTTP and sees the local proxy URL. Rust independently establishes upstream HTTPS with normal certificate verification. This workflow does not need a browser-installed CA because the browser connection to Intercept is HTTP. It does not preserve the original https://host/ address bar.
- Preserving original HTTPS hostnames while inspecting their traffic requires configuring the browser/network to send traffic through a CONNECT proxy and trusting a local interception CA in that browser. This code does not implement that MITM mode.
- One origin is pinned per session. Cross-origin links/forms and scripted cross-origin fetch/XMLHttpRequest are blocked or left outside the supported proxy path; third-party static resources may still load directly and therefore are not inspected.
- WebSockets, HTTP/3, service workers, download streaming, complex CSP/non-UTF-8 HTML, and full cookie semantics are not implemented.
- A site that uses unusual navigation, history APIs, custom event dispatch, or nonstandard form behavior may not replay perfectly.
- Browser page scripts execute in the local proxy origin. **Only open websites you trust.** A proxied page is not isolated from the local dashboard/API, so this version must not be treated as a security boundary against hostile website JavaScript.
- The IP checks and per-session DNS pinning reduce common SSRF/DNS-rebinding paths, but this is an early-stage development tool, not an audited security product.

## Configuration

The default listener is intentionally fixed to 127.0.0.1:5000. Restarting the process clears sessions, event history, and timers. Logs use the RUST_LOG environment variable (default: intercept=info).

## Tests

    cargo fmt --all -- --check
    cargo test
    cargo clippy --all-targets -- -D warnings
