use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::{Body, to_bytes},
    extract::{OriginalUri, Path, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode,
        header,
    },
    response::{Html, IntoResponse},
    routing::{any, get, post},
    Json, Router,
};
use futures_util::StreamExt;
use lol_html::{RewriteStrSettings, element, html_content::ContentType, rewrite_str};
use regex::Regex;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex, RwLock},
    time::{sleep_until, Instant},
};
use tracing::{info, warn};
use url::Url;
use uuid::Uuid;

const LISTEN: &str = "127.0.0.1:5000";
const MAX_REQUEST_BODY: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY: usize = 32 * 1024 * 1024;
const MAX_DELAY_SECONDS: u64 = 24 * 60 * 60;
const MIN_DELAY_NANOS: f64 = 0.000_000_001;
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CACHE_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_ASSET_CACHE_SECONDS: u64 = 300;

#[derive(Clone)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
}

struct Session {
    id: String,
    base_url: Url,
    clients: Mutex<HashMap<String, reqwest::Client>>,
    cache: Mutex<ResourceCache>,
    gate: Mutex<GateState>,
    gate_tx: watch::Sender<GateState>,
}

#[derive(Default)]
struct ResourceCache {
    entries: HashMap<String, CachedResponse>,
    bytes: usize,
}

#[derive(Clone)]
struct CachedResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
    expires_at: Instant,
}

#[derive(Clone, Copy)]
enum GateState {
    Waiting,
    Running { deadline: Instant },
    Released,
}

#[derive(Debug, Deserialize)]
struct CreateSession {
    url: String,
}

#[derive(Debug, Serialize)]
struct CreateSessionResponse {
    id: String,
    session_url: String,
}

#[derive(Debug, Deserialize)]
struct StartTimer {
    delay_seconds: f64,
}

#[derive(Debug, Serialize)]
struct StatusResponse {
    state: &'static str,
    remaining_ms: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "intercept=info,tower_http=info".into()),
        )
        .init();

    let state = AppState {
        sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/assets/controller.js", get(controller_js))
        .route("/assets/intercept.css", get(intercept_css))
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/{id}/start", post(start_timer))
        .route("/api/sessions/{id}/status", get(session_status))
        .route("/p/{id}", any(proxy))
        .route("/p/{id}/{*path}", any(proxy))
        .with_state(state);

    let address: SocketAddr = LISTEN.parse()?;
    let listener = TcpListener::bind(address).await?;
    info!("Intercept listening at http://{LISTEN}");
    info!("This service is loopback-only; it is not a network-wide transparent proxy.");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../web/index.html"))
}

async fn controller_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../web/controller.js"),
    )
}

async fn intercept_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../rewrites/intercept.css"),
    )
}

async fn create_session(
    State(state): State<AppState>,
    Json(input): Json<CreateSession>,
) -> Result<Json<CreateSessionResponse>, (StatusCode, String)> {
    let target = Url::parse(input.url.trim())
        .map_err(|_| (StatusCode::BAD_REQUEST, "Enter a valid absolute http:// or https:// URL".into()))?;

    if !matches!(target.scheme(), "http" | "https") {
        return Err((StatusCode::BAD_REQUEST, "Only HTTP and HTTPS upstream URLs are supported".into()));
    }
    if target.host_str().is_none() || !target.username().is_empty() || target.password().is_some() {
        return Err((StatusCode::BAD_REQUEST, "The URL must have a public host and must not contain credentials".into()));
    }
    if !is_public_destination(&target) {
        return Err((StatusCode::FORBIDDEN, "Local, private, and link-local destinations are blocked".into()));
    }

    let client = build_pinned_client(&target).await?;

    let id = Uuid::new_v4().simple().to_string();
    let mut clients = HashMap::new();
    clients.insert(origin_key(&target), client);
    let session = Arc::new(Session {
        id: id.clone(),
        base_url: target,
        clients: Mutex::new(clients),
        cache: Mutex::new(ResourceCache::default()),
        gate: Mutex::new(GateState::Waiting),
        gate_tx: watch::channel(GateState::Waiting).0,
    });

    // Preserve the submitted destination path, query, and browser-side fragment
    // in the local session URL. The upstream origin remains pinned in base_url.
    let session_url = local_url(&session.base_url, &id);
    state.sessions.write().await.insert(id.clone(), session);
    Ok(Json(CreateSessionResponse {
        id: id.clone(),
        session_url,
    }))
}


fn origin_key(url: &Url) -> String {
    url.origin().ascii_serialization()
}

async fn build_pinned_client(target: &Url) -> Result<reqwest::Client, (StatusCode, String)> {
    if !is_public_destination(target) {
        return Err((StatusCode::FORBIDDEN, "Local, private, and link-local destinations are blocked".into()));
    }

    let host = target.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = target.port_or_known_default().unwrap_or(443);
    let addresses = match target.host() {
        Some(url::Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(url::Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        Some(url::Host::Domain(domain)) => {
            match tokio::net::lookup_host((domain, port)).await {
                Ok(addresses) => addresses.collect::<Vec<_>>(),
                Err(error) => {
                    warn!(
                        host = %domain,
                        port,
                        %error,
                        "The operating-system DNS resolver could not resolve an upstream host"
                    );
                    return Err((
                        StatusCode::BAD_GATEWAY,
                        format!("DNS lookup failed for '{domain}:{port}': {error}"),
                    ));
                }
            }
        },
        None => Vec::new(),
    };

    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err((StatusCode::FORBIDDEN, "Upstream DNS resolved to a local, private, or non-public address".into()));
    }

    let mut builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(16)
        .user_agent("Intercept/0.1 (+http://127.0.0.1:5000)");
    if matches!(target.host(), Some(url::Host::Domain(_))) {
        builder = builder.resolve_to_addrs(&host, &addresses);
    }
    builder
        .build()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Could not initialize upstream TLS client".into()))
}

async fn client_for(session: &Session, target: &Url) -> Result<reqwest::Client, (StatusCode, String)> {
    let key = origin_key(target);
    let mut clients = session.clients.lock().await;
    if let Some(client) = clients.get(&key) {
        return Ok(client.clone());
    }

    let client = build_pinned_client(target).await?;
    clients.insert(key, client.clone());
    Ok(client)
}

async fn start_timer(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<StartTimer>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let duration = timer_duration(input.delay_seconds)?;
    let session = find_session(&state, &id).await?;
    let deadline = Instant::now() + duration;
    {
        let mut gate = session.gate.lock().await;
        match *gate {
            GateState::Waiting => {
                *gate = GateState::Running { deadline };
                session.gate_tx.send_replace(*gate);
            }
            GateState::Running { .. } | GateState::Released => {
                return Err((StatusCode::CONFLICT, "The timer has already been started for this session".into()));
            }
        }
    }

    let timer_session = Arc::clone(&session);
    tokio::spawn(async move {
        sleep_until(deadline).await;
        let mut gate = timer_session.gate.lock().await;
        if matches!(*gate, GateState::Running { .. }) {
            *gate = GateState::Released;
            drop(gate);
            timer_session.gate_tx.send_replace(GateState::Released);
            info!(session = %timer_session.id, "Timer expired; state-changing requests are now authorized");
        }
    });

    Ok(Json(status_for(&session).await))
}

fn timer_duration(delay_seconds: f64) -> Result<Duration, (StatusCode, String)> {
    if !delay_seconds.is_finite()
        || delay_seconds <= 0.0
        || delay_seconds > MAX_DELAY_SECONDS as f64
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("delay_seconds must be greater than 0 and no more than {MAX_DELAY_SECONDS}"),
        ));
    }

    let duration = Duration::from_secs_f64(delay_seconds);
    if duration.is_zero() || delay_seconds < MIN_DELAY_NANOS {
        return Err((
            StatusCode::BAD_REQUEST,
            "delay_seconds must be at least 0.000000001 seconds (1 nanosecond)".into(),
        ));
    }

    Ok(duration)
}

async fn session_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let session = find_session(&state, &id).await?;
    Ok(Json(status_for(&session).await))
}

async fn find_session(
    state: &AppState,
    id: &str,
) -> Result<Arc<Session>, (StatusCode, String)> {
    state
        .sessions
        .read()
        .await
        .get(id)
        .cloned()
        .ok_or((StatusCode::NOT_FOUND, "Unknown or expired session".into()))
}

async fn status_for(session: &Session) -> StatusResponse {
    let (state, remaining_ms) = {
        let gate = session.gate.lock().await;
        match *gate {
            GateState::Waiting => ("waiting", 0),
            GateState::Running { deadline } => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let remaining_ms = remaining.as_millis().saturating_add(
                    if remaining.subsec_nanos() % 1_000_000 != 0 { 1 } else { 0 },
                );
                ("running", remaining_ms as u64)
            },
            GateState::Released => ("released", 0),
        }
    };
    StatusResponse {
        state,
        remaining_ms,
    }
}

async fn wait_for_authorization(session: &Session) {
    let mut updates = session.gate_tx.subscribe();
    loop {
        let state = *updates.borrow_and_update();
        match state {
            GateState::Waiting => {
                if updates.changed().await.is_err() {
                    return;
                }
            }
            GateState::Released => return,
            GateState::Running { deadline } => {
                tokio::select! {
                    _ = sleep_until(deadline) => {
                        let released = {
                            let mut gate = session.gate.lock().await;
                            if matches!(*gate, GateState::Running { .. }) {
                                *gate = GateState::Released;
                                true
                            } else {
                                false
                            }
                        };
                        if released {
                            session.gate_tx.send_replace(GateState::Released);
                        }
                    }
                    changed = updates.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

async fn proxy(
    State(state): State<AppState>,
    Path(params): Path<HashMap<String, String>>,
    OriginalUri(uri): OriginalUri,
    request: Request<Body>,
) -> Response<Body> {
    let Some(id) = params.get("id") else {
        return plain(StatusCode::BAD_REQUEST, "Missing session id");
    };
    let session = match find_session(&state, id).await {
        Ok(session) => session,
        Err((status, message)) => return plain(status, &message),
    };

    let upstream_url = match upstream_url_for_request(&uri, &session) {
        Ok(url) => url,
        Err(message) => return plain(StatusCode::BAD_REQUEST, &message),
    };
    if !matches!(upstream_url.scheme(), "http" | "https") || !is_public_destination(&upstream_url) {
        return plain(StatusCode::FORBIDDEN, "Only public HTTP and HTTPS destinations are allowed");
    }

    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_REQUEST_BODY).await {
        Ok(body) => body,
        Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request body exceeds the 8 MiB limit"),
    };

    if parts.method != Method::GET && parts.method != Method::HEAD && parts.method != Method::OPTIONS {
        wait_for_authorization(&session).await;
    }

    let cache_key = if parts.method == Method::GET {
        Some(resource_cache_key(&upstream_url, &parts.headers))
    } else {
        None
    };
    let bypass_cache = parts.headers
        .get(header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("no-cache") || value.contains("no-store"));

    let cached = if bypass_cache {
        None
    } else if let Some(key) = cache_key.as_deref() {
        cache_get(&session, key).await
    } else {
        None
    };

    let (upstream_status, upstream_headers, mut response_body) = if let Some(cached) = cached {
        (cached.status, cached.headers, cached.body)
    } else {
        let client = match client_for(&session, &upstream_url).await {
            Ok(client) => client,
            Err((status, message)) => return plain(status, &message),
        };
        let method = match reqwest::Method::from_bytes(parts.method.as_str().as_bytes()) {
            Ok(method) => method,
            Err(_) => return plain(StatusCode::METHOD_NOT_ALLOWED, "Unsupported HTTP method"),
        };

        let mut builder = client.request(method, upstream_url.clone());
        for (name, value) in parts.headers.iter() {
            if should_skip_request_header(name) {
                continue;
            }
            if name == header::ORIGIN {
                if let Ok(origin) = HeaderValue::from_str(&session.base_url.origin().ascii_serialization()) {
                    builder = builder.header(name.clone(), origin);
                }
            } else if name == header::REFERER {
                if let Some(referer) = rewrite_referer(value, &session) {
                    builder = builder.header(name.clone(), referer);
                }
            } else if name.as_str() == "sec-fetch-site" {
                let fetch_site = if upstream_url.origin() == session.base_url.origin() {
                    "same-origin"
                } else {
                    "cross-site"
                };
                builder = builder.header(name.clone(), fetch_site);
            } else {
                builder = builder.header(name.clone(), value.clone());
            }
        }
        builder = builder.header(header::ACCEPT_ENCODING, "identity").body(body);

        let upstream = match builder.send().await {
            Ok(response) => response,
            Err(error) => {
                warn!(%error, url = %upstream_url, "Upstream request failed");
                return plain(StatusCode::BAD_GATEWAY, "Upstream request failed");
            }
        };

        let status = upstream.status();
        let headers = upstream.headers().clone();
        if let Some(length) = upstream.content_length() {
            if length > MAX_RESPONSE_BODY as u64 {
                return plain(StatusCode::PAYLOAD_TOO_LARGE, "Upstream response exceeds the 32 MiB limit");
            }
        }

        let mut bytes = Vec::new();
        let mut stream = upstream.bytes_stream();
        while let Some(next) = stream.next().await {
            match next {
                Ok(chunk) => {
                    if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY {
                        return plain(StatusCode::PAYLOAD_TOO_LARGE, "Upstream response exceeds the 32 MiB limit");
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Err(error) => {
                    warn!(%error, url = %upstream_url, "Failed while reading upstream response");
                    return plain(StatusCode::BAD_GATEWAY, "Failed while reading upstream response");
                }
            }
        }

        if let Some(key) = cache_key.as_deref() {
            if !bypass_cache {
                cache_put(&session, key, status, &headers, &bytes).await;
            }
        }
        (status, headers, bytes)
    };

    let content_type = upstream_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut transformed = false;
    if content_type.contains("text/html") {
        if let Ok(html) = std::str::from_utf8(&response_body) {
            match rewrite_html(html, &upstream_url, &session.base_url, id) {
                Ok(rewritten) => {
                    response_body = rewritten.into_bytes();
                    transformed = true;
                }
                Err(error) => warn!(%error, url = %upstream_url, "HTML rewrite failed; returning original HTML"),
            }
        }
    } else if content_type.contains("text/css") {
        if let Ok(css) = std::str::from_utf8(&response_body) {
            match rewrite_css(css, &upstream_url, &session.base_url, id) {
                Ok(rewritten) => {
                    response_body = rewritten.into_bytes();
                    transformed = true;
                }
                Err(error) => warn!(%error, url = %upstream_url, "CSS rewrite failed; returning original stylesheet"),
            }
        }
    }

    let mut response = Response::builder().status(upstream_status);
    let headers = response.headers_mut().expect("fresh response builder");
    for (name, value) in upstream_headers.iter() {
        if should_skip_response_header(name)
            || (transformed && (
                name == header::CONTENT_LENGTH
                    || name == header::CONTENT_ENCODING
                    || name == header::ETAG
            ))
        {
            continue;
        }
        if transformed && matches!(name.as_str(), "content-md5" | "digest") {
            continue;
        }

        if name == header::LOCATION {
            if let Ok(location) = value.to_str() {
                let rewritten = rewrite_location(location, &upstream_url, &session.base_url, id);
                if let Ok(value) = HeaderValue::from_str(&rewritten) {
                    headers.append(name.clone(), value);
                }
            }
        } else if name == header::SET_COOKIE {
            if let Ok(cookie) = value.to_str() {
                if let Ok(value) = HeaderValue::from_str(&rewrite_set_cookie(cookie, &upstream_url, &session.base_url, id)) {
                    headers.append(name.clone(), value);
                }
            }
        } else if matches!(name.as_str(), "content-security-policy" | "content-security-policy-report-only") {
            if let Ok(policy) = value.to_str() {
                if let Ok(value) = HeaderValue::from_str(&rewrite_csp(policy)) {
                    headers.append(name.clone(), value);
                }
            }
        } else {
            headers.append(name.clone(), value.clone());
        }
    }

    if transformed && content_type.contains("text/html") {
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    } else if transformed && content_type.contains("text/css") {
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/css; charset=utf-8"));
    }
    response.body(Body::from(response_body))
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Could not build proxy response"))
}

fn upstream_url_for_request(uri: &axum::http::Uri, session: &Session) -> Result<Url, String> {
    let prefix = format!("/p/{}", session.id);
    let suffix = uri.path().strip_prefix(&prefix)
        .ok_or_else(|| "Request path is outside this session".to_owned())?;

    if let Some(encoded_origin) = suffix.strip_prefix("/_/") {
        let (scheme, host_and_path) = encoded_origin.split_once('/')
            .ok_or_else(|| "Malformed proxied origin path".to_owned())?;
        if !matches!(scheme, "http" | "https") {
            return Err("Only HTTP and HTTPS origins are supported".into());
        }
        let (authority, path) = host_and_path.split_once('/')
            .unwrap_or((host_and_path, ""));
        if authority.is_empty() {
            return Err("Missing upstream host in proxied URL".into());
        }
        let mut target = Url::parse(&format!("{scheme}://{authority}/{}", path.trim_start_matches('/')))
            .map_err(|_| "Malformed upstream URL".to_owned())?;
        target.set_query(uri.query());
        return Ok(target);
    }

    let mut target = session.base_url.clone();
    if !suffix.is_empty() {
        target.set_path(suffix);
        target.set_query(uri.query());
    } else if let Some(query) = uri.query() {
        target.set_query(Some(query));
    }
    Ok(target)
}

fn rewrite_referer(value: &HeaderValue, session: &Session) -> Option<HeaderValue> {
    let text = value.to_str().ok()?;
    let referer = Url::parse(text).ok()?;
    if !matches!(referer.scheme(), "http" | "https") {
        return None;
    }

    let upstream = if referer.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost")
    }) && referer.port() == Some(5000) {
        let mut referer = referer;
        referer.set_fragment(None);
        let uri = referer.as_str().parse::<axum::http::Uri>().ok()?;
        upstream_url_for_request(&uri, session).ok()?
    } else {
        referer
    };
    HeaderValue::from_str(upstream.as_str()).ok()
}

fn resource_cache_key(url: &Url, headers: &HeaderMap) -> String {
    let value = |name: header::HeaderName| {
        headers.get(name).and_then(|value| value.to_str().ok()).unwrap_or("").to_owned()
    };
    format!(
        "{}\n{}\n{}\n{}\n{}",
        url,
        value(header::ACCEPT),
        value(header::ACCEPT_LANGUAGE),
        value(header::COOKIE),
        value(header::USER_AGENT)
    )
}

async fn cache_get(session: &Session, key: &str) -> Option<CachedResponse> {
    let mut cache = session.cache.lock().await;
    let expired = cache.entries.get(key).is_some_and(|entry| entry.expires_at <= Instant::now());
    if expired {
        if let Some(entry) = cache.entries.remove(key) {
            cache.bytes = cache.bytes.saturating_sub(entry.body.len());
        }
        return None;
    }
    cache.entries.get(key).cloned()
}

async fn cache_put(
    session: &Session,
    key: &str,
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
) {
    if status != StatusCode::OK || body.is_empty() || body.len() > MAX_CACHE_ENTRY_BYTES {
        return;
    }
    let content_type = headers.get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if !is_cacheable_asset(&content_type) || headers.contains_key(header::SET_COOKIE) {
        return;
    }
    let control = headers.get(header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok()).unwrap_or("");
    if control.split(',').any(|part| matches!(part.trim(), "no-store" | "no-cache")) {
        return;
    }
    let vary = headers.get(header::VARY).and_then(|value| value.to_str().ok()).unwrap_or("");
    if vary.trim() == "*" || vary.split(',').any(|name| {
        !matches!(name.trim().to_ascii_lowercase().as_str(), "accept" | "accept-language" | "user-agent")
    }) {
        return;
    }

    let ttl = control.split(',')
        .filter_map(|part| part.trim().strip_prefix("max-age="))
        .find_map(|value| value.trim_matches('"').parse::<u64>().ok())
        .unwrap_or(DEFAULT_ASSET_CACHE_SECONDS)
        .min(86_400);
    if ttl == 0 {
        return;
    }

    let mut cache = session.cache.lock().await;
    if let Some(old) = cache.entries.remove(key) {
        cache.bytes = cache.bytes.saturating_sub(old.body.len());
    }
    while cache.bytes.saturating_add(body.len()) > MAX_CACHE_BYTES {
        let Some(oldest_key) = cache.entries.iter()
            .min_by_key(|(_, entry)| entry.expires_at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        if let Some(old) = cache.entries.remove(&oldest_key) {
            cache.bytes = cache.bytes.saturating_sub(old.body.len());
        }
    }
    cache.bytes = cache.bytes.saturating_add(body.len());
    cache.entries.insert(key.to_owned(), CachedResponse {
        status,
        headers: headers.clone(),
        body: body.to_vec(),
        expires_at: Instant::now() + Duration::from_secs(ttl),
    });
}

fn is_cacheable_asset(content_type: &str) -> bool {
    content_type.starts_with("text/css")
        || content_type.contains("javascript")
        || content_type.starts_with("image/")
        || content_type.starts_with("font/")
        || content_type.contains("application/font")
        || content_type.contains("application/wasm")
}
fn rewrite_html(
    html: &str,
    base: &Url,
    session_base: &Url,
    session_id: &str,
) -> Result<String, String> {
    let style_blocks = Regex::new(r"(?is)(<style\b[^>]*>)(.*?)(</style\s*>)")
        .map_err(|error| error.to_string())?;
    let html_with_styles = style_blocks.replace_all(html, |captures: &regex::Captures<'_>| {
        let open = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let body = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        let close = captures.get(3).map(|m| m.as_str()).unwrap_or("");
        let rewritten = rewrite_css(body, base, session_base, session_id)
            .unwrap_or_else(|_| body.to_owned());
        format!("{open}{rewritten}{close}")
    }).into_owned();

    let mut settings = RewriteStrSettings::new();
    let base_for_attrs = base.clone();
    let session_base_for_attrs = session_base.clone();
    let id_for_attrs = session_id.to_owned();
    settings = settings.append_element_content_handler(element!(
        "a[href],area[href],link[href],script[src],img[src],source[src],iframe[src],video[src],video[poster],audio[src],input[src],form[action],button[formaction],base[href],object[data],embed[src],track[src],[srcset],[style]",
        move |el| {
            for attribute in ["href", "src", "action", "formaction", "poster", "data", "cite", "background"] {
                if let Some(value) = el.get_attribute(attribute) {
                    if let Some(rewritten) = rewrite_url(
                        &base_for_attrs,
                        &session_base_for_attrs,
                        &id_for_attrs,
                        &value,
                    ) {
                        el.set_attribute(attribute, &rewritten)?;
                    }
                }
            }
            if let Some(srcset) = el.get_attribute("srcset") {
                let rewritten = rewrite_srcset(
                    &base_for_attrs,
                    &session_base_for_attrs,
                    &id_for_attrs,
                    &srcset,
                );
                el.set_attribute("srcset", &rewritten)?;
            }
            if let Some(style) = el.get_attribute("style") {
                if let Ok(rewritten) = rewrite_css(
                    &style,
                    &base_for_attrs,
                    &session_base_for_attrs,
                    &id_for_attrs,
                ) {
                    el.set_attribute("style", &rewritten)?;
                }
            }
            Ok(())
        }
    ));

    let id_for_head = session_id.to_owned();
    let primary_origin = session_base.origin().ascii_serialization();
    settings = settings.append_element_content_handler(element!("head", move |el| {
        let head = format!(
            r#"<script src="/assets/controller.js" data-session="{id_for_head}" data-upstream-origin="{primary_origin}"></script><link rel="stylesheet" href="/assets/intercept.css">"#
        );
        el.prepend(&head, ContentType::Html);
        Ok(())
    }));

    settings = settings.append_element_content_handler(element!("body", move |el| {
        let banner = r#"<aside id="intercept-toolbar" aria-label="Intercept authority">
<div class="intercept-row"><strong>INTERCEPT AUTHORITY</strong>
<span id="intercept-state">WAITING</span>
<label for="intercept-delay">DELAY (SECONDS)</label>
<input id="intercept-delay" type="number" min="0.000000001" max="86400" step="any" value="30" inputmode="decimal">
<button id="intercept-start" type="button">[START]</button>
<span id="intercept-countdown">NOT STARTED</span>
</div>
</aside>"#;
        el.append(banner, ContentType::Html);
        Ok(())
    }));

    rewrite_str(&html_with_styles, settings).map_err(|error| error.to_string())
}

fn rewrite_url(
    base: &Url,
    session_base: &Url,
    session_id: &str,
    value: &str,
) -> Option<String> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || lower.starts_with("data:")
        || lower.starts_with("javascript:")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:")
        || lower.starts_with("blob:")
    {
        return None;
    }
    let absolute = base.join(trimmed).ok()?;
    if !matches!(absolute.scheme(), "http" | "https") || absolute.host_str().is_none() {
        return None;
    }
    Some(proxy_url(&absolute, session_base, session_id))
}

fn proxy_origin_prefix(target: &Url, session_base: &Url, session_id: &str) -> String {
    if target.origin() == session_base.origin() {
        return format!("/p/{session_id}");
    }
    let origin = target.origin().ascii_serialization();
    let authority = origin.strip_prefix(&format!("{}://", target.scheme())).unwrap_or("");
    format!("/p/{session_id}/_/{}/{authority}", target.scheme())
}

fn proxy_url(target: &Url, session_base: &Url, session_id: &str) -> String {
    let mut result = format!("{}{}", proxy_origin_prefix(target, session_base, session_id), target.path());
    if let Some(query) = target.query() {
        result.push('?');
        result.push_str(query);
    }
    if let Some(fragment) = target.fragment() {
        result.push('#');
        result.push_str(fragment);
    }
    result
}

fn local_url(upstream: &Url, session_id: &str) -> String {
    proxy_url(upstream, upstream, session_id)
}

fn rewrite_srcset(base: &Url, session_base: &Url, session_id: &str, value: &str) -> String {
    value.split(',')
        .map(|candidate| {
            let candidate = candidate.trim();
            let mut pieces = candidate.split_whitespace();
            let Some(url) = pieces.next() else { return candidate.to_owned() };
            let rewritten = rewrite_url(base, session_base, session_id, url)
                .unwrap_or_else(|| url.to_owned());
            let descriptor = pieces.collect::<Vec<_>>().join(" ");
            if descriptor.is_empty() { rewritten } else { format!("{rewritten} {descriptor}") }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn rewrite_css(css: &str, base: &Url, session_base: &Url, session_id: &str) -> Result<String, String> {
    let url_pattern = Regex::new(r#"(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)"#)
        .map_err(|error| error.to_string())?;
    let with_urls = url_pattern.replace_all(css, |captures: &regex::Captures<'_>| {
        let original = captures.get(0).map(|m| m.as_str()).unwrap_or("");
        let raw = captures.get(1).or_else(|| captures.get(2)).or_else(|| captures.get(3))
            .map(|m| m.as_str().trim()).unwrap_or("");
        match rewrite_url(base, session_base, session_id, raw) {
            Some(rewritten) => format!(r#"url("{rewritten}")"#),
            None => original.to_owned(),
        }
    });

    let import_pattern = Regex::new(r#"(?i)@import\s+(?:"([^"]+)"|'([^']+)')"#)
        .map_err(|error| error.to_string())?;
    let with_imports = import_pattern.replace_all(&with_urls, |captures: &regex::Captures<'_>| {
        let original = captures.get(0).map(|m| m.as_str()).unwrap_or("");
        let raw = captures.get(1).or_else(|| captures.get(2)).map(|m| m.as_str()).unwrap_or("");
        match rewrite_url(base, session_base, session_id, raw) {
            Some(rewritten) => format!(r#"@import url("{rewritten}")"#),
            None => original.to_owned(),
        }
    });
    Ok(with_imports.into_owned())
}

fn rewrite_location(location: &str, current: &Url, session_base: &Url, session_id: &str) -> String {
    match current.join(location) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => proxy_url(&url, session_base, session_id),
        _ => location.to_owned(),
    }
}

fn rewrite_set_cookie(cookie: &str, target: &Url, session_base: &Url, session_id: &str) -> String {
    let prefix = proxy_origin_prefix(target, session_base, session_id);
    let mut parts = cookie
        .split(';')
        .map(str::trim)
        .filter(|part| !part.to_ascii_lowercase().starts_with("domain="))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut found_path = false;
    for part in &mut parts {
        if part.to_ascii_lowercase().starts_with("path=") {
            let upstream_path = part[5..].trim();
            let suffix = if upstream_path.is_empty() { "/" } else if upstream_path.starts_with('/') { upstream_path } else { "" };
            *part = format!("Path={prefix}{suffix}");
            found_path = true;
        }
    }
    if !found_path {
        parts.push(format!("Path={prefix}/"));
    }
    parts.join("; ")
}

fn rewrite_csp(policy: &str) -> String {
    const LOCAL_ORIGIN: &str = "http://127.0.0.1:5000";
    const SOURCE_DIRECTIVES: &[&str] = &[
        "default-src", "script-src", "script-src-elem", "script-src-attr",
        "style-src", "style-src-elem", "style-src-attr", "img-src", "font-src",
        "media-src", "connect-src", "frame-src", "child-src", "worker-src",
        "manifest-src", "prefetch-src", "form-action", "base-uri", "object-src",
    ];
    policy.split(';')
        .filter_map(|directive| {
            let mut tokens = directive.split_whitespace();
            let name = tokens.next()?;
            if name.eq_ignore_ascii_case("upgrade-insecure-requests") {
                return None;
            }
            let mut values = tokens.map(str::to_owned).collect::<Vec<_>>();
            if SOURCE_DIRECTIVES.iter().any(|candidate| name.eq_ignore_ascii_case(candidate)) {
                values.retain(|value| value != "'none'");
                for value in &mut values {
                    if value.starts_with("http://") || value.starts_with("https://") || value.starts_with("*.") {
                        *value = LOCAL_ORIGIN.to_owned();
                    }
                }
                if !values.iter().any(|value| value == LOCAL_ORIGIN || value == "'self'") {
                    values.push(LOCAL_ORIGIN.to_owned());
                }
            }
            Some(if values.is_empty() { name.to_owned() } else { format!("{name} {}", values.join(" ")) })
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn should_skip_request_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host" | "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade" | "content-length"
            | "accept-encoding" | "origin" | "referer"
    )
}

fn should_skip_response_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade"
    )
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_destination(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
        || normalized.ends_with(".internal")
        || normalized.ends_with(".lan")
    {
        return false;
    }

    match url.host() {
        Some(url::Host::Ipv4(ip)) => is_public_v4(ip),
        Some(url::Host::Ipv6(ip)) => is_public_v6(ip),
        Some(url::Host::Domain(_)) => true,
        None => false,
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_private()
        || ip.is_multicast()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)))
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
        || ip.to_ipv4_mapped().is_some_and(|v4| !is_public_v4(v4)))
}

fn plain(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(message.to_owned()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_fractional_timer_delays() {
        assert_eq!(timer_duration(1.25).unwrap(), Duration::from_millis(1250));
        assert_eq!(timer_duration(0.5).unwrap(), Duration::from_millis(500));
    }

    #[test]
    fn accepts_maximum_timer_delay() {
        assert_eq!(
            timer_duration(MAX_DELAY_SECONDS as f64).unwrap(),
            Duration::from_secs(MAX_DELAY_SECONDS)
        );
    }

    #[test]
    fn rejects_invalid_timer_delays() {
        for seconds in [
            0.0,
            -1.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            0.000_000_000_1,
            MAX_DELAY_SECONDS as f64 + 0.1,
        ] {
            assert!(timer_duration(seconds).is_err(), "accepted {seconds}");
        }
    }

    #[test]
    fn rejects_private_and_local_destinations() {
        for value in [
            "http://127.0.0.1/",
            "http://192.168.1.10/",
            "http://10.0.0.4/",
            "http://localhost/",
            "http://service.local/",
            "http://[::1]/",
        ] {
            let url = Url::parse(value).unwrap();
            assert!(!is_public_destination(&url), "{value}");
        }
    }

    #[test]
    fn allows_public_https_hosts() {
        let url = Url::parse("https://example.com/docs").unwrap();
        assert!(is_public_destination(&url));
    }

    #[test]
    fn rewrites_same_origin_and_external_urls_to_local_session_paths() {
        let base = Url::parse("https://example.com/account/").unwrap();
        assert_eq!(
            rewrite_url(&base, &base, "session123", "../settings?tab=security"),
            Some("/p/session123/settings?tab=security".to_owned())
        );
        assert_eq!(
            rewrite_url(&base, &base, "session123", "https://cdn.example/image.png"),
            Some("/p/session123/_/https/cdn.example/image.png".to_owned())
        );
    }

    #[test]
    fn session_url_preserves_the_submitted_path_query_and_fragment() {
        let target = Url::parse("https://example.com/account/settings?tab=security#sessions").unwrap();
        assert_eq!(
            local_url(&target, "session123"),
            "/p/session123/account/settings?tab=security#sessions"
        );
    }

    #[test]
    fn session_url_preserves_root_query_and_fragment() {
        let target = Url::parse("https://example.com/?mode=compact#top").unwrap();
        assert_eq!(
            local_url(&target, "session123"),
            "/p/session123/?mode=compact#top"
        );
    }

    #[test]
    fn rewrites_cookie_paths_to_the_session_prefix() {
        assert_eq!(
            rewrite_set_cookie("sid=abc; Domain=example.com; Path=/admin; HttpOnly", &Url::parse("https://example.com/").unwrap(), &Url::parse("https://example.com/").unwrap(), "session123"),
            "sid=abc; Path=/p/session123/admin; HttpOnly"
        );
    }

    #[test]
    fn rewrites_session_urls_and_injects_only_the_authority_banner() {
        let base = Url::parse("https://example.com/").unwrap();
        let html = r#"<!doctype html><html><head></head><body><a href="/next">next</a></body></html>"#;
        let result = rewrite_html(html, &base, &base, "session123").unwrap();
        assert!(result.contains("/p/session123/next"));
        assert!(result.contains("/assets/controller.js"));
        assert!(result.contains("intercept-toolbar"));
        assert!(result.contains("INTERCEPT AUTHORITY"));
        assert!(!result.contains("intercept-events"));
        assert!(!result.contains("listener_registered"));
    }

    #[test]
    fn rewrites_external_resources_inside_css() {
        let base = Url::parse("https://example.com/css/site.css").unwrap();
        let output = rewrite_css(
            "body { background: url('../images/bg.png') } @import url('https://cdn.example/theme.css');",
            &base,
            &Url::parse("https://example.com/").unwrap(),
            "session123",
        ).unwrap();
        assert!(output.contains("/p/session123/images/bg.png"));
        assert!(output.contains("/p/session123/_/https/cdn.example/theme.css"));
    }

    #[test]
    fn scopes_external_cookies_to_their_proxy_origin_path() {
        let primary = Url::parse("https://example.com/").unwrap();
        let cdn = Url::parse("https://cdn.example/").unwrap();
        assert_eq!(
            rewrite_set_cookie(
                "asset=abc; Domain=cdn.example; Path=/; HttpOnly",
                &cdn,
                &primary,
                "session123",
            ),
            "asset=abc; Path=/p/session123/_/https/cdn.example/; HttpOnly"
        );
    }

    #[test]
    fn rewrites_external_redirects_through_the_session() {
        let current = Url::parse("https://example.com/start").unwrap();
        let primary = Url::parse("https://example.com/").unwrap();
        assert_eq!(
            rewrite_location("https://accounts.example/login", &current, &primary, "session123"),
            "/p/session123/_/https/accounts.example/login"
        );
    }

    #[test]
    fn rewrites_external_origins_in_csp_to_local_proxy_origin() {
        let policy = "default-src 'self' https://cdn.example; img-src https://images.example";
        let output = rewrite_csp(policy);
        assert!(output.contains("default-src 'self' http://127.0.0.1:5000"));
        assert!(output.contains("img-src http://127.0.0.1:5000"));
    }

    #[test]
    fn namespaces_external_origins_in_proxy_paths() {
        let primary = Url::parse("https://example.com/").unwrap();
        let external = Url::parse("https://cdn.example:8443/a.js").unwrap();
        assert_eq!(
            proxy_url(&external, &primary, "session123"),
            "/p/session123/_/https/cdn.example:8443/a.js"
        );
    }
}
