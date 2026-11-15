# intercept

A Rust-based local HTTP gateway that fronts a configured HTTPS origin.

## HTTPS Action Proxy

The standalone Rust project is available in [`https-action-proxy.zip`](https://github.com/jordanlegare/intercept/raw/feature/https-action-proxy/https-action-proxy.zip).

The browser connects to `http://localhost:5000`. The proxy makes verified, pooled HTTPS connections to one configured upstream origin, evaluates request/response events through an embedded JavaScript policy, and enforces the configured request delay in Rust.

### Build and run

```bash
unzip https-action-proxy.zip
cd https-action-proxy
cargo test
cargo run --release -- \
  --upstream https://example.com \
  --listen 127.0.0.1:5000 \
  --delay-ms 1500
```

Then open `http://localhost:5000/`.

### Scope and security

This first version is a **single-origin reverse proxy**, not a transparent browser-wide forward proxy. It does not intercept arbitrary HTTPS destinations or decrypt browser-to-site TLS. Instead, Rust terminates TLS on its own upstream HTTPS connection and serves the returned content over HTTP on loopback.

Keep the listener bound to `127.0.0.1`. The local browser-to-proxy leg is plain HTTP. Some websites require HTTPS-origin features and may not work correctly when served from localhost over HTTP. WebSockets, HTTP/3, multi-origin routing, and browser-side DOM events are not included in this starter.
