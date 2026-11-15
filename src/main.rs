use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{Body, to_bytes},
    extract::{OriginalUri, Path, State},
    http::{
        HeaderName, HeaderValue, Method, Request, Response, StatusCode,
        header,
    },
    response::{Html, IntoResponse},
    routing::{any, get, post},
    Json, Router,
};
use futures_util::StreamExt;
use lol_html::{RewriteStrSettings, element, html_content::ContentType, rewrite_str};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex, RwLock},
    time::sleep_until,
};
use tracing::{info, warn};
use url::Url;
use uuid::Uuid;

const LISTEN: &str = "127.0.0.1:5000";
const MAX_REQUEST_BODY: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY: usize = 32 * 1024 * 1024;
const MAX_EVENTS: usize = 500;
const MAX_DELAY_SECONDS: u64 = 24 * 60 * 60;

#[derive(Clone)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
}

struct Session {
    id: String,
    base_url: Url,
    client: reqwest::Client,
    gate: Mutex<GateState>,
    gate_tx: watch::Sender<GateState>,
    events: Mutex<VecDeque<ActionEvent>>,
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
    delay_seconds: u64,
}

#[derive(Debug, Deserialize)]
struct EventInput {
    kind: String,
    target: Option<String>,
    detail: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct ActionEvent {
    at_unix_ms: u128,
    kind: String,
    target: String,
    detail: String,
}

#[derive(Debug, Serialize)]
struct StatusResponse {
    state: &'static str,
    remaining_ms: u64,
    event_count: usize,
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
        .route("/api/sessions/{id}/events", get(get_events).post(record_events))
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
    let mut target = Url::parse(input.url.trim())
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

    // Resolve once, reject non-public answers, and pin the session client to those
    // addresses so a later DNS answer cannot rebind this session to a private host.
    let host = target.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = target.port_or_known_default().unwrap_or(443);
    let addresses = match target.host() {
        Some(url::Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(url::Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        Some(url::Host::Domain(domain)) => tokio::net::lookup_host((domain, port))
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Could not resolve upstream host".into()))?
            .collect::<Vec<_>>(),
        None => Vec::new(),
    };
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err((StatusCode::FORBIDDEN, "Upstream DNS resolved to a local, private, or non-public address".into()));
    }

    let mut client_builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(16)
        .user_agent("Intercept/0.1 (+http://127.0.0.1:5000)");
    if matches!(target.host(), Some(url::Host::Domain(_))) {
        client_builder = client_builder.resolve_to_addrs(&host, &addresses);
    }
    let client = client_builder
        .build()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Could not initialize upstream TLS client".into()))?;

    target.set_fragment(None);
    let id = Uuid::new_v4().simple().to_string();
    let session = Arc::new(Session {
        id: id.clone(),
        base_url: target,
        client,
        gate: Mutex::new(GateState::Waiting),
        gate_tx: watch::channel(GateState::Waiting).0,
        events: Mutex::new(VecDeque::new()),
    });

    state.sessions.write().await.insert(id.clone(), session);
    Ok(Json(CreateSessionResponse {
        id: id.clone(),
        session_url: format!("/p/{id}"),
    }))
}

async fn start_timer(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<StartTimer>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    if input.delay_seconds == 0 || input.delay_seconds > MAX_DELAY_SECONDS {
        return Err((StatusCode::BAD_REQUEST, "delay_seconds must be between 1 and 86400".into()));
    }
    let session = find_session(&state, &id).await?;
    let deadline = Instant::now() + Duration::from_secs(input.delay_seconds);
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

async fn session_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let session = find_session(&state, &id).await?;
    Ok(Json(status_for(&session).await))
}

async fn get_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<ActionEvent>>, (StatusCode, String)> {
    let session = find_session(&state, &id).await?;
    let events = session.events.lock().await.iter().cloned().collect::<Vec<_>>();
    Ok(Json(events))
}

async fn record_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(inputs): Json<Vec<EventInput>>,
) -> Result<StatusCode, (StatusCode, String)> {
    let session = find_session(&state, &id).await?;
    for input in inputs.into_iter().take(100) {
        push_event(
            &session,
            &input.kind,
            input.target.unwrap_or_default(),
            input.detail.unwrap_or_default(),
        ).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn push_event(session: &Session, kind: &str, target: String, detail: String) {
    let mut events = session.events.lock().await;
    if events.len() == MAX_EVENTS {
        events.pop_front();
    }
    events.push_back(ActionEvent {
        at_unix_ms: now_ms(),
        kind: clean_field(kind.to_owned(), 80),
        target: clean_field(target, 240),
        detail: clean_field(detail, 300),
    });
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
            GateState::Running { deadline } => (
                "running",
                deadline.saturating_duration_since(Instant::now()).as_millis() as u64,
            ),
            GateState::Released => ("released", 0),
        }
    };
    let event_count = session.events.lock().await.len();
    StatusResponse {
        state,
        remaining_ms,
        event_count,
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

    let mut upstream_url = session.base_url.clone();
    let prefix = format!("/p/{id}");
    let suffix = uri.path().strip_prefix(&prefix).unwrap_or("");
    if !suffix.is_empty() {
        upstream_url.set_path(suffix);
        upstream_url.set_query(uri.query());
    } else if let Some(query) = uri.query() {
        upstream_url.set_query(Some(query));
    }

    if upstream_url.origin() != session.base_url.origin() {
        return plain(StatusCode::FORBIDDEN, "Cross-origin proxy requests are not allowed in this session");
    }

    let (parts, body) = request.into_parts();
    push_event(&session, "http_request", upstream_url.path().to_owned(), parts.method.as_str().to_owned()).await;
    let body = match to_bytes(body, MAX_REQUEST_BODY).await {
        Ok(body) => body,
        Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request body exceeds the 8 MiB limit"),
    };

    if parts.method != Method::GET && parts.method != Method::HEAD && parts.method != Method::OPTIONS {
        wait_for_authorization(&session).await;
    }

    let method = match reqwest::Method::from_bytes(parts.method.as_str().as_bytes()) {
        Ok(method) => method,
        Err(_) => return plain(StatusCode::METHOD_NOT_ALLOWED, "Unsupported HTTP method"),
    };
    let mut builder = session.client.request(method, upstream_url.clone());
    for (name, value) in parts.headers.iter() {
        if should_skip_request_header(name) {
            continue;
        }
        if name == header::ORIGIN {
            if let Ok(origin) = HeaderValue::from_str(&session.base_url.origin().ascii_serialization()) {
                builder = builder.header(name.clone(), origin);
            }
        } else if name == header::REFERER {
            if let Ok(referer) = HeaderValue::from_str(upstream_url.as_str()) {
                builder = builder.header(name.clone(), referer);
            }
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

    let upstream_status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    if let Some(length) = upstream.content_length() {
        if length > MAX_RESPONSE_BODY as u64 {
            return plain(StatusCode::PAYLOAD_TOO_LARGE, "Upstream response exceeds the 32 MiB limit");
        }
    }

    let mut response_body = Vec::new();
    let mut stream = upstream.bytes_stream();
    while let Some(next) = stream.next().await {
        match next {
            Ok(chunk) => {
                if response_body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY {
                    return plain(StatusCode::PAYLOAD_TOO_LARGE, "Upstream response exceeds the 32 MiB limit");
                }
                response_body.extend_from_slice(&chunk);
            }
            Err(error) => {
                warn!(%error, "Failed while reading upstream response");
                return plain(StatusCode::BAD_GATEWAY, "Failed while reading upstream response");
            }
        }
    }

    let content_type = upstream_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut transformed = false;
    if content_type.contains("text/html") {
        if let Ok(html) = std::str::from_utf8(&response_body) {
            match rewrite_html(html, &upstream_url, id) {
                Ok(rewritten) => {
                    response_body = rewritten.into_bytes();
                    transformed = true;
                }
                Err(error) => warn!(%error, "HTML rewrite failed; returning original HTML"),
            }
        }
    }

    let mut response = Response::builder().status(upstream_status);
    let headers = response.headers_mut().expect("fresh response builder");
    for (name, value) in upstream_headers.iter() {
        if should_skip_response_header(name) || name == header::CONTENT_LENGTH || (transformed && name == header::CONTENT_ENCODING) {
            continue;
        }
        if transformed && matches!(name.as_str(), "content-security-policy" | "content-security-policy-report-only" | "x-frame-options" | "etag" | "content-md5" | "digest") {
            // The proxy needs its controller script and fixed toolbar to run in the document.
            continue;
        }
        if name == header::LOCATION {
            if let Ok(location) = value.to_str() {
                let rewritten = rewrite_location(location, &upstream_url, id);
                if let Ok(value) = HeaderValue::from_str(&rewritten) {
                    headers.append(name.clone(), value);
                }
            }
        } else if name == header::SET_COOKIE {
            if let Ok(cookie) = value.to_str() {
                if let Ok(value) = HeaderValue::from_str(&rewrite_set_cookie(cookie, id)) {
                    headers.append(name.clone(), value);
                }
            }
        } else {
            headers.append(name.clone(), value.clone());
        }
    }
    if transformed {
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    }
    response.body(Body::from(response_body)).unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Could not build proxy response"))
}

fn rewrite_html(html: &str, base: &Url, session_id: &str) -> Result<String, String> {
    let mut settings = RewriteStrSettings::new();
    let base_for_attrs = base.clone();
    let id_for_attrs = session_id.to_owned();
    settings = settings.append_element_content_handler(element!(
        "a[href],area[href],link[href],script[src],img[src],source[src],iframe[src],video[src],audio[src],input[src],form[action],button[formaction],base[href]",
        move |el| {
            for attribute in ["href", "src", "action", "formaction", "poster"] {
                if let Some(value) = el.get_attribute(attribute) {
                    if let Some(rewritten) = rewrite_url(&base_for_attrs, &id_for_attrs, &value) {
                        el.set_attribute(attribute, &rewritten)?;
                    }
                }
            }
            Ok(())
        }
    ));

    let id_for_head = session_id.to_owned();
    settings = settings.append_element_content_handler(element!("head", move |el| {
        let head = format!(
            r#"<script src="/assets/controller.js" data-session="{id_for_head}"></script><link rel="stylesheet" href="/assets/intercept.css">"#
        );
        el.prepend(&head, ContentType::Html);
        Ok(())
    }));

    let id_for_body = session_id.to_owned();
    settings = settings.append_element_content_handler(element!("body", move |el| {
        let toolbar = format!(
            r#"<aside id="intercept-toolbar" data-session="{id_for_body}" aria-live="polite">
<div class="intercept-row"><strong>INTERCEPT</strong><span id="intercept-state">Waiting for timer</span>
<label for="intercept-delay">Delay (seconds)</label><input id="intercept-delay" type="number" min="1" max="86400" value="30" inputmode="numeric">
<button id="intercept-start" type="button">[START]</button><span id="intercept-countdown">Not started</span></div>
<div id="intercept-notice">Navigation and form submissions are held until authorization. State-changing HTTP requests are enforced by the Rust proxy.</div>
<details id="intercept-events"><summary id="intercept-events-summary">EVENT STREAM · loading</summary><pre id="intercept-events-list">Waiting for browser and HTTP events…</pre></details>
</aside>"#
        );
        el.append(&toolbar, ContentType::Html);
        Ok(())
    }));

    rewrite_str(html, settings).map_err(|error| error.to_string())
}

fn rewrite_url(base: &Url, session_id: &str, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with("data:")
        || trimmed.starts_with("javascript:")
        || trimmed.starts_with("mailto:")
        || trimmed.starts_with("tel:")
        || trimmed.starts_with("blob:")
    {
        return None;
    }
    let absolute = base.join(trimmed).ok()?;
    if absolute.origin() != base.origin() {
        return None;
    }
    Some(local_url(&absolute, session_id))
}

fn local_url(upstream: &Url, session_id: &str) -> String {
    let mut result = format!("/p/{session_id}{}", upstream.path());
    if let Some(query) = upstream.query() {
        result.push('?');
        result.push_str(query);
    }
    if let Some(fragment) = upstream.fragment() {
        result.push('#');
        result.push_str(fragment);
    }
    result
}

fn rewrite_location(location: &str, current: &Url, session_id: &str) -> String {
    match current.join(location) {
        Ok(url) if url.origin() == current.origin() => local_url(&url, session_id),
        _ => "/".to_owned(),
    }
}

fn rewrite_set_cookie(cookie: &str, session_id: &str) -> String {
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
            let scoped_path = if upstream_path == "/" || upstream_path.is_empty() {
                format!("/p/{session_id}")
            } else {
                format!("/p/{session_id}{}", if upstream_path.starts_with('/') { upstream_path.to_owned() } else { format!("/{upstream_path}") })
            };
            *part = format!("Path={scoped_path}");
            found_path = true;
        }
    }
    if !found_path {
        parts.push(format!("Path=/p/{session_id}"));
    }
    parts.join("; ")
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

fn clean_field(value: String, max: usize) -> String {
    value.chars().filter(|ch| !ch.is_control()).take(max).collect()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
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
    fn rewrites_same_origin_urls_to_local_session_paths() {
        let base = Url::parse("https://example.com/account/").unwrap();
        assert_eq!(
            rewrite_url(&base, "session123", "../settings?tab=security"),
            Some("/p/session123/settings?tab=security".to_owned())
        );
        assert_eq!(
            rewrite_url(&base, "session123", "https://other.example/image.png"),
            None
        );
    }

    #[test]
    fn rewrites_cookie_paths_to_the_session_prefix() {
        assert_eq!(
            rewrite_set_cookie("sid=abc; Domain=example.com; Path=/admin; HttpOnly", "session123"),
            "sid=abc; Path=/p/session123/admin; HttpOnly"
        );
    }

    #[test]
    fn rewrites_html_and_injects_controller_and_toolbar() {
        let base = Url::parse("https://example.com/").unwrap();
        let html = r#"<!doctype html><html><head></head><body><a href="/next">next</a></body></html>"#;
        let result = rewrite_html(html, &base, "session123").unwrap();
        assert!(result.contains("/p/session123/next"));
        assert!(result.contains("/assets/controller.js"));
        assert!(result.contains("intercept-toolbar"));
    }
}
