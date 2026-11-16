use std::{
    collections::{HashMap, VecDeque},
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock, Mutex as StdMutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{Body, to_bytes},
    extract::{OriginalUri, Path, Query, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode,
        header,
    },
    middleware::{self, Next},
    response::{Html, IntoResponse},
    routing::{any, delete, get, post},
    Json, Router,
};
use futures_util::StreamExt;
use lol_html::{RewriteStrSettings, element, html_content::ContentType, rewrite_str};
use regex::Regex;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex, RwLock, Semaphore},
    task::JoinSet,
    time::{sleep_until, Instant},
};
use tracing::{debug, info, warn};
use url::Url;
use uuid::Uuid;

const LISTEN: &str = "127.0.0.1:5000";
const MAX_REQUEST_BODY: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY: usize = 32 * 1024 * 1024;
const MAX_EVENTS: usize = 500;
const MAX_ERROR_BODY_BYTES: usize = 2 * 1024;
const MAX_ERROR_BODY_SAMPLE_MS: u64 = 500;
const MAX_DELAY_SECONDS: u64 = 24 * 60 * 60;
const MIN_DELAY_NANOS: f64 = 0.000_000_001;
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CACHE_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_ASSET_CACHE_SECONDS: u64 = 300;
// Regular document/resource requests buffer and may rewrite the complete body.
// Allow large upstream bundles more than the old 30-second total deadline.
const UPSTREAM_TIMEOUT_SECONDS: u64 = 120;
// Long-lived AJAX streams (notably EventSource) may remain open for hours.
const AJAX_STREAM_TIMEOUT_SECONDS: u64 = 24 * 60 * 60;
const SHUTDOWN_GRACE_SECONDS: u64 = 5;
const DASHBOARD_HOST: &str = "127.0.0.1:5000";
const LOCALHOST_DASHBOARD_HOST: &str = "localhost:5000";
const SESSION_PORT: &str = "5000";
const DEFAULT_MAX_SESSIONS: usize = 8;
const DEFAULT_SESSION_IDLE_SECONDS: u64 = 1800;
const DEFAULT_MAX_INFLIGHT_PER_SESSION: usize = 64;
const MAX_UPSTREAM_ORIGINS_PER_SESSION: usize = 24;
const MAX_CUSTOM_RULES: usize = 100;

static HTML_STYLE_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)(<style\b[^>]*>)(.*?)(</style\s*>)")
        .expect("valid inline style block regex")
});
static HTML_SCRIPT_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)(<script\b[^>]*>)(.*?)(</script\s*>)")
        .expect("valid inline script block regex")
});
static HTML_SCRIPT_NONCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<script\b[^>]*\bnonce\s*=\s*(?:"([^"]+)"|'([^']+)')"#)
        .expect("valid HTML script nonce regex")
});
static HTML_META_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<meta\b[^>]*>")
        .expect("valid HTML meta tag regex")
});
static CSS_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)"#)
        .expect("valid CSS url() regex")
});
static CSS_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)@import\s+(?:"([^"]+)"|'([^']+)')"#)
        .expect("valid CSS @import regex")
});
static JS_STATIC_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)(\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?)(["'])(https?://[^"']+)(["'])"#)
        .expect("valid JavaScript static import regex")
});
static JS_DYNAMIC_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)\bimport\(\s*(["'])(https?://[^"']+)(["'])\s*\)"#)
        .expect("valid JavaScript dynamic import regex")
});

static ERROR_BODY_SCRIPT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<script\b[^>]*>.*?</script\s*>")
        .expect("valid error-body script regex")
});
static ERROR_BODY_STYLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<style\b[^>]*>.*?</style\s*>")
        .expect("valid error-body style regex")
});
static ERROR_BODY_COMMENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<!--.*?-->")
        .expect("valid error-body comment regex")
});
static ERROR_BODY_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<[^>]*>")
        .expect("valid error-body tag regex")
});
static ERROR_BODY_URL_QUERY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)((?:https?://[^?\s"'<>]+|/[^?\s"'<>]+))\?[^\s"'<>]*"#)
        .expect("valid error-body URL query regex")
});
static ERROR_BODY_SECRET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)["']?(cookie|set-cookie|authorization|proxy-authorization|csrf|xsrf|access[_-]?token|refresh[_-]?token|id[_-]?token|token|session(?:[_-]?id)?|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)"#)
        .expect("valid error-body secret regex")
});
static ERROR_BODY_BEARER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+./=-]+")
        .expect("valid error-body bearer regex")
});

#[derive(Clone)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
    rewrite_slots: Arc<Semaphore>,
    max_sessions: usize,
    session_idle_timeout: Duration,
    max_inflight_per_session: usize,
}

struct Session {
    id: String,
    base_url: Url,
    clients: Mutex<HashMap<String, reqwest::Client>>,
    cache: Mutex<ResourceCache>,
    gate: Mutex<GateState>,
    gate_tx: watch::Sender<GateState>,
    cancel_tx: watch::Sender<bool>,
    cancelled: AtomicBool,
    events: Mutex<VecDeque<ActionEvent>>,
    policy: AuthorizationPolicy,
    rules: Vec<AuthorizationRule>,
    bootstrap_pending: AtomicBool,
    last_accessed_ms: AtomicU64,
    start_delay_nanos: AtomicU64,
    inflight: Arc<Semaphore>,
    max_inflight: usize,
    cookie_jar: Arc<SessionCookieJar>,
    cookie_tokens: StdMutex<HashMap<String, String>>,
}

#[derive(Default)]
struct SessionCookieJar {
    store: StdMutex<cookie_store::CookieStore>,
}

impl SessionCookieJar {
    fn lock(&self) -> std::sync::MutexGuard<'_, cookie_store::CookieStore> {
        self.store.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn request_cookie_header(&self, url: &Url) -> Option<HeaderValue> {
        let store = self.lock();
        let value = store.get_request_values(url)
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        if value.is_empty() { None } else { HeaderValue::from_str(&value).ok() }
    }

    fn document_cookie_header(&self, url: &Url) -> String {
        let store = self.lock();
        store.matches(url).into_iter()
            .filter(|cookie| cookie.http_only() != Some(true))
            .map(|cookie| {
                let (name, value) = cookie.name_value();
                format!("{name}={value}")
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn set_document_cookie(&self, cookie: &str, url: &Url) -> Result<(), String> {
        if cookie.is_empty() || cookie.len() > 4096 {
            return Err("Cookie assignment must contain 1–4096 bytes".into());
        }
        if cookie.split(';').skip(1).any(|part| part.trim().eq_ignore_ascii_case("httponly")) {
            return Err("JavaScript cannot set HttpOnly cookies".into());
        }
        validate_cookie_prefix(cookie, url)?;
        match self.lock().parse(cookie, url) {
            Ok(_) => Ok(()),
            Err(cookie_store::CookieError::DomainMismatch) => {
                // Browsers silently ignore document.cookie assignments whose
                // Domain attribute does not match the current document host.
                // Treat this as a successful no-op so the bridge can return
                // the authoritative cookie mirror instead of surfacing a 400.
                debug!(
                    host = url.host_str().unwrap_or_default(),
                    "Ignored document cookie assignment with a non-matching Domain attribute"
                );
                Ok(())
            }
            Err(cookie_store::CookieError::Expired) => {
                // Expiring a cookie that is not currently stored is also a
                // normal no-op for document.cookie. Existing matching cookies
                // are expired by CookieStore and arrive through the Ok branch.
                debug!(
                    host = url.host_str().unwrap_or_default(),
                    "Ignored deletion of an expired or absent document cookie"
                );
                Ok(())
            }
            Err(error) => Err(format!("Cookie rejected: {error}")),
        }
    }
}

impl reqwest::cookie::CookieStore for SessionCookieJar {
    fn set_cookies(&self, cookie_headers: &mut dyn Iterator<Item = &HeaderValue>, url: &Url) {
        let mut store = self.lock();
        for header in cookie_headers {
            let Ok(cookie) = header.to_str() else { continue };
            if validate_cookie_prefix(cookie, url).is_ok() {
                if let Err(error) = store.parse(cookie, url) {
                    debug!(%error, host = url.host_str().unwrap_or_default(), "Upstream Set-Cookie was rejected");
                }
            }
        }
    }

    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        self.request_cookie_header(url)
    }
}

fn validate_cookie_prefix(cookie: &str, url: &Url) -> Result<(), String> {
    let mut parts = cookie.split(';');
    let pair = parts.next().unwrap_or_default().trim();
    let name = pair.split_once('=').map(|(name, _)| name.trim()).unwrap_or_default();
    if name.is_empty() { return Err("Cookie name is missing".into()); }
    let attrs = parts.map(str::trim).collect::<Vec<_>>();
    let secure = attrs.iter().any(|attr| attr.eq_ignore_ascii_case("secure"));
    let domain = attrs.iter().any(|attr| attr.to_ascii_lowercase().starts_with("domain="));
    let path = attrs.iter().find_map(|attr| {
        attr.split_once('=').filter(|(name, _)| name.trim().eq_ignore_ascii_case("path"))
            .map(|(_, value)| value.trim())
    });
    let same_site_none = attrs.iter().any(|attr| attr.split_once('=').is_some_and(|(name, value)| {
        name.trim().eq_ignore_ascii_case("samesite") && value.trim().eq_ignore_ascii_case("none")
    }));
    if (name.starts_with("__Secure-") || name.starts_with("__Host-"))
        && (url.scheme() != "https" || !secure)
    {
        return Err("Secure cookie prefixes require HTTPS and the Secure attribute".into());
    }
    if name.starts_with("__Host-") && (domain || path != Some("/")) {
        return Err("__Host- cookies require Path=/ and must not specify Domain".into());
    }
    if same_site_none && !secure {
        return Err("SameSite=None cookies must also be Secure".into());
    }
    Ok(())
}

#[derive(Default)]
struct ResourceCache {
    entries: HashMap<String, CachedResponse>,
    bytes: usize,
}

#[derive(Clone)]
struct CachedResponse {
    id: String,
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
    policy: Option<AuthorizationPolicy>,
    #[serde(default)]
    rules: Vec<AuthorizationRule>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AuthorizationPolicy {
    #[default]
    Standard,
    Strict,
    Custom,
}

#[derive(Clone, Debug, Deserialize)]
struct AuthorizationRule {
    host: Option<String>,
    path_prefix: String,
    #[serde(default)]
    methods: Vec<String>,
    hold: bool,
}

#[derive(Debug, Serialize)]
struct SessionMetrics {
    policy: &'static str,
    cached_bytes: usize,
    upstream_origins: usize,
    active_requests: usize,
    max_inflight_requests: usize,
    last_activity_ago_ms: u64,
}

#[derive(Debug, Serialize)]
struct CacheBrowserResponse {
    session_id: String,
    cached_bytes: usize,
    max_cache_bytes: usize,
    entries: Vec<CacheFileSummary>,
}

#[derive(Debug, Serialize)]
struct CacheFileSummary {
    id: String,
    virtual_path: String,
    file_name: String,
    url: String,
    content_type: String,
    size_bytes: usize,
    status: u16,
    expires_in_ms: u64,
}

#[derive(Debug, Deserialize)]
struct CacheContentQuery {
    file_id: String,
}

#[derive(Debug, Deserialize)]
struct CookieBridgeQuery {
    target: String,
}

#[derive(Debug, Deserialize)]
struct CookieBridgeWrite {
    target: String,
    cookie: String,
}

#[derive(Debug, Serialize)]
struct CookieBridgeResponse {
    cookie: String,
}

struct ProxyRequestContext {
    request_id: String,
    started_at: Instant,
    permit: tokio::sync::OwnedSemaphorePermit,
}

#[derive(Debug, Serialize)]
struct CreateSessionResponse {
    id: String,
    session_url: String,
}

#[derive(Debug, Serialize)]
struct SessionsResponse {
    active_sessions: usize,
    max_sessions: usize,
    sessions: Vec<SessionSummary>,
}

#[derive(Debug, Serialize)]
struct SessionSummary {
    id: String,
    target_url: String,
    session_url: String,
    policy: &'static str,
    state: &'static str,
}

#[derive(Debug, Deserialize)]
struct StartTimer {
    delay_seconds: f64,
}

#[derive(Debug, Deserialize)]
struct EventInput {
    kind: String,
    target: Option<String>,
    detail: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct UpstreamErrorBody {
    text: String,
    captured_bytes: usize,
    truncated: bool,
    complete: bool,
    timed_out: bool,
}

#[derive(Debug, Serialize, Clone)]
struct ActionEvent {
    at_unix_ms: u128,
    kind: String,
    target: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_error_body: Option<UpstreamErrorBody>,
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

    let rewrite_workers = std::env::var("INTERCEPT_REWRITE_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(2)
        });
    let max_sessions = env_usize("INTERCEPT_MAX_SESSIONS", DEFAULT_MAX_SESSIONS, 1, 256);
    let session_idle_timeout = Duration::from_secs(env_u64(
        "INTERCEPT_SESSION_IDLE_SECONDS",
        DEFAULT_SESSION_IDLE_SECONDS,
        60,
        86_400,
    ));
    let max_inflight_per_session = env_usize(
        "INTERCEPT_MAX_INFLIGHT_PER_SESSION",
        DEFAULT_MAX_INFLIGHT_PER_SESSION,
        1,
        512,
    );
    info!(rewrite_workers, max_sessions, session_idle_seconds = session_idle_timeout.as_secs(),
        max_inflight_per_session, "Proxy resource limits configured");

    let state = AppState {
        sessions: Arc::new(RwLock::new(HashMap::new())),
        rewrite_slots: Arc::new(Semaphore::new(rewrite_workers)),
        max_sessions,
        session_idle_timeout,
        max_inflight_per_session,
    };
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        loop {
            ticker.tick().await;
            prune_sessions(&cleanup_state).await;
        }
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/authority/{id}", get(authority_page))
        .route("/assets/controller.js", get(controller_js))
        .route("/assets/intercept.css", get(intercept_css))
        .route("/assets/authority.js", get(authority_js))
        .route("/_intercept/events", post(record_session_events))
        .route("/_intercept/cookies", get(cookie_bridge_get).post(cookie_bridge_set))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/{id}", delete(delete_session).options(api_preflight))
        .route("/api/sessions/{id}/start", post(start_timer).options(api_preflight))
        .route("/api/sessions/{id}/status", get(session_status).options(api_preflight))
        .route("/api/sessions/{id}/events", get(get_events).post(record_events).options(api_preflight))
        .route("/api/sessions/{id}/metrics", get(session_metrics).options(api_preflight))
        .route("/api/sessions/{id}/cache", get(session_cache_browser).options(api_preflight))
        .route("/api/sessions/{id}/cache/content", get(session_cache_content).options(api_preflight))
        .route("/p/{id}", any(proxy))
        .route("/p/{id}/", any(proxy))
        .route("/p/{id}/{*path}", any(proxy))
        .fallback(proxy_session_origin)
        .layer(middleware::from_fn_with_state(state.clone(), host_and_cors_guard))
        .with_state(state.clone());

    // Serve both loopback address families. Browsers may resolve "localhost"
    // to ::1 first, while the canonical dashboard address remains 127.0.0.1.
    // Binding only one family can make the localhost alias fail intermittently.
    let address: SocketAddr = LISTEN.parse()?;
    let mut listeners = vec![TcpListener::bind(address).await?];
    match TcpListener::bind("[::1]:5000").await {
        Ok(listener) => listeners.push(listener),
        Err(error) => warn!(
            %error,
            "IPv6 loopback listener unavailable; localhost must resolve to IPv4"
        ),
    }
    for listener in &listeners {
        info!(address = %listener.local_addr()?, "Intercept loopback listener bound");
    }
    info!("Dashboard available at http://127.0.0.1:5000 and http://localhost:5000");
    info!("Session pages use per-session origins such as http://<session-id>.localhost:5000.");
    info!("The listener is loopback-only; this is not a network-wide transparent proxy.");

    let (shutdown_tx, _) = watch::channel(false);
    let mut servers = JoinSet::new();
    for listener in listeners {
        let app = app.clone();
        let mut shutdown_rx = shutdown_tx.subscribe();
        servers.spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.wait_for(|shutdown| *shutdown).await;
                })
                .await
        });
    }

    tokio::select! {
        result = servers.join_next() => match result {
            Some(Ok(Ok(()))) => return Err(Box::<dyn std::error::Error>::from(
                io::Error::other("An Intercept loopback listener stopped unexpectedly"),
            )),
            Some(Ok(Err(error))) => {
                return Err(Box::<dyn std::error::Error>::from(error));
            }
            Some(Err(error)) => {
                return Err(Box::<dyn std::error::Error>::from(io::Error::other(error)));
            }
            None => return Err(Box::<dyn std::error::Error>::from(
                io::Error::other("All Intercept loopback listeners stopped unexpectedly"),
            )),
        },
        signal = tokio::signal::ctrl_c() => {
            signal?;
            info!(
                grace_seconds = SHUTDOWN_GRACE_SECONDS,
                "Shutdown signal received; draining active requests"
            );
            shutdown_tx.send_replace(true);
            let drain_servers = async {
                while let Some(result) = servers.join_next().await {
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => return Err(error),
                        Err(error) => return Err(io::Error::other(error)),
                    }
                }
                Ok::<(), io::Error>(())
            };
            match tokio::time::timeout(
                Duration::from_secs(SHUTDOWN_GRACE_SECONDS),
                drain_servers,
            ).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return Err(Box::<dyn std::error::Error>::from(error)),
                Err(_) => warn!(
                    grace_seconds = SHUTDOWN_GRACE_SECONDS,
                    "Graceful shutdown timed out; forcing process shutdown"
                ),
            }
        }
    }
    Ok(())
}

async fn api_preflight() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn authority_page(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response<Body>, (StatusCode, String)> {
    find_session(&state, &id).await?;
    let page = include_str!("../web/authority.html").replace("__SESSION_ID__", &id);
    let mut response = Html(page).into_response();
    let headers = response.headers_mut();
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("cross-origin"),
    );
    // A cross-origin child navigable must itself opt into a COEP policy
    // compatible with the embedding document's require-corp/credentialless
    // policy. All resources used by this local authority page are same-origin.
    headers.insert(
        "cross-origin-embedder-policy",
        HeaderValue::from_static("require-corp"),
    );
    // The proxy page embeds this trusted dashboard-origin frame. CORP permits
    // the COEP-protected parent to load it, while frame-ancestors restricts
    // embedding to this session's own origin.
    let frame_ancestors = format!("frame-ancestors {}", proxy_origin(&id));
    if let Ok(value) = HeaderValue::from_str(&frame_ancestors) {
        headers.insert(header::CONTENT_SECURITY_POLICY, value);
    }
    Ok(response)
}

async fn authority_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../web/authority.js"),
    )
}

async fn cookie_bridge_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<CookieBridgeQuery>,
) -> Result<Json<CookieBridgeResponse>, (StatusCode, String)> {
    let id = session_id_from_host(&headers)?;
    let session = find_session(&state, &id).await?;
    let capability_origin = cookie_bridge_capability_origin(&session, &headers)?;
    let upstream_url = cookie_bridge_target(&input.target, &session, &capability_origin)?;
    Ok(Json(CookieBridgeResponse {
        cookie: session.cookie_jar.document_cookie_header(&upstream_url),
    }))
}

async fn cookie_bridge_set(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CookieBridgeWrite>,
) -> Result<Json<CookieBridgeResponse>, (StatusCode, String)> {
    let id = session_id_from_host(&headers)?;
    let session = find_session(&state, &id).await?;
    let capability_origin = cookie_bridge_capability_origin(&session, &headers)?;
    let upstream_url = cookie_bridge_target(&input.target, &session, &capability_origin)
        .map_err(|(status, message)| {
            // Never log the query string or cookie assignment; the path and
            // validation reason are sufficient to diagnose malformed targets.
            warn!(
                status = %status,
                target_path = %input.target.split('?').next().unwrap_or(""),
                reason = %message,
                "Cookie bridge target rejected"
            );
            (status, message)
        })?;
    session.cookie_jar.set_document_cookie(&input.cookie, &upstream_url)
        .map_err(|message| {
            warn!(
                upstream_host = upstream_url.host_str().unwrap_or_default(),
                cookie_bytes = input.cookie.len(),
                reason = %message,
                "Document cookie assignment rejected"
            );
            (StatusCode::BAD_REQUEST, message)
        })?;
    Ok(Json(CookieBridgeResponse {
        cookie: session.cookie_jar.document_cookie_header(&upstream_url),
    }))
}

fn session_id_from_host(headers: &HeaderMap) -> Result<String, (StatusCode, String)> {
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or("");
    let id = host.strip_suffix(&format!(".localhost:{SESSION_PORT}"))
        .ok_or((StatusCode::MISDIRECTED_REQUEST, "Request must use its dedicated session hostname".into()))?;
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err((StatusCode::NOT_FOUND, "Unknown or expired session".into()));
    }
    Ok(id.to_owned())
}

fn cookie_bridge_capability_origin(
    session: &Session,
    headers: &HeaderMap,
) -> Result<Url, (StatusCode, String)> {
    let token = headers.get("x-intercept-cookie-token")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or((StatusCode::FORBIDDEN, "Cookie bridge capability is missing or invalid".into()))?;
    let allowed_origin = session.cookie_tokens.lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(token)
        .cloned()
        .ok_or((StatusCode::FORBIDDEN, "Cookie bridge capability has expired".into()))?;
    let origin = Url::parse(&allowed_origin)
        .map_err(|_| (StatusCode::FORBIDDEN, "Cookie bridge capability contains an invalid origin".into()))?;
    if !matches!(origin.scheme(), "http" | "https")
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !is_public_destination(&origin)
    {
        return Err((StatusCode::FORBIDDEN, "Cookie bridge capability contains an invalid upstream origin".into()));
    }
    Ok(origin)
}

fn cookie_bridge_target(
    target: &str,
    session: &Session,
    capability_origin: &Url,
) -> Result<Url, (StatusCode, String)> {
    if target.len() > 8192 || !target.starts_with('/') || target.starts_with("//") {
        return Err((StatusCode::BAD_REQUEST, "Cookie bridge target must be a local session path".into()));
    }
    let uri = target.parse::<axum::http::Uri>()
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid cookie bridge target path".into()))?;

    // Secondary origins are represented by an explicit /_/https/{host}/...
    // route. Resolve those through the normal proxy parser and require that
    // the document capability names that exact origin.
    let session_prefix = format!("/p/{}", session.id);
    let routed_path = uri.path().strip_prefix(&session_prefix).unwrap_or(uri.path());
    let is_encoded_origin = routed_path == "/_" || routed_path.starts_with("/_/");
    let mut upstream_url = if is_encoded_origin {
        let resolved = upstream_url_for_request(&uri, session)
            .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
        if resolved.origin() != capability_origin.origin() {
            return Err((StatusCode::FORBIDDEN, "A document may only access cookies for its own upstream origin".into()));
        }
        resolved
    } else {
        // Root-relative paths belong to the origin that issued this document's
        // token, not necessarily the session's original URL host. This matters
        // after redirects or canonical-host changes (for example youtube.com
        // to www.youtube.com).
        let mut resolved = capability_origin.clone();
        resolved.set_path(uri.path());
        resolved.set_query(uri.query());
        resolved
    };

    upstream_url.set_fragment(None);
    if !is_public_destination(&upstream_url) {
        return Err((StatusCode::FORBIDDEN, "Cookie bridge target is not a public upstream URL".into()));
    }
    Ok(upstream_url)
}

async fn record_session_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(inputs): Json<Vec<EventInput>>,
) -> Result<StatusCode, (StatusCode, String)> {
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or("");
    let suffix = format!(".localhost:{SESSION_PORT}");
    let id = host.strip_suffix(&suffix)
        .ok_or((StatusCode::MISDIRECTED_REQUEST, "Event telemetry requires the session origin".into()))?;
    let session = find_session(&state, id).await?;
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

fn dashboard_origin_for_host(host: &str) -> Option<&'static str> {
    if host.eq_ignore_ascii_case(DASHBOARD_HOST) {
        Some("http://127.0.0.1:5000")
    } else if host.eq_ignore_ascii_case(LOCALHOST_DASHBOARD_HOST) {
        Some("http://localhost:5000")
    } else {
        None
    }
}

fn is_dashboard_host(host: &str) -> bool {
    dashboard_origin_for_host(host).is_some()
}

fn dashboard_origin_matches_host(host: &str, origin: &str) -> bool {
    dashboard_origin_for_host(host)
        .is_some_and(|expected| origin.eq_ignore_ascii_case(expected))
}

async fn host_and_cors_guard(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    let path = request.uri().path();
    let host = request.headers().get(header::HOST)
        .and_then(|value| value.to_str().ok()).unwrap_or("");

    // The dashboard and control API accept either loopback alias, but an
    // Origin-bearing request must use the same alias as its Host header.
    // Proxied pages continue to use their unique <session>.localhost origin.
    if (path == "/" && is_dashboard_host(host))
        || path == "/api/sessions"
        || path.starts_with("/api/sessions/") {
        if !is_dashboard_host(host) {
            return plain(
                StatusCode::MISDIRECTED_REQUEST,
                "Use http://127.0.0.1:5000 or http://localhost:5000",
            );
        }
        if let Some(origin_header) = request.headers().get(header::ORIGIN) {
            let Ok(origin) = origin_header.to_str() else {
                return plain(StatusCode::FORBIDDEN, "Invalid Origin for the trusted control API");
            };
            if !dashboard_origin_matches_host(host, origin) {
                return plain(StatusCode::FORBIDDEN, "Cross-origin access to the trusted control API is denied");
            }
        }
        return next.run(request).await;
    }

    if let Some(rest) = path.strip_prefix("/p/") {
        let id = rest.split('/').next().unwrap_or("");
        let expected_host = format!("{id}.localhost:{SESSION_PORT}");
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !host.eq_ignore_ascii_case(&expected_host)
        {
            return plain(StatusCode::MISDIRECTED_REQUEST, "Session requests must use their dedicated localhost origin");
        }
        if state.sessions.read().await.get(id).is_none() {
            return plain(StatusCode::NOT_FOUND, "Unknown or expired session");
        }
        return next.run(request).await;
    }

    if path == "/assets/controller.js" || path == "/assets/intercept.css" {
        let Some(id) = host.strip_suffix(&format!(".localhost:{SESSION_PORT}")) else {
            return plain(StatusCode::MISDIRECTED_REQUEST, "Session assets require a dedicated session origin");
        };
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || state.sessions.read().await.get(id).is_none()
        {
            return plain(StatusCode::NOT_FOUND, "Unknown or expired session");
        }
        return next.run(request).await;
    }

    if path == "/_intercept/events" || path == "/_intercept/cookies" {
        let Some(id) = host.strip_suffix(&format!(".localhost:{SESSION_PORT}")) else {
            return plain(StatusCode::MISDIRECTED_REQUEST, "Session bridge endpoints require a session origin");
        };
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || state.sessions.read().await.get(id).is_none()
        {
            return plain(StatusCode::NOT_FOUND, "Unknown or expired session");
        }
        if path == "/_intercept/cookies" && request.method() == Method::POST {
            let expected_origin = format!("http://{id}.localhost:{SESSION_PORT}");
            if request.headers().get(header::ORIGIN).and_then(|value| value.to_str().ok())
                .is_some_and(|origin| !origin.eq_ignore_ascii_case(&expected_origin))
            {
                return plain(StatusCode::FORBIDDEN, "Cookie bridge writes must originate from this session");
            }
        }
        return next.run(request).await;
    }

    if path == "/assets/authority.js" || path.starts_with("/authority/") {
        if !is_dashboard_host(host) {
            return plain(StatusCode::MISDIRECTED_REQUEST, "Authority resources are served only from a trusted dashboard origin");
        }
        return next.run(request).await;
    }

    if let Some(id) = host.strip_suffix(&format!(".localhost:{SESSION_PORT}")) {
        if id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
            && state.sessions.read().await.contains_key(id)
        {
            return next.run(request).await;
        }
    }
    if !is_dashboard_host(host) {
        return plain(StatusCode::MISDIRECTED_REQUEST, "Unknown host for this local service");
    }
    next.run(request).await
}

async fn index(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    request: Request<Body>,
) -> Response<Body> {
    let host = request.headers().get(header::HOST)
        .and_then(|value| value.to_str().ok()).unwrap_or("");
    if is_dashboard_host(host) {
        return Html(include_str!("../web/index.html")).into_response();
    }
    proxy_session_origin(State(state), OriginalUri(uri), request).await
}

async fn proxy_session_origin(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    request: Request<Body>,
) -> Response<Body> {
    let host = request.headers().get(header::HOST)
        .and_then(|value| value.to_str().ok()).unwrap_or("");
    let Some(id) = host.strip_suffix(&format!(".localhost:{SESSION_PORT}")) else {
        return plain(StatusCode::NOT_FOUND, "No proxy route matches this URL");
    };
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return plain(StatusCode::NOT_FOUND, "No proxy route matches this URL");
    }
    let mut params = HashMap::new();
    params.insert("id".to_owned(), id.to_owned());
    proxy(State(state), Path(params), OriginalUri(uri), request).await
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

async fn list_sessions(State(state): State<AppState>) -> Json<SessionsResponse> {
    let sessions = state.sessions.read().await.values().cloned().collect::<Vec<_>>();
    let active_sessions = sessions.len();
    let mut summaries = Vec::with_capacity(active_sessions);

    for session in sessions {
        let gate = *session.gate.lock().await;
        let state_label = match gate {
            GateState::Waiting => "WAITING",
            GateState::Running { .. } => "COUNTDOWN",
            GateState::Released => "AUTHORIZED",
        };
        let policy_label = match session.policy {
            AuthorizationPolicy::Standard => "standard",
            AuthorizationPolicy::Strict => "strict",
            AuthorizationPolicy::Custom => "custom",
        };
        summaries.push(SessionSummary {
            id: session.id.clone(),
            target_url: session.base_url.to_string(),
            session_url: local_url(&session.base_url, &session.id),
            policy: policy_label,
            state: state_label,
        });
    }

    summaries.sort_by(|left, right| left.target_url.cmp(&right.target_url));
    Json(SessionsResponse {
        active_sessions,
        max_sessions: state.max_sessions,
        sessions: summaries,
    })
}

async fn delete_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err((StatusCode::BAD_REQUEST, "Invalid session id".into()));
    }

    let session = state.sessions.write().await.remove(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown or expired session".into()))?;

    // Revoke the session before releasing its retained clients and cache.
    // Existing requests observe the cancellation signal and stop forwarding.
    session.cancelled.store(true, Ordering::Release);
    session.cancel_tx.send_replace(true);

    let active_requests = session.max_inflight
        .saturating_sub(session.inflight.available_permits());
    session.clients.lock().await.clear();
    let mut cache = session.cache.lock().await;
    cache.entries.clear();
    cache.bytes = 0;
    drop(cache);

    info!(
        session = %id,
        active_requests,
        "Live proxy session terminated"
    );
    Ok(StatusCode::NO_CONTENT)
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

    let policy = input.policy.unwrap_or_else(|| {
        std::env::var("INTERCEPT_AUTH_POLICY")
            .ok()
            .and_then(|value| match value.to_ascii_lowercase().as_str() {
                "strict" => Some(AuthorizationPolicy::Strict),
                "custom" => Some(AuthorizationPolicy::Custom),
                "standard" => Some(AuthorizationPolicy::Standard),
                _ => None,
            })
            .unwrap_or_default()
    });
    validate_authorization_rules(&input.rules)?;
    if policy == AuthorizationPolicy::Custom && input.rules.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Custom policy requires at least one authorization rule".into()));
    }
    prune_sessions(&state).await;
    let cookie_jar = Arc::new(SessionCookieJar::default());
    let client = build_pinned_client(&target, Arc::clone(&cookie_jar)).await?;

    let id = Uuid::new_v4().simple().to_string();
    let mut clients = HashMap::new();
    clients.insert(origin_key(&target), client);
    let (gate_tx, _) = watch::channel(GateState::Waiting);
    let (cancel_tx, _) = watch::channel(false);
    let session = Arc::new(Session {
        id: id.clone(),
        base_url: target,
        clients: Mutex::new(clients),
        cache: Mutex::new(ResourceCache::default()),
        gate: Mutex::new(GateState::Waiting),
        gate_tx,
        cancel_tx,
        cancelled: AtomicBool::new(false),
        events: Mutex::new(VecDeque::new()),
        policy,
        rules: input.rules,
        bootstrap_pending: AtomicBool::new(true),
        last_accessed_ms: AtomicU64::new(now_ms() as u64),
        start_delay_nanos: AtomicU64::new(0),
        inflight: Arc::new(Semaphore::new(state.max_inflight_per_session)),
        max_inflight: state.max_inflight_per_session,
        cookie_jar,
        cookie_tokens: StdMutex::new(HashMap::new()),
    });

    // Preserve the submitted destination path, query, and browser-side fragment
    // in the local session URL. The upstream origin remains pinned in base_url.
    let session_url = local_url(&session.base_url, &id);
    let mut sessions = state.sessions.write().await;
    if sessions.len() >= state.max_sessions {
        return Err((StatusCode::TOO_MANY_REQUESTS, "Maximum active session count reached; wait for an idle session to expire".into()));
    }
    sessions.insert(id.clone(), session);
    drop(sessions);
    Ok(Json(CreateSessionResponse {
        id: id.clone(),
        session_url,
    }))
}


fn env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    std::env::var(name).ok().and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default).clamp(min, max)
}

fn env_u64(name: &str, default: u64, min: u64, max: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default).clamp(min, max)
}

async fn prune_sessions(state: &AppState) {
    let now = now_ms() as u64;
    let idle_limit = state.session_idle_timeout.as_millis() as u64;
    let mut sessions = state.sessions.write().await;
    let before = sessions.len();
    sessions.retain(|_, session| {
        let keep = now.saturating_sub(session.last_accessed_ms.load(Ordering::Relaxed)) < idle_limit
            || session.inflight.available_permits() < session.max_inflight;
        if !keep {
            session.cancelled.store(true, Ordering::Release);
            session.cancel_tx.send_replace(true);
        }
        keep
    });
    let expired = before.saturating_sub(sessions.len());
    if expired > 0 {
        info!(expired, active = sessions.len(), "Expired idle proxy sessions");
    }
}

fn validate_authorization_rules(rules: &[AuthorizationRule]) -> Result<(), (StatusCode, String)> {
    if rules.len() > MAX_CUSTOM_RULES {
        return Err((StatusCode::BAD_REQUEST, format!("At most {MAX_CUSTOM_RULES} custom authorization rules are allowed")));
    }
    for rule in rules {
        if !rule.path_prefix.starts_with('/') || rule.path_prefix.len() > 512 {
            return Err((StatusCode::BAD_REQUEST, "Each authorization rule needs a path_prefix beginning with / and no longer than 512 characters".into()));
        }
        if rule.host.as_ref().is_some_and(|host| host.is_empty() || host.len() > 253 || host.chars().any(char::is_whitespace)) {
            return Err((StatusCode::BAD_REQUEST, "Authorization rule host values must be valid host names".into()));
        }
        for method in &rule.methods {
            if Method::from_bytes(method.to_ascii_uppercase().as_bytes()).is_err() {
                return Err((StatusCode::BAD_REQUEST, format!("Invalid HTTP method in authorization rule: {method}")));
            }
        }
    }
    Ok(())
}

fn is_known_read_only_post(target: &Url) -> bool {
    let Some(host) = target.host_str() else {
        return false;
    };
    let youtube_host = matches!(
        host.to_ascii_lowercase().as_str(),
        "youtube.com"
            | "www.youtube.com"
            | "m.youtube.com"
            | "music.youtube.com"
            | "youtubei.googleapis.com"
    );
    youtube_host && matches!(
        target.path(),
        "/youtubei/v1/complete" | "/youtubei/v1/search"
    )
}

fn should_hold_request(session: &Session, method: &Method, target: &Url, bootstrap_document: bool) -> bool {
    let standard = method != Method::GET
        && method != Method::HEAD
        && method != Method::OPTIONS
        && !(method == Method::POST && is_known_read_only_post(target));
    match session.policy {
        AuthorizationPolicy::Standard => standard,
        AuthorizationPolicy::Strict => !(bootstrap_document && method == Method::GET),
        AuthorizationPolicy::Custom => session.rules.iter().find(|rule| {
            let host_matches = rule.host.as_ref().is_none_or(|host| target.host_str()
                .is_some_and(|actual| actual.eq_ignore_ascii_case(host)));
            let method_matches = rule.methods.is_empty() || rule.methods.iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(method.as_str()));
            host_matches && method_matches && target.path().starts_with(&rule.path_prefix)
        }).map(|rule| rule.hold).unwrap_or(standard),
    }
}

fn origin_key(url: &Url) -> String {
    url.origin().ascii_serialization()
}

async fn build_pinned_client(target: &Url, cookie_jar: Arc<SessionCookieJar>) -> Result<reqwest::Client, (StatusCode, String)> {
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

    debug!(host = %host, resolved_addresses = addresses.len(), "Upstream DNS resolution completed");
    let mut builder = reqwest::Client::builder()
        .http1_only()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(UPSTREAM_TIMEOUT_SECONDS))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(16)
        .cookie_provider(cookie_jar)
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

    // Do not hold the session-wide map lock while DNS resolution and client
    // construction await network/runtime work. Different origins can initialize
    // their clients concurrently.
    if let Some(client) = session.clients.lock().await.get(&key).cloned() {
        return Ok(client);
    }

    let client = build_pinned_client(target, Arc::clone(&session.cookie_jar)).await?;
    let mut clients = session.clients.lock().await;

    // Reuse a client another concurrent request may have initialized.
    if let Some(existing) = clients.get(&key) {
        return Ok(existing.clone());
    }
    if clients.len() >= MAX_UPSTREAM_ORIGINS_PER_SESSION {
        return Err((StatusCode::TOO_MANY_REQUESTS, "Session upstream-origin limit reached".into()));
    }
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
    let should_spawn = {
        let mut gate = session.gate.lock().await;
        match *gate {
            GateState::Waiting => {
                session.start_delay_nanos.store(duration.as_nanos() as u64, Ordering::Release);
                *gate = GateState::Running { deadline };
                session.gate_tx.send_replace(*gate);
                true
            }
            GateState::Running { .. } | GateState::Released => {
                // Retry the original request without changing the original deadline.
                if session.start_delay_nanos.load(Ordering::Acquire) == duration.as_nanos() as u64 {
                    false
                } else {
                    return Err((StatusCode::CONFLICT, "The timer has already been started with a different delay".into()));
                }
            }
        }
    };
    if !should_spawn {
        return Ok(Json(status_for(&session).await));
    }

    push_event(
        &session,
        "timer_started",
        "authority".to_owned(),
        format!("{:.9} seconds", duration.as_secs_f64()),
    ).await;
    info!(session = %session.id, delay_ms = duration.as_millis(), "Authorization timer started");

    let timer_session = Arc::clone(&session);
    tokio::spawn(async move {
        let mut cancellation = timer_session.cancel_tx.subscribe();
        let already_cancelled = *cancellation.borrow_and_update();
        if already_cancelled {
            return;
        }
        tokio::select! {
            biased;
            _ = wait_for_cancellation(&mut cancellation) => return,
            _ = sleep_until(deadline) => {}
        }
        let mut gate = timer_session.gate.lock().await;
        if matches!(*gate, GateState::Running { .. }) {
            *gate = GateState::Released;
            drop(gate);
            timer_session.gate_tx.send_replace(GateState::Released);
            push_event(
                &timer_session,
                "authorization_released",
                "authority".to_owned(),
                "Timer completed; state-changing requests are now authorized".to_owned(),
            ).await;
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

async fn session_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SessionMetrics>, (StatusCode, String)> {
    let session = state.sessions.read().await.get(&id).cloned()
        .ok_or((StatusCode::NOT_FOUND, "Unknown or expired session".into()))?;
    let cached_bytes = session.cache.lock().await.bytes;
    let upstream_origins = session.clients.lock().await.len();
    let last_accessed = session.last_accessed_ms.load(Ordering::Relaxed);
    let policy = match session.policy {
        AuthorizationPolicy::Standard => "standard",
        AuthorizationPolicy::Strict => "strict",
        AuthorizationPolicy::Custom => "custom",
    };
    Ok(Json(SessionMetrics {
        policy,
        cached_bytes,
        upstream_origins,
        active_requests: session.max_inflight.saturating_sub(session.inflight.available_permits()),
        max_inflight_requests: session.max_inflight,
        last_activity_ago_ms: (now_ms() as u64).saturating_sub(last_accessed),
    }))
}

async fn session_cache_browser(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CacheBrowserResponse>, (StatusCode, String)> {
    let session = find_session(&state, &id).await?;
    let now = Instant::now();
    let mut cache = session.cache.lock().await;

    // Expired entries should not appear in the browser and must not count
    // against the session's live cache budget.
    cache.entries.retain(|_, entry| entry.expires_at > now);
    cache.bytes = cache.entries.values().map(|entry| entry.body.len()).sum();

    let mut entries = cache.entries.iter().filter_map(|(key, entry)| {
        let url = key.split('\n').next()?;
        let parsed = Url::parse(url).ok()?;
        let (virtual_path, file_name) = cache_virtual_path(&parsed);
        let content_type = entry.headers.get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        Some(CacheFileSummary {
            id: entry.id.clone(),
            virtual_path,
            file_name,
            url: url.to_owned(),
            content_type,
            size_bytes: entry.body.len(),
            status: entry.status.as_u16(),
            expires_in_ms: entry.expires_at.saturating_duration_since(now).as_millis() as u64,
        })
    }).collect::<Vec<_>>();
    entries.sort_by(|left, right| left.virtual_path.cmp(&right.virtual_path)
        .then_with(|| left.content_type.cmp(&right.content_type)));

    Ok(Json(CacheBrowserResponse {
        session_id: id,
        cached_bytes: cache.bytes,
        max_cache_bytes: MAX_CACHE_BYTES,
        entries,
    }))
}

async fn session_cache_content(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<CacheContentQuery>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let session = find_session(&state, &id).await?;
    let mut cache = session.cache.lock().await;
    let key = cache.entries.iter()
        .find(|(_, entry)| entry.id == query.file_id)
        .map(|(key, _)| key.clone())
        .ok_or((StatusCode::NOT_FOUND, "Cached file no longer exists or has expired".into()))?;

    let expired = cache.entries.get(&key)
        .is_some_and(|entry| entry.expires_at <= Instant::now());
    if expired {
        if let Some(entry) = cache.entries.remove(&key) {
            cache.bytes = cache.bytes.saturating_sub(entry.body.len());
        }
        return Err((StatusCode::NOT_FOUND, "Cached file has expired".into()));
    }
    let entry = cache.entries.get(&key).cloned()
        .ok_or((StatusCode::NOT_FOUND, "Cached file no longer exists".into()))?;
    drop(cache);

    // Always deliver cached bytes as an opaque download payload. In particular,
    // never let cached HTML, SVG, or JavaScript execute on the trusted dashboard.
    let mut response = Response::new(Body::from(entry.body));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if let Some(content_type) = entry.headers.get(header::CONTENT_TYPE) {
        if let Ok(value) = HeaderValue::from_str(content_type.to_str().unwrap_or("")) {
            headers.insert("x-intercept-source-content-type", value);
        }
    }
    Ok(response)
}

fn cache_virtual_path(url: &Url) -> (String, String) {
    let host = url.host_str().unwrap_or("unknown");
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    let root = format!("{}-{authority}", url.scheme());
    let segments = url.path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_default();
    let directory_url = url.path().ends_with('/');
    let file_name = if directory_url {
        "index".to_owned()
    } else {
        segments.last().cloned().unwrap_or_else(|| "index".to_owned())
    };
    let parent_segments = if directory_url {
        segments.as_slice()
    } else {
        &segments[..segments.len().saturating_sub(1)]
    };

    let mut components = vec![root];
    components.extend(parent_segments.iter().cloned());
    components.push(file_name.clone());
    (components.join("/"), file_name)
}

async fn get_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<ActionEvent>>, (StatusCode, String)> {
    let session = find_session(&state, &id).await?;
    // Keep the authority activity view focused on user/page/network activity,
    // not the iframe's internal polling and mount lifecycle.
    let events = session.events.lock().await.iter()
        .filter(|event| !is_internal_authority_event(&event.kind))
        .cloned()
        .collect::<Vec<_>>();
    Ok(Json(events))
}

fn is_internal_authority_event(kind: &str) -> bool {
    matches!(
        kind,
        "authority_status_received"
            | "authority_frame_load"
            | "authority_frame_error"
            | "authority_frame_retry"
            | "authority_frame_ready"
            | "authority_host_removed"
            | "controller_loaded"
    )
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
    push_event_with_error_body(session, kind, target, detail, None).await;
}

async fn push_event_with_error_body(
    session: &Session,
    kind: &str,
    target: String,
    detail: String,
    upstream_error_body: Option<UpstreamErrorBody>,
) {
    let mut events = session.events.lock().await;
    if events.len() == MAX_EVENTS {
        events.pop_front();
    }
    events.push_back(ActionEvent {
        at_unix_ms: now_ms(),
        kind: clean_field(kind.to_owned(), 80),
        target: clean_field(target, 240),
        detail: clean_field(detail, 300),
        upstream_error_body,
    });
}

async fn find_session(
    state: &AppState,
    id: &str,
) -> Result<Arc<Session>, (StatusCode, String)> {
    let session = state.sessions
        .read()
        .await
        .get(id)
        .cloned()
        .ok_or((StatusCode::NOT_FOUND, "Unknown or expired session".into()))?;
    session.last_accessed_ms.store(now_ms() as u64, Ordering::Relaxed);
    Ok(session)
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
    let event_count = session.events.lock().await.len();
    StatusResponse {
        state,
        remaining_ms,
        event_count,
    }
}

async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    loop {
        let cancelled = *cancellation.borrow_and_update();
        if cancelled {
            return;
        }
        if cancellation.changed().await.is_err() {
            return;
        }
    }
}

async fn wait_for_session_termination(session: &Session) {
    if session.cancelled.load(Ordering::Acquire) {
        return;
    }
    let mut cancellation = session.cancel_tx.subscribe();
    if session.cancelled.load(Ordering::Acquire) {
        return;
    }
    wait_for_cancellation(&mut cancellation).await;
}

async fn wait_for_authorization(session: &Session) -> bool {
    let mut updates = session.gate_tx.subscribe();
    let mut cancellation = session.cancel_tx.subscribe();
    loop {
        let already_cancelled = *cancellation.borrow_and_update();
        if already_cancelled {
            return false;
        }
        let state = *updates.borrow_and_update();
        match state {
            GateState::Waiting => {
                tokio::select! {
                    biased;
                    _ = wait_for_cancellation(&mut cancellation) => return false,
                    changed = updates.changed() => {
                        if changed.is_err() {
                            return false;
                        }
                    }
                }
            }
            GateState::Released => return true,
            GateState::Running { deadline } => {
                tokio::select! {
                    biased;
                    _ = wait_for_cancellation(&mut cancellation) => return false,
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
                            return false;
                        }
                    }
                }
            }
        }
    }
}

fn is_ajax_request(headers: &HeaderMap) -> bool {
    let value_is = |name: &str, expected: &str| {
        headers.get(name)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|token| token.trim().eq_ignore_ascii_case(expected))
            })
    };
    let accepts_event_stream = headers.get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));

    value_is("x-intercept-proxy-mode", "ajax")
        || value_is("x-requested-with", "xmlhttprequest")
        || value_is("sec-fetch-dest", "empty")
        || accepts_event_stream
}

async fn ajax_passthrough(
    session: &Session,
    upstream_url: Url,
    request_method: Method,
    request_headers: HeaderMap,
    request_body: bytes::Bytes,
    input_trace: Option<String>,
    context: ProxyRequestContext,
) -> Response<Body> {
    let ProxyRequestContext { request_id, started_at: request_started, permit: request_permit } = context;
    let upstream_host = upstream_url.host_str().unwrap_or_default().to_owned();
    let upstream_path = upstream_url.path().to_owned();
    let range_requested = request_headers.contains_key(header::RANGE);
    let client = tokio::select! {
        _ = wait_for_session_termination(session) => {
            return plain(StatusCode::GONE, "Session terminated");
        }
        result = client_for(session, &upstream_url) => match result {
            Ok(client) => client,
            Err((status, message)) => {
                push_event(
                    session,
                    "ajax_error",
                    format!("{upstream_host}{upstream_path}"),
                    format!(
                        "rid={request_id} client initialization failed · HTTP {} · {}",
                        status.as_u16(),
                        clean_field(message.clone(), 180)
                    ),
                ).await;
                return plain(status, &message);
            }
        }
    };
    let method = match reqwest::Method::from_bytes(request_method.as_str().as_bytes()) {
        Ok(method) => method,
        Err(_) => return plain(StatusCode::METHOD_NOT_ALLOWED, "Unsupported HTTP method"),
    };

    let mut builder = client.request(method, upstream_url.clone());
    for (name, value) in request_headers.iter() {
        if should_skip_request_header(name) {
            continue;
        }
        if name == header::ORIGIN {
            if let Ok(origin) = HeaderValue::from_str(&session.base_url.origin().ascii_serialization()) {
                builder = builder.header(name.clone(), origin);
            }
        } else if name == header::REFERER {
            if let Some(referer) = rewrite_referer(value, session) {
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

    // Request uploads remain bounded by MAX_REQUEST_BODY. Responses are streamed
    // and are not subject to the document pipeline's 32 MiB buffering limit.
    let upstream = tokio::select! {
        _ = wait_for_session_termination(session) => {
            return plain(StatusCode::GONE, "Session terminated");
        }
        result = builder
            .header(header::ACCEPT_ENCODING, "identity")
            .timeout(Duration::from_secs(AJAX_STREAM_TIMEOUT_SECONDS))
            .body(request_body)
            .send() => match result {
        Ok(response) => response,
        Err(error) => {
            let failure_kind = if error.is_timeout() {
                "timeout"
            } else if error.is_connect() {
                "connect"
            } else if error.is_body() {
                "body"
            } else if error.is_decode() {
                "decode"
            } else if error.is_redirect() {
                "redirect"
            } else {
                "request"
            };
            // Signed media URLs carry expiring authorization in their query.
            // Strip the URL before logging and report only its host/path.
            let safe_error = error.without_url().to_string();
            warn!(
                error_kind = failure_kind,
                error = %safe_error,
                request_id = %request_id,
                host = %upstream_host,
                path = %upstream_path,
                range_requested,
                elapsed_ms = request_started.elapsed().as_millis(),
                "AJAX upstream request failed"
            );
            push_event(
                session,
                "ajax_error",
                format!("{upstream_host}{upstream_path}"),
                format!(
                    "rid={request_id} {failure_kind} failure · range={range_requested} · {}{}",
                    clean_field(safe_error, 180),
                    input_trace.as_ref().map(|trace| format!(" · {trace}")).unwrap_or_default()
                ),
            ).await;
            return plain(StatusCode::BAD_GATEWAY, "AJAX upstream request failed");
        }
    }
    };

    let mut upstream = upstream;
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let upstream_set_cookie = upstream_headers.contains_key(header::SET_COOKIE);
    let upstream_elapsed_ms = request_started.elapsed().as_millis();

    // Sample a bounded prefix of textual error responses for the JSON event
    // export. Every consumed byte is replayed unchanged to the browser.
    // Content-Length lets short error bodies be captured completely; chunked
    // and long-lived responses are bounded by both size and elapsed time.
    let mut error_prefix = Vec::new();
    let mut error_body_capture = Vec::with_capacity(MAX_ERROR_BODY_BYTES);
    let mut error_preview = None;
    let mut error_sampled_bytes = 0usize;
    let mut first_error_chunk_seen = false;
    let mut error_read_failed = false;
    let mut error_body_truncated = false;
    let mut error_body_complete = false;
    let mut error_body_timed_out = false;
    let error_content_type = upstream_headers.get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let upstream_content_length = upstream_headers.get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    let should_sample_error = !status.is_success()
        && !error_content_type.to_ascii_lowercase().contains("text/event-stream")
        && (error_content_type.starts_with("text/")
            || error_content_type.contains("xml")
            || error_content_type.contains("json"));
    if should_sample_error {
        let sample_deadline = tokio::time::sleep(Duration::from_millis(MAX_ERROR_BODY_SAMPLE_MS));
        tokio::pin!(sample_deadline);
        loop {
            let next_chunk = tokio::select! {
                _ = &mut sample_deadline => {
                    error_body_timed_out = true;
                    break;
                }
                chunk = upstream.chunk() => chunk,
            };
            match next_chunk {
                Ok(Some(chunk)) => {
                    if !first_error_chunk_seen {
                        error_sampled_bytes = chunk.len();
                        first_error_chunk_seen = true;
                    }

                    let remaining = MAX_ERROR_BODY_BYTES.saturating_sub(error_body_capture.len());
                    let captured_len = chunk.len().min(remaining);
                    if captured_len > 0 {
                        error_body_capture.extend_from_slice(&chunk[..captured_len]);
                        error_prefix.push(chunk.slice(..captured_len));
                    }
                    if chunk.len() > captured_len {
                        // The tail of this already-read network chunk must be
                        // forwarded too, even though it is outside the capture.
                        error_prefix.push(chunk.slice(captured_len..));
                        error_body_truncated = true;
                        break;
                    }

                    if upstream_content_length
                        .is_some_and(|length| error_body_capture.len() >= length)
                    {
                        error_body_complete = true;
                        break;
                    }
                    if error_body_capture.len() >= MAX_ERROR_BODY_BYTES
                        && upstream_content_length.is_some_and(|length| length > MAX_ERROR_BODY_BYTES)
                    {
                        error_body_truncated = true;
                        break;
                    }
                }
                Ok(None) => {
                    error_body_complete = true;
                    break;
                }
                Err(error) => {
                    error_read_failed = true;
                    debug!(
                        host = %upstream_host,
                        path = %upstream_path,
                        error = %error.without_url(),
                        "Could not sample upstream error response"
                    );
                    break;
                }
            }
        }
    }
    if upstream_content_length
        .is_some_and(|length| length > error_body_capture.len())
        && should_sample_error
    {
        error_body_truncated = true;
    }
    let sanitized_error_body = if should_sample_error {
        let text = sanitize_error_body(&error_body_capture);
        if !text.is_empty() {
            error_preview = Some(text.chars().take(240).collect());
        }
        Some(UpstreamErrorBody {
            text,
            captured_bytes: error_body_capture.len(),
            truncated: error_body_truncated,
            complete: error_body_complete && !error_read_failed,
            timed_out: error_body_timed_out,
        })
    } else {
        None
    };
    let error_body_state = error_body_state(
        should_sample_error,
        error_sampled_bytes,
        error_read_failed,
    );
    let mut response = Response::builder().status(status);
    let response_headers = response.headers_mut().expect("fresh response builder");
    response_headers.insert("origin-agent-cluster", HeaderValue::from_static("?1"));
    if upstream_set_cookie {
        response_headers.insert("x-intercept-cookie-updated", HeaderValue::from_static("1"));
    }
    for (name, value) in upstream_headers.iter() {
        if should_skip_response_header(name) {
            continue;
        }
        if name == header::LOCATION {
            if let Ok(location) = value.to_str() {
                let rewritten = rewrite_location(
                    location,
                    &upstream_url,
                    &session.base_url,
                    &session.id,
                );
                if let Ok(value) = HeaderValue::from_str(&rewritten) {
                    response_headers.append(name.clone(), value);
                }
            }
        } else if name == header::SET_COOKIE {
            if let Ok(cookie) = value.to_str() {
                let rewritten = rewrite_set_cookie(
                    cookie,
                    &upstream_url,
                    &session.base_url,
                    &session.id,
                );
                if let Ok(value) = HeaderValue::from_str(&rewritten) {
                    response_headers.append(name.clone(), value);
                }
            }
        } else {
            // Retain Content-Type, Content-Length, cache directives, retry hints,
            // CORS metadata, and application-specific response headers unchanged.
            response_headers.append(name.clone(), value.clone());
        }
    }

    let response_diagnostics = if !status.is_success() {
        let content_type = diagnostic_header(&upstream_headers, "content-type", "type", 80);
        let content_length = diagnostic_header(&upstream_headers, "content-length", "content_length", 24);
        let server = diagnostic_header(&upstream_headers, "server", "server", 80);
        let retry_after = diagnostic_header(&upstream_headers, "retry-after", "retry_after", 80);
        let request_id_header = diagnostic_header(
            &upstream_headers,
            "x-guploader-uploadid",
            "guploader",
            80,
        );
        let preview = error_preview
            .map(|value| format!(" · upstream={value}"))
            .unwrap_or_default();
        format!(
            " · body_state={error_body_state} · body_bytes={error_sampled_bytes}{content_length}{server}{retry_after}{request_id_header}{content_type}{preview}"
        )
    } else {
        String::new()
    };
    push_event_with_error_body(
        session,
        "ajax_response",
        format!("{upstream_host}{upstream_path}"),
        format!(
            "rid={request_id} · {} · headers in {}ms{}{}",
            status.as_u16(),
            upstream_elapsed_ms,
            response_diagnostics,
            input_trace.as_ref().map(|trace| format!(" · {trace}")).unwrap_or_default()
        ),
        sanitized_error_body,
    ).await;
    debug!(
        request_id = %request_id,
        method = %request_method,
        host = %upstream_host,
        path = %upstream_path,
        status = %status,
        upstream_elapsed_ms,
        streaming = true,
        "AJAX passthrough response opened"
    );

    let stream_target = format!("{upstream_host}{upstream_path}");
    let mut cancellation = session.cancel_tx.subscribe();
    let cancelled = async move {
        wait_for_cancellation(&mut cancellation).await;
    };
    let prefix_stream = futures_util::stream::iter(
        error_prefix.into_iter().map(Ok::<_, io::Error>)
    );
    let remainder_stream = upstream.bytes_stream().take_until(cancelled).map(move |chunk| {
        let _keep_request_slot = &request_permit;
        chunk.map_err(|error| {
            let safe_error = error.without_url().to_string();
            warn!(
                error = %safe_error,
                request_id = %request_id,
                target = %stream_target,
                "AJAX upstream response stream failed"
            );
            io::Error::other(safe_error)
        })
    });
    let body_stream = prefix_stream.chain(remainder_stream);
    response.body(Body::from_stream(body_stream))
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Could not build AJAX passthrough response"))
}

async fn stream_regular_response(
    upstream: reqwest::Response,
    session: &Session,
    upstream_url: &Url,
    context: ProxyRequestContext,
) -> Response<Body> {
    let ProxyRequestContext { request_id, started_at: request_started, permit: request_permit } = context;
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    let headers = response.headers_mut().expect("fresh streaming response builder");
    headers.insert("origin-agent-cluster", HeaderValue::from_static("?1"));
    for (name, value) in upstream_headers.iter() {
        if should_skip_response_header(name) {
            continue;
        }
        if name == header::LOCATION {
            if let Ok(location) = value.to_str() {
                let rewritten = rewrite_location(location, upstream_url, &session.base_url, &session.id);
                if let Ok(value) = HeaderValue::from_str(&rewritten) {
                    headers.append(name.clone(), value);
                }
            }
        } else if name == header::SET_COOKIE {
            if let Ok(cookie) = value.to_str() {
                let rewritten = rewrite_set_cookie(cookie, upstream_url, &session.base_url, &session.id);
                if let Ok(value) = HeaderValue::from_str(&rewritten) {
                    headers.append(name.clone(), value);
                }
            }
        } else if matches!(name.as_str(), "content-security-policy" | "content-security-policy-report-only") {
            if let Ok(policy) = value.to_str() {
                if let Ok(value) = HeaderValue::from_str(&rewrite_csp(policy, &session.id)) {
                    headers.append(name.clone(), value);
                }
            }
        } else {
            headers.append(name.clone(), value.clone());
        }
    }
    let url = upstream_url.to_string();
    let stream_request_id = request_id.clone();
    let mut cancellation = session.cancel_tx.subscribe();
    let cancelled = async move {
        wait_for_cancellation(&mut cancellation).await;
    };
    let body_stream = upstream.bytes_stream().take_until(cancelled).map(move |chunk| {
        let _keep_request_slot = &request_permit;
        chunk.map_err(|error| {
            warn!(
                %error,
                request_id = %stream_request_id,
                url = %url,
                elapsed_ms = request_started.elapsed().as_millis(),
                "Opaque upstream response stream failed"
            );
            io::Error::other(error)
        })
    });
    debug!(
        request_id = %request_id,
        url = %upstream_url,
        status = %status,
        streaming = true,
        "Opaque upstream response streaming"
    );
    response.body(Body::from_stream(body_stream))
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Could not build streaming response"))
}

async fn proxy(
    State(state): State<AppState>,
    Path(params): Path<HashMap<String, String>>,
    OriginalUri(uri): OriginalUri,
    request: Request<Body>,
) -> Response<Body> {
    let request_started = Instant::now();
    let request_id = Uuid::new_v4().simple().to_string();
    let Some(id) = params.get("id") else {
        return plain(StatusCode::BAD_REQUEST, "Missing session id");
    };
    let session = match find_session(&state, id).await {
        Ok(session) => session,
        Err((status, message)) => return plain(status, &message),
    };

    let request_permit = match session.inflight.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return plain(StatusCode::TOO_MANY_REQUESTS, "Session request concurrency limit reached"),
    };
    let upstream_url = match upstream_url_for_request(&uri, &session) {
        Ok(url) => url,
        Err(message) => return plain(StatusCode::BAD_REQUEST, &message),
    };
    debug!(request_id = %request_id, method = %request.method(), path = %upstream_url.path(),
        "Proxy request routed");
    if !matches!(upstream_url.scheme(), "http" | "https") || !is_public_destination(&upstream_url) {
        return plain(StatusCode::FORBIDDEN, "Only public HTTP and HTTPS destinations are allowed");
    }

    let (parts, body) = request.into_parts();
    let ajax_request = is_ajax_request(&parts.headers);
    let input_trace = input_event_trace(&parts.headers);
    let worker_script = parts.headers.get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "worker" | "sharedworker" | "serviceworker"));
    push_event(
        &session,
        if ajax_request { "ajax_request" } else { "http_request" },
        upstream_url.path().to_owned(),
        format!(
            "rid={request_id} method={}{}",
            parts.method,
            input_trace.as_ref().map(|trace| format!(" · {trace}")).unwrap_or_default()
        ),
    ).await;
    let body = tokio::select! {
        _ = wait_for_session_termination(&session) => {
            return plain(StatusCode::GONE, "Session terminated");
        }
        result = to_bytes(body, MAX_REQUEST_BODY) => match result {
            Ok(body) => body,
            Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request body exceeds the 8 MiB limit"),
        }
    };

    let accept_html = parts.headers.get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"));
    let is_document = parts.headers.get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("document")) || accept_html;
    // Keep the one-time bootstrap exception available across upstream
    // redirects. It is consumed only after the final HTML document body has
    // been received, so Strict mode cannot deadlock before the authority UI loads.
    let bootstrap_document = session.policy == AuthorizationPolicy::Strict
        && parts.method == Method::GET
        && !ajax_request
        && is_document
        && session.bootstrap_pending.load(Ordering::Acquire);
    if should_hold_request(&session, &parts.method, &upstream_url, bootstrap_document)
        && !wait_for_authorization(&session).await
    {
        return plain(StatusCode::GONE, "Session terminated");
    }

    // API/fetch/XHR responses are opaque application data: bypass the asset
    // cache and every HTML/CSS/JavaScript transformation, then stream upstream
    // bytes directly to the browser.
    if ajax_request {
        return ajax_passthrough(
            &session,
            upstream_url,
            parts.method,
            parts.headers,
            body,
            input_trace,
            ProxyRequestContext {
                request_id: request_id.clone(),
                started_at: request_started,
                permit: request_permit,
            },
        ).await;
    }

    let cache_key = if parts.method == Method::GET {
        Some(resource_cache_key(&upstream_url, &parts.headers))
    } else {
        None
    };
    // A request-level no-cache directive means fetch a fresh representation,
    // not that the fresh response must be discarded. no-store is the directive
    // that prohibits both lookup and storage.
    let bypass_cache_lookup = request_requires_revalidation(&parts.headers)
        || request_forbids_cache_storage(&parts.headers);
    let prohibit_cache_store = request_forbids_cache_storage(&parts.headers);

    let cached = if bypass_cache_lookup {
        None
    } else if let Some(key) = cache_key.as_deref() {
        cache_get(&session, key).await
    } else {
        None
    };
    let cache_hit = cached.is_some();

    let mut upstream_elapsed_ms = 0u128;
    let (upstream_status, upstream_headers, mut response_body) = if let Some(cached) = cached {
        (cached.status, cached.headers, cached.body)
    } else {
        let upstream_started = Instant::now();
        let client = tokio::select! {
            _ = wait_for_session_termination(&session) => {
                return plain(StatusCode::GONE, "Session terminated");
            }
            result = client_for(&session, &upstream_url) => match result {
                Ok(client) => client,
                Err((status, message)) => return plain(status, &message),
            }
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

        let upstream = tokio::select! {
            _ = wait_for_session_termination(&session) => {
                return plain(StatusCode::GONE, "Session terminated");
            }
            result = builder.send() => match result {
            Ok(response) => response,
            Err(error) => {
                warn!(
                    error = ?error,
                    request_id = %request_id,
                    url = %upstream_url,
                    elapsed_ms = request_started.elapsed().as_millis(),
                    "Upstream request failed"
                );
                return plain(StatusCode::BAD_GATEWAY, "Upstream request failed");
            }
        }
        };

        let status = upstream.status();
        let headers = upstream.headers().clone();
        let response_content_type = headers.get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        let response_needs_rewrite = response_content_type.contains("text/html")
            || response_content_type.contains("text/css")
            || response_content_type.contains("javascript")
            || response_content_type.contains("ecmascript");
        let stream_opaque = !response_needs_rewrite && (
            !is_cacheable_asset(&response_content_type)
                || upstream.content_length().is_some_and(|length| length > MAX_CACHE_ENTRY_BYTES as u64)
        );
        if stream_opaque {
            return stream_regular_response(
                upstream,
                &session,
                &upstream_url,
                ProxyRequestContext {
                    request_id,
                    started_at: request_started,
                    permit: request_permit,
                },
            ).await;
        }
        if let Some(length) = upstream.content_length() {
            if length > MAX_RESPONSE_BODY as u64 {
                return plain(StatusCode::PAYLOAD_TOO_LARGE, "Upstream response exceeds the 32 MiB buffering limit");
            }
        }

        let mut bytes = Vec::new();
        let mut stream = upstream.bytes_stream();
        loop {
            let next = tokio::select! {
                _ = wait_for_session_termination(&session) => {
                    return plain(StatusCode::GONE, "Session terminated");
                }
                next = stream.next() => next,
            };
            let Some(next) = next else { break };
            match next {
                Ok(chunk) => {
                    if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY {
                        return plain(StatusCode::PAYLOAD_TOO_LARGE, "Upstream response exceeds the 32 MiB limit");
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Err(error) => {
                    warn!(
                        error = ?error,
                        timed_out = error.is_timeout(),
                        decode_error = error.is_decode(),
                        request_id = %request_id,
                        url = %upstream_url,
                        status = %status,
                        bytes_received = bytes.len(),
                        elapsed_ms = request_started.elapsed().as_millis(),
                        "Failed while reading upstream response"
                    );
                    return plain(StatusCode::BAD_GATEWAY, "Failed while reading upstream response");
                }
            }
        }
        upstream_elapsed_ms = upstream_started.elapsed().as_millis();

        if let Some(key) = cache_key.as_deref() {
            if !prohibit_cache_store {
                cache_put(&session, key, status, &headers, &bytes).await;
            }
        }
        push_event(
            &session,
            "upstream_body_received",
            upstream_url.path().to_owned(),
            format!("rid={request_id} status={} bytes={}", status.as_u16(), bytes.len()),
        ).await;
        (status, headers, bytes)
    };

    let rewrite_started = Instant::now();
    let content_type = upstream_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut transformed = false;
    let needs_rewrite = content_type.contains("text/html")
        || content_type.contains("text/css")
        || content_type.contains("javascript")
        || content_type.contains("ecmascript");

    if needs_rewrite {
        let permit = match state.rewrite_slots.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => return plain(StatusCode::INTERNAL_SERVER_ERROR, "Response rewrite workers are unavailable"),
        };
        let body = std::mem::take(&mut response_body);
        let rewrite_content_type = content_type.clone();
        let rewrite_base = upstream_url.clone();
        let rewrite_session_base = session.base_url.clone();
        let rewrite_session_id = id.clone();
        let rewrite_cookie_seed = session.cookie_jar.document_cookie_header(&upstream_url);
        let rewrite_cookie_token = if rewrite_content_type.contains("text/html") {
            let token = Uuid::new_v4().simple().to_string();
            let mut tokens = session.cookie_tokens.lock().unwrap_or_else(|error| error.into_inner());
            if tokens.len() >= 512 {
                if let Some(oldest) = tokens.keys().next().cloned() { tokens.remove(&oldest); }
            }
            tokens.insert(token.clone(), upstream_url.origin().ascii_serialization());
            token
        } else {
            String::new()
        };
        let rewrite_worker_script = worker_script;

        let rewrite_result = tokio::task::spawn_blocking(move || {
            // Keep the CPU concurrency bounded to the configured worker count.
            let _permit = permit;
            let mut body = body;
            let mut transformed = false;

            if let Ok(text) = std::str::from_utf8(&body) {
                if rewrite_content_type.contains("text/html") {
                    match rewrite_html(text, &rewrite_base, &rewrite_session_base, &rewrite_session_id, &rewrite_cookie_seed, &rewrite_cookie_token) {
                        Ok(rewritten) => {
                            body = rewritten.into_bytes();
                            transformed = true;
                        }
                        Err(error) => warn!(%error, url = %rewrite_base, "HTML rewrite failed; returning original HTML"),
                    }
                } else if rewrite_content_type.contains("text/css") {
                    match rewrite_css(text, &rewrite_base, &rewrite_session_base, &rewrite_session_id) {
                        Ok(rewritten) => {
                            body = rewritten.into_bytes();
                            transformed = true;
                        }
                        Err(error) => warn!(%error, url = %rewrite_base, "CSS rewrite failed; returning original stylesheet"),
                    }
                } else if rewrite_content_type.contains("javascript")
                    || rewrite_content_type.contains("ecmascript")
                {
                    let result = if rewrite_worker_script {
                        rewrite_worker_javascript(text, &rewrite_base, &rewrite_session_base, &rewrite_session_id)
                    } else {
                        rewrite_javascript(text, &rewrite_base, &rewrite_session_base, &rewrite_session_id)
                    };
                    match result {
                        Ok(rewritten) => {
                            body = rewritten.into_bytes();
                            transformed = true;
                        }
                        Err(error) => warn!(%error, url = %rewrite_base, worker_script = rewrite_worker_script,
                            "JavaScript URL rewrite failed; returning original script"),
                    }
                }
            }

            (body, transformed)
        }).await;

        match rewrite_result {
            Ok((rewritten_body, was_transformed)) => {
                response_body = rewritten_body;
                transformed = was_transformed;
            }
            Err(error) => {
                warn!(%error, url = %upstream_url, "Response rewrite worker failed");
                return plain(StatusCode::INTERNAL_SERVER_ERROR, "Response rewrite worker failed");
            }
        }
    }
    if bootstrap_document
        && !upstream_status.is_redirection()
        && content_type.contains("text/html")
    {
        session.bootstrap_pending.store(false, Ordering::Release);
    }

    let rewrite_elapsed_ms = rewrite_started.elapsed().as_millis();

    let mut response = Response::builder().status(upstream_status);
    let headers = response.headers_mut().expect("fresh response builder");
    headers.insert("origin-agent-cluster", HeaderValue::from_static("?1"));
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
                if let Ok(value) = HeaderValue::from_str(&rewrite_csp(policy, &session.id)) {
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
    debug!(
        method = %parts.method,
        url = %upstream_url,
        status = %upstream_status,
        cache_hit,
        upstream_elapsed_ms,
        rewrite_elapsed_ms,
        response_bytes = response_body.len(),
        request_id = %request_id,
        elapsed_ms = request_started.elapsed().as_millis(),
        "Proxy request completed"
    );
    response.body(Body::from(response_body))
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Could not build proxy response"))
}

fn upstream_url_for_request(uri: &axum::http::Uri, session: &Session) -> Result<Url, String> {
    let prefix = format!("/p/{}", session.id);
    // History API navigations (notably YouTube SPA search) may leave the
    // canonical /p/{id} prefix in the visible URL. Such paths still arrive
    // on the session-specific host and must resolve to the primary upstream.
    let suffix = uri.path().strip_prefix(&prefix).unwrap_or_else(|| uri.path());

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

    let local_session_host = format!("{}.localhost", session.id);
    let session_referer = referer.host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case(&local_session_host))
        && referer.port() == Some(5000);
    let legacy_session_referer = referer.host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost"))
        && referer.port() == Some(5000)
        && referer.path().starts_with(&format!("/p/{}/", session.id));
    let upstream = if session_referer || legacy_session_referer {
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
    // Cache identity must cover every request header that an upstream server
    // could name in Vary. Sort the pairs because HeaderMap iteration order is
    // not a stable cache-key ordering across independently built requests.
    let mut variants = headers.iter()
        .filter(|(name, _)| !matches!(
            name.as_str(),
            "cache-control" | "pragma" | "if-none-match" | "if-modified-since" | "accept-encoding"
        ))
        .map(|(name, value)| {
            let encoded = value.as_bytes().iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            format!("{}:{}:{}", name.as_str(), value.as_bytes().len(), encoded)
        })
        .collect::<Vec<_>>();

    // The upstream request always uses identity encoding, regardless of the
    // browser's advertised compression support. Represent that fixed value
    // explicitly so Vary: Accept-Encoding is safe and does not fragment keys.
    variants.push("accept-encoding:8:6964656e74697479".to_owned());
    variants.sort_unstable();
    format!("{}\n{}", url, variants.join("\n"))
}

fn cache_control_has_directive(headers: &HeaderMap, directive: &str) -> bool {
    headers.get(header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|control| control.split(',').any(|part| {
            part.trim().split('=').next().unwrap_or("").trim()
                .eq_ignore_ascii_case(directive)
        }))
}

fn request_requires_revalidation(headers: &HeaderMap) -> bool {
    cache_control_has_directive(headers, "no-cache")
        || headers.get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|control| control.split(',').any(|part| {
                part.trim().split_once('=').is_some_and(|(name, value)| {
                    name.trim().eq_ignore_ascii_case("max-age")
                        && value.trim().trim_matches('"').trim() == "0"
                })
            }))
        || headers.get(header::PRAGMA)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(',').any(|part| {
                part.trim().eq_ignore_ascii_case("no-cache")
            }))
}

fn request_forbids_cache_storage(headers: &HeaderMap) -> bool {
    cache_control_has_directive(headers, "no-store")
}

fn vary_header_is_supported(vary: &str) -> bool {
    if vary.trim().is_empty() {
        return true;
    }
    vary.split(',').all(|field| {
        let field = field.trim();
        field != "*" && !field.is_empty() && HeaderName::from_bytes(field.as_bytes()).is_ok()
    })
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
    // resource_cache_key includes every incoming request header, so arbitrary
    // valid Vary fields are isolated safely. Vary: * is never reusable.
    if !vary_header_is_supported(vary) {
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
        id: Uuid::new_v4().simple().to_string(),
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
    cookie_seed: &str,
    cookie_token: &str,
) -> Result<String, String> {
    let html_with_styles = HTML_STYLE_BLOCK_RE.replace_all(html, |captures: &regex::Captures<'_>| {
        let open = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let body = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        let close = captures.get(3).map(|m| m.as_str()).unwrap_or("");
        let rewritten = rewrite_css(body, base, session_base, session_id)
            .unwrap_or_else(|_| body.to_owned());
        format!("{open}{rewritten}{close}")
    }).into_owned();
    let html_with_styles_and_scripts = HTML_SCRIPT_BLOCK_RE.replace_all(&html_with_styles, |captures: &regex::Captures<'_>| {
        let open = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let body = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        let close = captures.get(3).map(|m| m.as_str()).unwrap_or("");
        let rewritten = rewrite_javascript(body, base, session_base, session_id)
            .unwrap_or_else(|_| body.to_owned());
        format!("{open}{rewritten}{close}")
    }).into_owned();

    let mut settings = RewriteStrSettings::new();
    let base_for_attrs = base.clone();
    let session_base_for_attrs = session_base.clone();
    let id_for_attrs = session_id.to_owned();
    settings = settings.append_element_content_handler(element!(
        "[href],[src],[action],[formaction],[poster],[data],[cite],[background],[srcset],[style]",
        move |el| {
            let mut rewrote_resource = false;
            for attribute in ["href", "src", "action", "formaction", "poster", "data", "cite", "background"] {
                if let Some(value) = el.get_attribute(attribute) {
                    if let Some(rewritten) = rewrite_url(
                        &base_for_attrs,
                        &session_base_for_attrs,
                        &id_for_attrs,
                        &value,
                    ) {
                        el.set_attribute(attribute, &rewritten)?;
                        rewrote_resource = true;
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
                rewrote_resource = true;
            }
            if rewrote_resource && el.get_attribute("integrity").is_some() {
                // Rewritten CSS/module responses no longer match upstream SRI hashes.
                el.remove_attribute("integrity");
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
    // One session host may represent multiple upstream origins. Scope browser
    // storage and cookies to the actual document origin rather than the proxy URL.
    let primary_origin = base.origin().ascii_serialization();
    let primary_origin_for_head = primary_origin.clone();
    let cookie_seed_for_head = cookie_seed.to_owned();
    let cookie_token_for_head = cookie_token.to_owned();
    let controller_nonce = HTML_SCRIPT_NONCE_RE.captures(&html_with_styles_and_scripts).and_then(|captures| {
        captures.get(1).or_else(|| captures.get(2)).map(|value| escape_html_attribute(value.as_str()))
    });
    settings = settings.append_element_content_handler(element!("head", move |el| {
        let nonce_attr = controller_nonce.as_ref()
            .map(|nonce| format!(r#" nonce="{nonce}""#))
            .unwrap_or_default();
        let head = format!(
            r#"<script data-intercept-controller="true" src="/assets/controller.js" data-session="{id_for_head}" data-upstream-origin="{primary_origin_for_head}" data-cookie-seed="{}" data-cookie-token="{}"{nonce_attr}></script><link data-intercept-styles="true" rel="stylesheet" href="/assets/intercept.css">"#,
            escape_html_attribute(&cookie_seed_for_head),
            escape_html_attribute(&cookie_token_for_head)
        );
        el.prepend(&head, ContentType::Html);
        Ok(())
    }));

    let session_id_for_csp = session_id.to_owned();
    settings = settings.append_element_content_handler(element!("meta[http-equiv][content]", move |el| {
        if el.get_attribute("http-equiv")
            .is_some_and(|value| value.eq_ignore_ascii_case("content-security-policy"))
        {
            if let Some(policy) = el.get_attribute("content") {
                el.set_attribute("content", &rewrite_csp(&policy, &session_id_for_csp))?;
            }
        }
        Ok(())
    }));

    let rewritten = match rewrite_str(&html_with_styles_and_scripts, settings) {
        Ok(result) => result,
        Err(error) => {
            warn!(%error, url = %base, "HTML parser rewrite failed; injecting the session controller with a conservative fallback");
            rewrite_meta_csp_tags(&html_with_styles_and_scripts, session_id)
        }
    };
    Ok(ensure_controller_bootstrap(&rewritten, session_id, &primary_origin, cookie_seed, cookie_token))
}

fn ensure_controller_bootstrap(html: &str, session_id: &str, primary_origin: &str, cookie_seed: &str, cookie_token: &str) -> String {
    if html.contains("data-intercept-controller=") {
        return html.to_owned();
    }

    let nonce = HTML_SCRIPT_NONCE_RE.captures(html).and_then(|captures| {
        captures.get(1).or_else(|| captures.get(2)).map(|value| value.as_str())
    });
    let nonce_attr = nonce.map(|value| {
        format!(r#" nonce="{}""#, escape_html_attribute(value))
    }).unwrap_or_default();
    let bootstrap = format!(
        r#"<script data-intercept-controller="true" src="/assets/controller.js" data-session="{}" data-upstream-origin="{}" data-cookie-seed="{}" data-cookie-token="{}"{}></script><link data-intercept-styles="true" rel="stylesheet" href="/assets/intercept.css">"#,
        escape_html_attribute(session_id),
        escape_html_attribute(primary_origin),
        escape_html_attribute(cookie_seed),
        escape_html_attribute(cookie_token),
        nonce_attr,
    );

    let lower = html.to_ascii_lowercase();
    if let Some(head_close) = lower.find("</head>") {
        let mut output = html.to_owned();
        output.insert_str(head_close, &bootstrap);
        return output;
    }
    if let Some(html_open) = lower.find("<html") {
        if let Some(open_end) = lower[html_open..].find('>') {
            let mut output = html.to_owned();
            output.insert_str(html_open + open_end + 1, &bootstrap);
            return output;
        }
    }
    if let Some(doctype) = lower.find("<!doctype") {
        if let Some(open_end) = lower[doctype..].find('>') {
            let mut output = html.to_owned();
            output.insert_str(doctype + open_end + 1, &bootstrap);
            return output;
        }
    }

    // The HTML parser will create implied html/head elements for fragments
    // when the controller script and stylesheet precede the first body node.
    format!("<!doctype html>{bootstrap}{html}")
}

fn escape_html_attribute(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
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

fn proxy_origin(session_id: &str) -> String {
    format!("http://{session_id}.localhost:{SESSION_PORT}")
}

fn proxy_origin_prefix(target: &Url, session_base: &Url, session_id: &str) -> String {
    if target.origin() == session_base.origin() {
        // Keep primary-origin resources at the session-host root. This makes
        // root-relative navigation and SPA history URLs resolve to the upstream.
        return String::new();
    }
    let origin = target.origin().ascii_serialization();
    let authority = origin.strip_prefix(&format!("{}://", target.scheme())).unwrap_or("");
    format!("/p/{session_id}/_/{}/{authority}", target.scheme())
}

fn proxy_url(target: &Url, session_base: &Url, session_id: &str) -> String {
    let mut result = format!("{}{}{}", proxy_origin(session_id), proxy_origin_prefix(target, session_base, session_id), target.path());
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
    let with_urls = CSS_URL_RE.replace_all(css, |captures: &regex::Captures<'_>| {
        let original = captures.get(0).map(|m| m.as_str()).unwrap_or("");
        let raw = captures.get(1).or_else(|| captures.get(2)).or_else(|| captures.get(3))
            .map(|m| m.as_str().trim()).unwrap_or("");
        match rewrite_url(base, session_base, session_id, raw) {
            Some(rewritten) => format!(r#"url("{rewritten}")"#),
            None => original.to_owned(),
        }
    });

    let with_imports = CSS_IMPORT_RE.replace_all(&with_urls, |captures: &regex::Captures<'_>| {
        let original = captures.get(0).map(|m| m.as_str()).unwrap_or("");
        let raw = captures.get(1).or_else(|| captures.get(2)).map(|m| m.as_str()).unwrap_or("");
        match rewrite_url(base, session_base, session_id, raw) {
            Some(rewritten) => format!(r#"@import url("{rewritten}")"#),
            None => original.to_owned(),
        }
    });
    Ok(with_imports.into_owned())
}

fn rewrite_javascript(source: &str, base: &Url, session_base: &Url, session_id: &str) -> Result<String, String> {
    let rewritten = JS_STATIC_IMPORT_RE.replace_all(source, |captures: &regex::Captures<'_>| {
        let prefix = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let quote = captures.get(2).map(|m| m.as_str()).unwrap_or("'");
        let raw = captures.get(3).map(|m| m.as_str()).unwrap_or("");
        let suffix = captures.get(4).map(|m| m.as_str()).unwrap_or(quote);
        let route = rewrite_url(base, session_base, session_id, raw).unwrap_or_else(|| raw.to_owned());
        format!("{prefix}{quote}{route}{suffix}")
    });

    let rewritten = JS_DYNAMIC_IMPORT_RE.replace_all(&rewritten, |captures: &regex::Captures<'_>| {
        let quote = captures.get(1).map(|m| m.as_str()).unwrap_or("'");
        let raw = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        let suffix = captures.get(3).map(|m| m.as_str()).unwrap_or(quote);
        let route = rewrite_url(base, session_base, session_id, raw).unwrap_or_else(|| raw.to_owned());
        format!("import({quote}{route}{suffix})")
    });
    Ok(rewritten.into_owned())
}

fn rewrite_worker_javascript(
    source: &str,
    base: &Url,
    session_base: &Url,
    session_id: &str,
) -> Result<String, String> {
    let rewritten = rewrite_javascript(source, base, session_base, session_id)?;
    let session = serde_json::to_string(session_id).map_err(|error| error.to_string())?;
    let primary_origin = serde_json::to_string(&session_base.origin().ascii_serialization())
        .map_err(|error| error.to_string())?;
    let bootstrap = format!(r#"(function(){{
      const sessionId={session};
      const primaryOrigin={primary_origin};
      const prefix="/p/"+encodeURIComponent(sessionId);
      function route(value){{
        let url;
        try{{url=new URL(value instanceof URL?value.href:String(value),self.location.href)}}catch(_e){{return value}}
        if(url.protocol!=="http:"&&url.protocol!=="https:")return url.href;
        const path=url.pathname+url.search+url.hash;
        if(url.origin===self.location.origin){{
          if(url.pathname===prefix||url.pathname.startsWith(prefix+"/"))return url.href;
          return url.href;
        }}
        if(url.origin===primaryOrigin)return path;
        return prefix+"/_/"+url.protocol.slice(0,-1)+"/"+url.host+path;
      }}
      if(self.fetch){{
        const nativeFetch=self.fetch.bind(self);
        self.fetch=function(input,init){{
          const source=input instanceof Request?input.url:input;
          const routed=route(source);
          let request;
          if(input instanceof Request){{request=new Request(routed,input);if(init)request=new Request(request,init)}}
          else request=new Request(routed,init);
          const headers=new Headers(request.headers);
          headers.set("X-Intercept-Proxy-Mode","ajax");
          return nativeFetch(new Request(request,{{headers}}));
        }};
      }}
      if(self.XMLHttpRequest){{
        const proto=XMLHttpRequest.prototype;
        const nativeOpen=proto.open;
        const nativeSet=proto.setRequestHeader;
        const nativeSend=proto.send;
        proto.open=function(method,url,...rest){{return nativeOpen.call(this,method,route(url),...rest)}};
        proto.send=function(...args){{try{{nativeSet.call(this,"X-Intercept-Proxy-Mode","ajax")}}catch(_e){{}}return nativeSend.apply(this,args)}};
      }}
      if(self.importScripts){{
        const nativeImportScripts=self.importScripts.bind(self);
        self.importScripts=(...urls)=>nativeImportScripts(...urls.map(route));
      }}
    }})();\n"#);
    Ok(format!("{bootstrap}{rewritten}"))
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


fn decode_html_attribute_entities(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn escape_meta_attribute_value(value: &str, quote: Option<char>) -> String {
    let mut escaped = value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    match quote {
        Some('"') => escaped = escaped.replace('"', "&quot;"),
        Some('\'') => escaped = escaped.replace('\'', "&#39;"),
        _ => {
            escaped = escaped.replace('"', "&quot;");
            return format!("\"{escaped}\"");
        }
    }
    escaped
}

// Rewrites a single meta tag without requiring a valid surrounding HTML tree.
// This is used when lol_html rejects malformed upstream markup; CSP must still
// be rewritten in that fallback or the browser continues enforcing upstream
// origins and blocks the local controller.
fn rewrite_meta_csp_tag(tag: &str, session_id: &str) -> String {
    let bytes = tag.as_bytes();
    let mut cursor = 5usize; // immediately after "<meta"
    let mut http_equiv: Option<String> = None;
    let mut content: Option<(usize, usize, Option<char>, String)> = None;

    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] == b'>' || bytes[cursor] == b'/' {
            break;
        }

        let name_start = cursor;
        while cursor < bytes.len()
            && !bytes[cursor].is_ascii_whitespace()
            && !matches!(bytes[cursor], b'=' | b'>' | b'/')
        {
            cursor += 1;
        }
        if name_start == cursor {
            cursor += 1;
            continue;
        }
        let name = tag[name_start..cursor].to_ascii_lowercase();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }

        let (value_start, value_end, quote) = if cursor < bytes.len()
            && matches!(bytes[cursor], b'"' | b'\'')
        {
            let quote = bytes[cursor] as char;
            cursor += 1;
            let start = cursor;
            while cursor < bytes.len() && bytes[cursor] != quote as u8 {
                cursor += 1;
            }
            let end = cursor;
            if cursor < bytes.len() {
                cursor += 1;
            }
            (start, end, Some(quote))
        } else {
            let start = cursor;
            while cursor < bytes.len()
                && !bytes[cursor].is_ascii_whitespace()
                && bytes[cursor] != b'>'
            {
                cursor += 1;
            }
            (start, cursor, None)
        };
        let value = decode_html_attribute_entities(&tag[value_start..value_end]);
        if name == "http-equiv" {
            http_equiv = Some(value);
        } else if name == "content" {
            content = Some((value_start, value_end, quote, value));
        }
    }

    if !http_equiv
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("content-security-policy"))
    {
        return tag.to_owned();
    }

    let Some((start, end, quote, policy)) = content else {
        return tag.to_owned();
    };
    let rewritten = rewrite_csp(&policy, session_id);
    let escaped = escape_meta_attribute_value(&rewritten, quote);
    format!("{}{}{}", &tag[..start], escaped, &tag[end..])
}

fn rewrite_meta_csp_tags(html: &str, session_id: &str) -> String {
    HTML_META_TAG_RE
        .replace_all(html, |captures: &regex::Captures<'_>| {
            let tag = captures.get(0).map(|value| value.as_str()).unwrap_or("");
            rewrite_meta_csp_tag(tag, session_id)
        })
        .into_owned()
}

fn rewrite_csp(policy: &str, session_id: &str) -> String {
    let local_origin = proxy_origin(session_id);
    const DASHBOARD_ORIGIN: &str = "http://127.0.0.1:5000";
    const SOURCE_DIRECTIVES: &[&str] = &[
        "default-src", "script-src", "script-src-elem", "script-src-attr",
        "style-src", "style-src-elem", "style-src-attr", "img-src", "font-src",
        "media-src", "connect-src", "frame-src", "child-src", "worker-src",
        "manifest-src", "prefetch-src", "form-action", "base-uri", "object-src",
    ];
    let mut has_style_src = false;
    let mut rewritten = policy.split(';')
        .filter_map(|directive| {
            let mut tokens = directive.split_whitespace();
            let name = tokens.next()?;
            if name.eq_ignore_ascii_case("upgrade-insecure-requests") {
                return None;
            }
            let is_style_src = name.eq_ignore_ascii_case("style-src");
            let is_style_element = name.eq_ignore_ascii_case("style-src-elem");
            if is_style_src {
                has_style_src = true;
            }
            let mut values = tokens.map(str::to_owned).collect::<Vec<_>>();
            if name.eq_ignore_ascii_case("trusted-types") {
                // The controller uses one narrowly scoped policy to convert
                // same-session script URLs into TrustedScriptURL objects.
                // Preserve upstream policy names, but add ours even when the
                // upstream policy was an explicit 'none' allow-list.
                values.retain(|value| !value.eq_ignore_ascii_case("'none'"));
                if !values.iter().any(|value| value == "*" || value == "intercept-proxy") {
                    values.push("intercept-proxy".to_owned());
                }
            }
            if SOURCE_DIRECTIVES.iter().any(|candidate| name.eq_ignore_ascii_case(candidate)) {
                values.retain(|value| value != "'none'");
                // strict-dynamic discards host allow-lists in modern browsers.
                // Nonce-bearing injected scripts retain the source's nonce path.
                if name.eq_ignore_ascii_case("script-src") || name.eq_ignore_ascii_case("script-src-elem") {
                    values.retain(|value| !value.eq_ignore_ascii_case("'strict-dynamic'"));
                }
                // Proxied sites commonly use inline style blocks for layout and
                // runtime rendering. Rewriting the allowed origins alone does not
                // authorize those blocks when style-src falls back to default-src.
                // Permit inline CSS only; script execution remains governed by the
                // original script directives and their nonce/hash requirements.
                if (is_style_src || is_style_element)
                    && !values.iter().any(|value| value.eq_ignore_ascii_case("'unsafe-inline'"))
                {
                    values.push("'unsafe-inline'".to_owned());
                }
                for value in &mut values {
                    if value.starts_with("http://") || value.starts_with("https://") || value.starts_with("*.") {
                        *value = local_origin.clone();
                    }
                }
                if !values.iter().any(|value| value == &local_origin || value == "'self'") {
                    values.push(local_origin.clone());
                }
                if (name.eq_ignore_ascii_case("default-src")
                    || name.eq_ignore_ascii_case("frame-src")
                    || name.eq_ignore_ascii_case("child-src"))
                    && !values.iter().any(|value| value == DASHBOARD_ORIGIN)
                {
                    values.push(DASHBOARD_ORIGIN.to_owned());
                }
            }
            Some(if values.is_empty() { name.to_owned() } else { format!("{name} {}", values.join(" ")) })
        })
        .collect::<Vec<_>>();
    // If no explicit style-src exists, default-src would otherwise continue to
    // block inline CSS. Add a narrow style policy rather than weakening default-src.
    if !has_style_src {
        rewritten.push(format!("style-src 'unsafe-inline' {local_origin}"));
    }
    rewritten.join("; ")
}

fn input_event_trace(headers: &HeaderMap) -> Option<String> {
    let id = headers.get("x-intercept-input-id")
        .and_then(|value| value.to_str().ok())?;
    if id.is_empty()
        || id.len() > 48
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    let target = headers.get("x-intercept-input-target")
        .and_then(|value| value.to_str().ok())
        .map(|value| clean_field(value.to_owned(), 180))
        .filter(|value| !value.is_empty());
    Some(match target {
        Some(target) => format!("input_id={id} target={target}"),
        None => format!("input_id={id}"),
    })
}

fn should_skip_request_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host" | "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade" | "content-length"
            | "accept-encoding" | "cookie" | "x-intercept-cookie-token" | "x-intercept-cookie-updated" | "x-intercept-proxy-mode"
            | "x-intercept-input-id" | "x-intercept-input-target"
    )
}

fn should_skip_response_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade" | "origin-agent-cluster" | "set-cookie" | "x-intercept-cookie-updated"
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

fn sanitize_error_body(body: &[u8]) -> String {
    let raw = String::from_utf8_lossy(body);
    let without_scripts = ERROR_BODY_SCRIPT_RE.replace_all(&raw, " ");
    let without_styles = ERROR_BODY_STYLE_RE.replace_all(&without_scripts, " ");
    let without_comments = ERROR_BODY_COMMENT_RE.replace_all(&without_styles, " ");
    let without_tags = ERROR_BODY_TAG_RE.replace_all(&without_comments, " ");
    let without_secrets = ERROR_BODY_SECRET_RE.replace_all(&without_tags, "$1=[REDACTED]");
    let without_bearers = ERROR_BODY_BEARER_RE.replace_all(&without_secrets, "Bearer [REDACTED]");
    let without_queries = ERROR_BODY_URL_QUERY_RE.replace_all(&without_bearers, "$1?[query redacted]");
    let normalized = without_queries.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_utf8_bytes(&normalized, MAX_ERROR_BODY_BYTES)
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn error_body_state(sampled: bool, sampled_bytes: usize, read_failed: bool) -> &'static str {
    if !sampled {
        "not_sampled"
    } else if read_failed {
        "read_error"
    } else if sampled_bytes == 0 {
        "empty"
    } else {
        "sampled"
    }
}

fn diagnostic_header(headers: &HeaderMap, name: &str, label: &str, max: usize) -> String {
    headers.get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| format!(
            " · {label}={}",
            clean_field(value.to_owned(), max)
        ))
        .unwrap_or_default()
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

    fn policy_test_session(policy: AuthorizationPolicy, rules: Vec<AuthorizationRule>) -> Session {
        Session {
            id: "0123456789abcdef0123456789abcdef".to_owned(),
            base_url: Url::parse("https://example.com/start").unwrap(),
            clients: Mutex::new(HashMap::new()),
            cache: Mutex::new(ResourceCache::default()),
            gate: Mutex::new(GateState::Waiting),
            gate_tx: watch::channel(GateState::Waiting).0,
            cancel_tx: watch::channel(false).0,
            cancelled: AtomicBool::new(false),
            events: Mutex::new(VecDeque::new()),
            policy,
            rules,
            bootstrap_pending: AtomicBool::new(true),
            last_accessed_ms: AtomicU64::new(0),
            start_delay_nanos: AtomicU64::new(0),
            inflight: Arc::new(Semaphore::new(8)),
            max_inflight: 8,
            cookie_jar: Arc::new(SessionCookieJar::default()),
            cookie_tokens: StdMutex::new(HashMap::new()),
        }
    }

    #[test]
    fn classifies_upstream_error_body_sampling_states() {
        assert_eq!(error_body_state(false, 0, false), "not_sampled");
        assert_eq!(error_body_state(true, 0, false), "empty");
        assert_eq!(error_body_state(true, 12, false), "sampled");
        assert_eq!(error_body_state(true, 0, true), "read_error");
        assert_eq!(error_body_state(true, 12, true), "read_error");
    }

    #[test]
    fn formats_only_present_sanitized_upstream_diagnostic_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("content-length", HeaderValue::from_static("0"));
        headers.insert("server", HeaderValue::from_static("gvs  "));
        headers.insert("retry-after", HeaderValue::from_static("5"));
        assert_eq!(
            diagnostic_header(&headers, "content-length", "content_length", 24),
            " · content_length=0"
        );
        assert_eq!(
            diagnostic_header(&headers, "server", "server", 80),
            " · server=gvs  "
        );
        assert_eq!(
            diagnostic_header(&headers, "retry-after", "retry_after", 80),
            " · retry_after=5"
        );
        assert_eq!(
            diagnostic_header(&headers, "x-guploader-uploadid", "guploader", 80),
            ""
        );
    }

    #[test]
    fn error_body_sanitizer_removes_markup_scripts_and_sensitive_values() {
        let body = br#"<!doctype html>
            <html><head><script>window.sessionToken = "do-not-export";</script>
            <style>.secret { color: red; }</style></head>
            <body><h1>Sorry...</h1>
            <input type="hidden" name="access_token" value="hidden-value">
            <p>Authorization: Bearer abc.def.ghi</p>
            <p>access_token=visible-secret</p>
            <p>https://accounts.example/login?continue=private&token=private</p>
            </body></html>"#;
        let sanitized = sanitize_error_body(body);

        assert!(sanitized.contains("Sorry..."));
        assert!(!sanitized.contains("<"));
        assert!(!sanitized.contains("window.sessionToken"));
        assert!(!sanitized.contains("do-not-export"));
        assert!(!sanitized.contains("hidden-value"));
        assert!(!sanitized.contains("abc.def.ghi"));
        assert!(!sanitized.contains("visible-secret"));
        assert!(!sanitized.contains("continue=private"));
        assert!(sanitized.contains("[REDACTED]"));
        assert!(sanitized.contains("[query redacted]"));
    }

    #[test]
    fn error_body_sanitizer_enforces_a_utf8_byte_limit() {
        let body = "é".repeat(MAX_ERROR_BODY_BYTES);
        let sanitized = sanitize_error_body(body.as_bytes());
        assert!(sanitized.len() <= MAX_ERROR_BODY_BYTES);
        assert!(sanitized.is_char_boundary(sanitized.len()));
    }

    #[test]
    fn event_json_retains_the_separate_bounded_body_field() {
        let event = ActionEvent {
            at_unix_ms: 1,
            kind: "ajax_response".to_owned(),
            target: "example.test/resource".to_owned(),
            detail: "upstream=short preview".to_owned(),
            upstream_error_body: Some(UpstreamErrorBody {
                text: "Sorry...".to_owned(),
                captured_bytes: 8,
                truncated: false,
                complete: true,
                timed_out: false,
            }),
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["detail"], "upstream=short preview");
        assert_eq!(value["upstream_error_body"]["text"], "Sorry...");
        assert_eq!(value["upstream_error_body"]["captured_bytes"], 8);

        let event_without_body = ActionEvent {
            at_unix_ms: 2,
            kind: "timer_started".to_owned(),
            target: "session".to_owned(),
            detail: "timer".to_owned(),
            upstream_error_body: None,
        };
        let value = serde_json::to_value(event_without_body).unwrap();
        assert!(value.get("upstream_error_body").is_none());
    }

    #[test]
    fn filters_internal_authority_lifecycle_events_from_activity_stream() {
        for kind in [
            "authority_status_received",
            "authority_frame_load",
            "authority_frame_error",
            "authority_frame_retry",
            "authority_frame_ready",
            "authority_host_removed",
            "controller_loaded",
        ] {
            assert!(is_internal_authority_event(kind), "{kind} should be hidden");
        }

        for kind in [
            "timer_started",
            "authorization_released",
            "http_request",
            "ajax_request",
            "dom_click",
        ] {
            assert!(!is_internal_authority_event(kind), "{kind} is meaningful activity");
        }
    }

    #[test]
    fn identifies_explicit_controller_ajax_marker() {
        let mut headers = HeaderMap::new();
        headers.insert("x-intercept-proxy-mode", HeaderValue::from_static("ajax"));
        assert!(is_ajax_request(&headers));

        // Multiple values can occur when XMLHttpRequest appends to an existing
        // same-name application header.
        headers.insert(
            "x-intercept-proxy-mode",
            HeaderValue::from_static("application, ajax"),
        );
        assert!(is_ajax_request(&headers));
    }

    #[test]
    fn identifies_fetch_metadata_ajax_requests() {
        let mut headers = HeaderMap::new();
        headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
        assert!(is_ajax_request(&headers));
    }

    #[test]
    fn identifies_legacy_xhr_and_eventsource_requests() {
        let mut xhr_headers = HeaderMap::new();
        xhr_headers.insert("x-requested-with", HeaderValue::from_static("XMLHttpRequest"));
        assert!(is_ajax_request(&xhr_headers));

        let mut event_headers = HeaderMap::new();
        event_headers.insert(header::ACCEPT, HeaderValue::from_static("text/event-stream"));
        assert!(is_ajax_request(&event_headers));
    }

    #[test]
    fn cache_key_includes_varyable_request_headers_in_stable_order() {
        let url = Url::parse("https://cdn.example/assets/image.webp").unwrap();
        let mut first = HeaderMap::new();
        first.insert(header::ACCEPT, HeaderValue::from_static("image/avif,image/webp"));
        first.insert("sec-fetch-dest", HeaderValue::from_static("image"));
        first.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip, br"));

        let mut same_representation = HeaderMap::new();
        same_representation.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
        same_representation.insert("sec-fetch-dest", HeaderValue::from_static("image"));
        same_representation.insert(header::ACCEPT, HeaderValue::from_static("image/avif,image/webp"));

        // Accept-Encoding is normalized to the proxy's fixed upstream value.
        assert_eq!(
            resource_cache_key(&url, &first),
            resource_cache_key(&url, &same_representation)
        );

        let mut another_variant = same_representation.clone();
        another_variant.insert("sec-fetch-dest", HeaderValue::from_static("script"));
        assert_ne!(
            resource_cache_key(&url, &first),
            resource_cache_key(&url, &another_variant)
        );
    }

    #[test]
    fn cache_key_ignores_request_revalidation_directives() {
        let url = Url::parse("https://cdn.example/assets/site.css").unwrap();
        let normal = HeaderMap::new();
        let mut reload = HeaderMap::new();
        reload.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        reload.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
        assert_eq!(
            resource_cache_key(&url, &normal),
            resource_cache_key(&url, &reload)
        );
    }

    #[test]
    fn request_no_cache_forces_origin_fetch_but_no_store_forbids_storage() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        assert!(request_requires_revalidation(&headers));
        assert!(!request_forbids_cache_storage(&headers));

        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("max-age=0"));
        assert!(request_requires_revalidation(&headers));
        assert!(!request_forbids_cache_storage(&headers));

        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        assert!(request_forbids_cache_storage(&headers));
    }

    #[test]
    fn supports_arbitrary_valid_vary_fields_but_rejects_star() {
        assert!(vary_header_is_supported(""));
        assert!(vary_header_is_supported("Accept-Encoding, Sec-Fetch-Dest, Origin"));
        assert!(!vary_header_is_supported("*"));
        assert!(!vary_header_is_supported("Accept, *"));
        assert!(!vary_header_is_supported("not a header name"));
    }

    #[test]
    fn session_host_root_paths_proxy_to_the_primary_upstream_origin() {
        let mut session = policy_test_session(AuthorizationPolicy::Standard, Vec::new());
        session.base_url = Url::parse("https://www.youtube.com/").unwrap();

        let uri = "/results?search_query=a".parse::<axum::http::Uri>().unwrap();
        assert_eq!(
            upstream_url_for_request(&uri, &session).unwrap().as_str(),
            "https://www.youtube.com/results?search_query=a"
        );

        let root = "/".parse::<axum::http::Uri>().unwrap();
        assert_eq!(
            upstream_url_for_request(&root, &session).unwrap().as_str(),
            "https://www.youtube.com/"
        );
    }

    #[test]
    fn canonical_session_paths_keep_existing_upstream_mapping() {
        let mut session = policy_test_session(AuthorizationPolicy::Standard, Vec::new());
        session.base_url = Url::parse("https://www.youtube.com/").unwrap();

        let uri = format!("/p/{}/results?search_query=a", session.id)
            .parse::<axum::http::Uri>().unwrap();
        assert_eq!(
            upstream_url_for_request(&uri, &session).unwrap().as_str(),
            "https://www.youtube.com/results?search_query=a"
        );
    }

    #[test]
    fn cache_browser_paths_group_resources_by_scheme_host_and_directory() {
        let url = Url::parse("https://cdn.example:8443/assets/css/site.css?v=2").unwrap();
        assert_eq!(
            cache_virtual_path(&url),
            ("https-cdn.example:8443/assets/css/site.css".to_owned(), "site.css".to_owned())
        );
    }

    #[test]
    fn cache_browser_paths_show_directory_resources_as_index_entries() {
        let url = Url::parse("https://example.com/assets/").unwrap();
        assert_eq!(
            cache_virtual_path(&url),
            ("https-example.com/assets/index".to_owned(), "index".to_owned())
        );
    }

    #[test]
    fn does_not_classify_document_navigation_as_ajax() {
        let mut headers = HeaderMap::new();
        headers.insert("sec-fetch-dest", HeaderValue::from_static("document"));
        headers.insert("sec-fetch-mode", HeaderValue::from_static("navigate"));
        headers.insert(header::ACCEPT, HeaderValue::from_static("text/html"));
        assert!(!is_ajax_request(&headers));
    }

    #[test]
    fn translates_session_origin_referers_back_to_the_upstream_url() {
        let session = Session {
            id: "session1234567890abcdef1234567890".to_owned(),
            base_url: Url::parse("https://example.com/start").unwrap(),
            clients: Mutex::new(HashMap::new()),
            cache: Mutex::new(ResourceCache::default()),
            gate: Mutex::new(GateState::Waiting),
            gate_tx: watch::channel(GateState::Waiting).0,
            cancel_tx: watch::channel(false).0,
            cancelled: AtomicBool::new(false),
            events: Mutex::new(VecDeque::new()),
            policy: AuthorizationPolicy::Standard,
            rules: Vec::new(),
            bootstrap_pending: AtomicBool::new(false),
            last_accessed_ms: AtomicU64::new(0),
            start_delay_nanos: AtomicU64::new(0),
            inflight: Arc::new(Semaphore::new(1)),
            max_inflight: 1,
            cookie_jar: Arc::new(SessionCookieJar::default()),
            cookie_tokens: StdMutex::new(HashMap::new()),
        };
        let referer = HeaderValue::from_str(
            "http://session1234567890abcdef1234567890.localhost:5000/p/session1234567890abcdef1234567890/profile"
        ).unwrap();
        assert_eq!(
            rewrite_referer(&referer, &session).unwrap(),
            HeaderValue::from_static("https://example.com/profile")
        );
    }

    #[test]
    fn standard_policy_allows_only_known_youtube_read_only_post_endpoints() {
        let session = policy_test_session(AuthorizationPolicy::Standard, Vec::new());
        for url in [
            "https://www.youtube.com/youtubei/v1/complete?prettyPrint=false",
            "https://www.youtube.com/youtubei/v1/search",
            "https://youtubei.googleapis.com/youtubei/v1/complete",
            "https://m.youtube.com/youtubei/v1/search",
        ] {
            let target = Url::parse(url).unwrap();
            assert!(
                !should_hold_request(&session, &Method::POST, &target, false),
                "{url} should be allowed as a read-only POST"
            );
        }

        for url in [
            "https://www.youtube.com/youtubei/v1/like",
            "https://www.youtube.com/youtubei/v1/comment/create",
            "https://other.example/youtubei/v1/complete",
        ] {
            let target = Url::parse(url).unwrap();
            assert!(
                should_hold_request(&session, &Method::POST, &target, false),
                "{url} must remain protected"
            );
        }
    }

    #[test]
    fn standard_policy_allows_youtube_search_document_navigation_without_timer_release() {
        let session = policy_test_session(AuthorizationPolicy::Standard, Vec::new());
        let target = Url::parse("https://www.youtube.com/results?search_query=intercept").unwrap();
        assert!(
            !should_hold_request(&session, &Method::GET, &target, false),
            "Standard policy must allow YouTube's GET search navigation"
        );
    }

    #[test]
    fn strict_policy_holds_youtube_search_document_navigation_until_authorized() {
        let session = policy_test_session(AuthorizationPolicy::Strict, Vec::new());
        let target = Url::parse("https://www.youtube.com/results?search_query=intercept").unwrap();
        assert!(should_hold_request(&session, &Method::GET, &target, false));
    }

    #[test]
    fn strict_policy_still_holds_youtube_read_only_post_requests() {
        let session = policy_test_session(AuthorizationPolicy::Strict, Vec::new());
        let target = Url::parse("https://www.youtube.com/youtubei/v1/complete").unwrap();
        assert!(should_hold_request(&session, &Method::POST, &target, false));
    }

    #[test]
    fn input_event_trace_is_bounded_and_contains_no_input_value() {
        let mut headers = HeaderMap::new();
        headers.insert("x-intercept-input-id", HeaderValue::from_static("i1"));
        headers.insert("x-intercept-input-target", HeaderValue::from_static("input%23search"));
        assert_eq!(
            input_event_trace(&headers).as_deref(),
            Some("input_id=i1 target=input%23search")
        );

        headers.insert("x-intercept-input-id", HeaderValue::from_static("bad id"));
        assert!(input_event_trace(&headers).is_none());
    }

    #[test]
    fn standard_policy_holds_mutating_methods_but_allows_safe_methods() {
        let session = policy_test_session(AuthorizationPolicy::Standard, Vec::new());
        let target = Url::parse("https://example.com/api/items").unwrap();
        assert!(!should_hold_request(&session, &Method::GET, &target, false));
        assert!(!should_hold_request(&session, &Method::HEAD, &target, false));
        assert!(!should_hold_request(&session, &Method::OPTIONS, &target, false));
        assert!(should_hold_request(&session, &Method::POST, &target, false));
        assert!(should_hold_request(&session, &Method::DELETE, &target, false));
    }

    #[test]
    fn strict_policy_allows_only_the_initial_document_bootstrap() {
        let session = policy_test_session(AuthorizationPolicy::Strict, Vec::new());
        let target = Url::parse("https://example.com/start").unwrap();
        assert!(!should_hold_request(&session, &Method::GET, &target, true));
        assert!(should_hold_request(&session, &Method::GET, &target, false));
        assert!(should_hold_request(&session, &Method::POST, &target, true));
    }

    #[test]
    fn custom_policy_matches_host_path_and_method_then_falls_back_to_standard() {
        let session = policy_test_session(
            AuthorizationPolicy::Custom,
            vec![AuthorizationRule {
                host: Some("example.com".to_owned()),
                path_prefix: "/api/".to_owned(),
                methods: vec!["GET".to_owned()],
                hold: true,
            }],
        );
        let api = Url::parse("https://example.com/api/items").unwrap();
        let other_path = Url::parse("https://example.com/public/items").unwrap();
        let other_host = Url::parse("https://cdn.example/api/items").unwrap();
        assert!(should_hold_request(&session, &Method::GET, &api, false));
        assert!(!should_hold_request(&session, &Method::GET, &other_path, false));
        assert!(!should_hold_request(&session, &Method::GET, &other_host, false));
        assert!(should_hold_request(&session, &Method::POST, &api, false));
    }

    #[test]
    fn forwards_origin_and_referer_for_upstream_translation() {
        assert!(!should_skip_request_header(&header::ORIGIN));
        assert!(!should_skip_request_header(&header::REFERER));
    }

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
            Some("http://session123.localhost:5000/settings?tab=security".to_owned())
        );
        assert_eq!(
            rewrite_url(&base, &base, "session123", "https://cdn.example/image.png"),
            Some("http://session123.localhost:5000/p/session123/_/https/cdn.example/image.png".to_owned())
        );
    }

    #[test]
    fn session_url_preserves_the_submitted_path_query_and_fragment() {
        let target = Url::parse("https://example.com/account/settings?tab=security#sessions").unwrap();
        assert_eq!(
            local_url(&target, "session123"),
            "http://session123.localhost:5000/account/settings?tab=security#sessions"
        );
    }

    #[test]
    fn session_url_preserves_root_query_and_fragment() {
        let target = Url::parse("https://example.com/?mode=compact#top").unwrap();
        assert_eq!(
            local_url(&target, "session123"),
            "http://session123.localhost:5000/?mode=compact#top"
        );
    }


    #[test]
    fn cookie_jar_keeps_http_only_cookies_out_of_document_cookie() {
        let jar = SessionCookieJar::default();
        let url = Url::parse("https://example.com/consent/index").unwrap();
        let http_only = HeaderValue::from_static("sid=secret; Domain=example.com; Path=/; HttpOnly; Secure");
        let visible = HeaderValue::from_static("consent=yes; Domain=example.com; Path=/consent; Secure; SameSite=Lax");
        let mut headers = [&http_only, &visible].into_iter();
        reqwest::cookie::CookieStore::set_cookies(&jar, &mut headers, &url);
        let script_cookie = jar.document_cookie_header(&url);
        assert!(script_cookie.contains("consent=yes"));
        assert!(!script_cookie.contains("sid=secret"));
        let request_cookie = jar.request_cookie_header(&url).unwrap().to_str().unwrap().to_owned();
        assert!(request_cookie.contains("sid=secret"));
        assert!(request_cookie.contains("consent=yes"));
        assert_eq!(jar.document_cookie_header(&Url::parse("https://example.com/other").unwrap()), "");
    }

    #[test]
    fn javascript_cookie_bridge_rejects_httponly_and_invalid_host_prefixes() {
        let jar = SessionCookieJar::default();
        let url = Url::parse("https://example.com/consent").unwrap();
        assert!(jar.set_document_cookie("visible=yes; Path=/", &url).is_ok());
        assert!(jar.set_document_cookie("hidden=yes; HttpOnly", &url).is_err());
        assert!(jar.set_document_cookie("__Host-bad=yes; Secure; Path=/nested", &url).is_err());
        assert!(jar.set_document_cookie("__Host-good=yes; Secure; Path=/", &url).is_ok());
        assert!(jar.document_cookie_header(&url).contains("__Host-good=yes"));
    }

    #[test]
    fn javascript_cookie_bridge_ignores_domain_mismatch_like_browser() {
        let jar = SessionCookieJar::default();
        let url = Url::parse("https://www.youtube.com/").unwrap();

        // A script may attempt this, but a browser does not let a youtube.com
        // document write a cookie scoped to an unrelated domain.
        assert!(jar.set_document_cookie(
            "third_party=value; Domain=google.example; Path=/",
            &url
        ).is_ok());
        assert_eq!(jar.document_cookie_header(&url), "");
        assert_eq!(
            jar.document_cookie_header(&Url::parse("https://google.example/").unwrap()),
            ""
        );
    }

    #[test]
    fn javascript_cookie_bridge_treats_absent_expired_cookie_as_noop() {
        let jar = SessionCookieJar::default();
        let url = Url::parse("https://www.youtube.com/").unwrap();

        assert!(jar.set_document_cookie(
            "obsolete=; Max-Age=0; Path=/",
            &url
        ).is_ok());
        assert_eq!(jar.document_cookie_header(&url), "");
    }

    #[test]
    fn javascript_cookie_bridge_can_delete_an_existing_cookie() {
        let jar = SessionCookieJar::default();
        let url = Url::parse("https://www.youtube.com/").unwrap();

        assert!(jar.set_document_cookie("session=active; Path=/", &url).is_ok());
        assert!(jar.document_cookie_header(&url).contains("session=active"));

        assert!(jar.set_document_cookie(
            "session=; Max-Age=0; Path=/",
            &url
        ).is_ok());
        assert_eq!(jar.document_cookie_header(&url), "");
    }

    #[test]
    fn cookie_bridge_root_paths_use_the_document_capability_origin_after_redirects() {
        let session = policy_test_session(AuthorizationPolicy::Standard, Vec::new());
        let token = "0123456789abcdef0123456789abcdef";
        session.cookie_tokens.lock().unwrap().insert(token.to_owned(), "https://www.youtube.com".to_owned());
        let mut headers = HeaderMap::new();
        headers.insert("x-intercept-cookie-token", HeaderValue::from_static(token));

        let capability_origin = cookie_bridge_capability_origin(&session, &headers).unwrap();
        let target = cookie_bridge_target("/results?search_query=infected+mushroom", &session, &capability_origin).unwrap();

        assert_eq!(target.as_str(), "https://www.youtube.com/results?search_query=infected+mushroom");
        assert_ne!(target.origin(), session.base_url.origin());
    }

    #[test]
    fn cookie_bridge_encoded_secondary_origin_must_match_document_capability() {
        let session = policy_test_session(AuthorizationPolicy::Standard, Vec::new());
        let token = "0123456789abcdef0123456789abcdef";
        session.cookie_tokens.lock().unwrap().insert(token.to_owned(), "https://www.youtube.com".to_owned());
        let mut headers = HeaderMap::new();
        headers.insert("x-intercept-cookie-token", HeaderValue::from_static(token));
        let capability_origin = cookie_bridge_capability_origin(&session, &headers).unwrap();

        let allowed = format!("/p/{}/_/https/www.youtube.com/youtubei/v1/search", session.id);
        let allowed_url = cookie_bridge_target(&allowed, &session, &capability_origin).unwrap();
        assert_eq!(allowed_url.origin(), capability_origin.origin());

        let denied = format!("/p/{}/_/https/attacker.example/private", session.id);
        assert!(cookie_bridge_target(&denied, &session, &capability_origin).is_err());
    }

    #[test]
    fn cookie_bridge_capability_is_required_and_bound_to_a_registered_origin() {
        let session = policy_test_session(AuthorizationPolicy::Standard, Vec::new());
        let token = "0123456789abcdef0123456789abcdef";
        session.cookie_tokens.lock().unwrap().insert(token.to_owned(), "https://example.com".to_owned());
        let mut headers = HeaderMap::new();
        headers.insert("x-intercept-cookie-token", HeaderValue::from_static(token));
        let origin = cookie_bridge_capability_origin(&session, &headers).unwrap();
        assert_eq!(origin.origin().ascii_serialization(), "https://example.com");

        headers.insert("x-intercept-cookie-token", HeaderValue::from_static("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(cookie_bridge_capability_origin(&session, &headers).is_err());
    }

    #[test]
    fn html_rewriter_catches_svg_and_custom_element_resource_urls() {
        let base = Url::parse("https://www.youtube.com/").unwrap();
        let html = r##"<!doctype html><html><head></head><body>
            <svg><use href="https://www.gstatic.com/youtube/img/icons/web/youtube_fill/yt-logo-updated/v3/24px.svg#logo"></use></svg>
            <svg><image href="https://www.gstatic.com/youtube/img/icons/web/youtube_fill/offline_no_content/v1/192px.svg"></image></svg>
            <yt-icon href="https://youtube.com/"></yt-icon>
        </body></html>"##;
        let output = rewrite_html(
            html,
            &base,
            &base,
            "session123",
            "",
            "0123456789abcdef0123456789abcdef",
        ).unwrap();

        assert!(output.contains(
            "http://session123.localhost:5000/p/session123/_/https/www.gstatic.com/youtube/img/icons/web/youtube_fill/yt-logo-updated/v3/24px.svg#logo"
        ));
        assert!(output.contains(
            "http://session123.localhost:5000/p/session123/_/https/www.gstatic.com/youtube/img/icons/web/youtube_fill/offline_no_content/v1/192px.svg"
        ));
        assert!(output.contains(
            "http://session123.localhost:5000/p/session123/_/https/youtube.com/"
        ));
    }

    #[test]
    fn html_rewriter_injects_controller_and_styles() {
        let base = Url::parse("https://example.com/").unwrap();
        let html = r#"<!doctype html><html><head></head><body></body></html>"#;
        let result = rewrite_html(html, &base, &base, "session123", "consent=yes", "0123456789abcdef0123456789abcdef").unwrap();
        assert!(result.contains("data-intercept-controller"));
        assert!(result.contains("/assets/controller.js"));
        assert!(result.contains("/assets/intercept.css"));
        assert!(result.contains("data-session=\"session123\""));
    }

    #[test]
    fn html_controller_injection_handles_pages_without_head_or_body() {
        let base = Url::parse("https://example.com/").unwrap();
        let html = r#"<!doctype html><html><main>fragment</main></html>"#;
        let result = rewrite_html(html, &base, &base, "session123", "consent=yes", "0123456789abcdef0123456789abcdef").unwrap();
        assert!(result.contains("data-intercept-controller"));
        assert!(result.contains("/assets/controller.js"));
    }

    #[test]
    fn fallback_controller_injection_preserves_an_existing_csp_nonce() {
        let result = ensure_controller_bootstrap(
            r#"<html><head><script nonce="abc123">boot()</script></head><body>page</body></html>"#,
            "session123",
            "https://example.com",
            "consent=yes",
            "0123456789abcdef0123456789abcdef",
        );
        assert!(result.contains(r#"nonce="abc123""#));
        assert!(result.contains("data-intercept-controller"));
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
        assert!(output.contains("/images/bg.png"));
        assert!(output.contains("/p/session123/_/https/cdn.example/theme.css"));
    }


    #[test]
    fn injects_worker_fetch_and_xhr_routing_bootstrap() {
        let base = Url::parse("https://example.com/worker.js").unwrap();
        let output = rewrite_worker_javascript(
            "self.onmessage = () => fetch('/api/data');",
            &base,
            &Url::parse("https://example.com/").unwrap(),
            "session123",
        ).unwrap();
        assert!(output.contains("X-Intercept-Proxy-Mode"));
        assert!(output.contains("XMLHttpRequest"));
        assert!(output.contains("importScripts"));
        assert!(output.contains("if(url.origin===primaryOrigin)return path;"));
    }

    #[test]
    fn rewrites_external_redirects_through_the_session() {
        let current = Url::parse("https://example.com/start").unwrap();
        let primary = Url::parse("https://example.com/").unwrap();
        assert_eq!(
            rewrite_location("https://accounts.example/login", &current, &primary, "session123"),
            "http://session123.localhost:5000/p/session123/_/https/accounts.example/login"
        );
    }

    #[test]
    fn rewrites_meta_csp_and_removes_strict_dynamic_for_the_session_controller() {
        let base = Url::parse("https://example.com/").unwrap();
        let html = r#"<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-abc' 'strict-dynamic' https://cdn.example; default-src 'self'"></head><body></body></html>"#;
        let result = rewrite_html(html, &base, &base, "session123", "consent=yes", "0123456789abcdef0123456789abcdef").unwrap();
        assert!(result.contains("script-src 'nonce-abc'"));
        assert!(!result.contains("'strict-dynamic'"));
        assert!(result.contains("http://session123.localhost:5000"));
    }

    

    #[test]
    fn authority_frame_cooperates_with_cross_origin_isolated_parent() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cross-origin-resource-policy",
            HeaderValue::from_static("cross-origin"),
        );
        headers.insert(
            "cross-origin-embedder-policy",
            HeaderValue::from_static("require-corp"),
        );
        assert_eq!(
            headers.get("cross-origin-resource-policy").unwrap(),
            "cross-origin"
        );
        assert_eq!(
            headers.get("cross-origin-embedder-policy").unwrap(),
            "require-corp"
        );
    }

    #[test]
    fn fallback_meta_csp_rewrite_handles_attribute_order_and_single_quotes() {
        let html = "<meta content='default-src &#39;none&#39;; script-src https://cdn.example' HTTP-EQUIV='content-security-policy'>";
        let output = rewrite_meta_csp_tags(html, "0123456789abcdef0123456789abcdef");
        assert!(output.contains("default-src"));
        assert!(output.contains("http://0123456789abcdef0123456789abcdef.localhost:5000"));
        assert!(output.contains("style-src &#39;unsafe-inline&#39;"));
        assert!(!output.contains("https://cdn.example"));
    }

    #[test]
    fn csp_rewrite_allows_inline_styles_when_only_default_src_is_present() {
        let output = rewrite_csp(
            "default-src http://upstream.example",
            "session1234567890abcdef1234567890",
        );
        assert!(output.contains("style-src 'unsafe-inline' http://session1234567890abcdef1234567890.localhost:5000"));
        assert!(output.contains("default-src http://session1234567890abcdef1234567890.localhost:5000"));
    }

    #[test]
    fn csp_rewrite_allows_inline_styles_in_explicit_style_directives() {
        let output = rewrite_csp(
            "default-src 'self'; style-src 'self'; style-src-elem 'self'",
            "session1234567890abcdef1234567890",
        );
        let style_src = output.split(';').find(|part| part.trim_start().starts_with("style-src ")).unwrap();
        let style_elem = output.split(';').find(|part| part.trim_start().starts_with("style-src-elem ")).unwrap();
        assert!(style_src.contains("'unsafe-inline'"));
        assert!(style_elem.contains("'unsafe-inline'"));
    }

    #[test]
    fn csp_rewrite_allows_the_named_trusted_types_script_url_policy() {
        let output = rewrite_csp(
            "require-trusted-types-for 'script'; trusted-types youtube lit-html",
            "session123",
        );
        let directive = output.split(';')
            .find(|part| part.trim_start().starts_with("trusted-types "))
            .expect("trusted-types directive should remain");
        assert!(directive.split_whitespace().any(|value| value == "youtube"));
        assert!(directive.split_whitespace().any(|value| value == "lit-html"));
        assert!(directive.split_whitespace().any(|value| value == "intercept-proxy"));
        assert!(!directive.contains("*"));
    }

    #[test]
    fn csp_rewrite_replaces_a_none_trusted_types_allowlist_with_intercept_policy() {
        let output = rewrite_csp(
            "trusted-types 'none'; require-trusted-types-for 'script'",
            "session123",
        );
        let directive = output.split(';')
            .find(|part| part.trim_start().starts_with("trusted-types "))
            .expect("trusted-types directive should remain");
        assert!(directive.split_whitespace().any(|value| value == "intercept-proxy"));
        assert!(!directive.contains("'none'"));
    }

    #[test]
    fn csp_rewrite_preserves_nonce_policy_without_strict_dynamic() {
        let output = rewrite_csp("script-src 'nonce-abc' 'strict-dynamic' https://cdn.example", "session123");
        assert!(output.contains("'nonce-abc'"));
        assert!(!output.contains("'strict-dynamic'"));
        assert!(output.contains("http://session123.localhost:5000"));
    }

    #[test]
    fn rewrites_external_origins_in_csp_to_local_proxy_origin() {
        let policy = "default-src 'self' https://cdn.example; img-src https://images.example";
        let output = rewrite_csp(policy, "session1234567890abcdef1234567890");
        assert!(output.contains("default-src 'self' http://session1234567890abcdef1234567890.localhost:5000"));
        assert!(output.contains("img-src http://session1234567890abcdef1234567890.localhost:5000"));
    }

    #[test]
    fn namespaces_external_origins_in_proxy_paths() {
        let primary = Url::parse("https://example.com/").unwrap();
        let external = Url::parse("https://cdn.example:8443/a.js").unwrap();
        assert_eq!(
            proxy_url(&external, &primary, "session123"),
            "http://session123.localhost:5000/p/session123/_/https/cdn.example:8443/a.js"
        );
    }
    #[test]
    fn dashboard_accepts_both_loopback_hostnames_and_matches_origins() {
        assert_eq!(
            dashboard_origin_for_host("127.0.0.1:5000"),
            Some("http://127.0.0.1:5000")
        );
        assert_eq!(
            dashboard_origin_for_host("localhost:5000"),
            Some("http://localhost:5000")
        );
        assert!(is_dashboard_host("LOCALHOST:5000"));
        assert!(dashboard_origin_matches_host(
            "localhost:5000",
            "http://localhost:5000"
        ));
        assert!(dashboard_origin_matches_host(
            "127.0.0.1:5000",
            "http://127.0.0.1:5000"
        ));
        assert!(!dashboard_origin_matches_host(
            "localhost:5000",
            "http://127.0.0.1:5000"
        ));
        assert!(!dashboard_origin_matches_host(
            "127.0.0.1:5000",
            "http://localhost:5000"
        ));
        assert!(!is_dashboard_host("example.com:5000"));
    }
}
