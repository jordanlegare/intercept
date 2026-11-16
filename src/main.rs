use std::{
    collections::{HashMap, VecDeque},
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{Body, to_bytes},
    extract::{OriginalUri, Path, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode,
        header,
    },
    middleware::{self, Next},
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
    sync::{watch, Mutex, RwLock, Semaphore},
    time::{sleep_until, Instant},
};
use tracing::{debug, info, warn};
use url::Url;
use uuid::Uuid;

const LISTEN: &str = "127.0.0.1:5000";
const MAX_REQUEST_BODY: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY: usize = 32 * 1024 * 1024;
const MAX_EVENTS: usize = 500;
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
    events: Mutex<VecDeque<ActionEvent>>,
    policy: AuthorizationPolicy,
    rules: Vec<AuthorizationRule>,
    bootstrap_pending: AtomicBool,
    last_accessed_ms: AtomicU64,
    start_delay_nanos: AtomicU64,
    inflight: Arc<Semaphore>,
    max_inflight: usize,
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
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/{id}/start", post(start_timer).options(api_preflight))
        .route("/api/sessions/{id}/status", get(session_status).options(api_preflight))
        .route("/api/sessions/{id}/events", get(get_events).post(record_events).options(api_preflight))
        .route("/api/sessions/{id}/metrics", get(session_metrics).options(api_preflight))
        .route("/p/{id}", any(proxy))
        .route("/p/{id}/", any(proxy))
        .route("/p/{id}/{*path}", any(proxy))
        .layer(middleware::from_fn_with_state(state.clone(), host_and_cors_guard))
        .with_state(state.clone());

    let address: SocketAddr = LISTEN.parse()?;
    let listener = TcpListener::bind(address).await?;
    info!("Intercept dashboard and control API listening at http://{LISTEN}");
    info!("Session pages use per-session origins such as http://<session-id>.localhost:5000.");
    info!("The listener is loopback-only; this is not a network-wide transparent proxy.");
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .into_future();
    tokio::pin!(server);

    tokio::select! {
        result = &mut server => result?,
        signal = tokio::signal::ctrl_c() => {
            signal?;
            info!(
                grace_seconds = SHUTDOWN_GRACE_SECONDS,
                "Shutdown signal received; draining active requests"
            );
            let _ = shutdown_tx.send(());
            match tokio::time::timeout(
                Duration::from_secs(SHUTDOWN_GRACE_SECONDS),
                &mut server,
            ).await {
                Ok(result) => result?,
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
) -> Result<Html<String>, (StatusCode, String)> {
    find_session(&state, &id).await?;
    let page = include_str!("../web/authority.html").replace("__SESSION_ID__", &id);
    Ok(Html(page))
}

async fn authority_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../web/authority.js"),
    )
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

async fn host_and_cors_guard(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    let path = request.uri().path();
    let host = request.headers().get(header::HOST)
        .and_then(|value| value.to_str().ok()).unwrap_or("");

    // The dashboard and control API are deliberately reachable only through
    // their own origin. Proxied pages use a unique <session>.localhost origin.
    if path == "/" || path == "/api/sessions" || path.starts_with("/api/sessions/") {
        if !host.eq_ignore_ascii_case(DASHBOARD_HOST) {
            return plain(StatusCode::MISDIRECTED_REQUEST, "Use the trusted dashboard origin at 127.0.0.1:5000");
        }
        if request.headers().get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|origin| origin != "http://127.0.0.1:5000")
        {
            return plain(StatusCode::FORBIDDEN, "Cross-origin access to the trusted control API is denied");
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

    if path == "/_intercept/events" {
        let Some(id) = host.strip_suffix(&format!(".localhost:{SESSION_PORT}")) else {
            return plain(StatusCode::MISDIRECTED_REQUEST, "Event telemetry requires a session origin");
        };
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || state.sessions.read().await.get(id).is_none()
        {
            return plain(StatusCode::NOT_FOUND, "Unknown or expired session");
        }
        return next.run(request).await;
    }

    if path == "/assets/authority.js" || path.starts_with("/authority/") {
        if !host.eq_ignore_ascii_case(DASHBOARD_HOST) {
            return plain(StatusCode::MISDIRECTED_REQUEST, "Authority resources are served only from the dashboard origin");
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
    if !host.eq_ignore_ascii_case(DASHBOARD_HOST) {
        return plain(StatusCode::MISDIRECTED_REQUEST, "Unknown host for this local service");
    }
    next.run(request).await
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
        events: Mutex::new(VecDeque::new()),
        policy,
        rules: input.rules,
        bootstrap_pending: AtomicBool::new(true),
        last_accessed_ms: AtomicU64::new(now_ms() as u64),
        start_delay_nanos: AtomicU64::new(0),
        inflight: Arc::new(Semaphore::new(state.max_inflight_per_session)),
        max_inflight: state.max_inflight_per_session,
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
        now.saturating_sub(session.last_accessed_ms.load(Ordering::Relaxed)) < idle_limit
            || session.inflight.available_permits() < session.max_inflight
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

fn should_hold_request(session: &Session, method: &Method, target: &Url, bootstrap_document: bool) -> bool {
    let standard = method != Method::GET && method != Method::HEAD && method != Method::OPTIONS;
    match session.policy {
        AuthorizationPolicy::Standard => standard,
        AuthorizationPolicy::Strict => !bootstrap_document,
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

    debug!(host = %host, resolved_addresses = addresses.len(), "Upstream DNS resolution completed");
    let mut builder = reqwest::Client::builder()
        .http1_only()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(UPSTREAM_TIMEOUT_SECONDS))
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

    // Do not hold the session-wide map lock while DNS resolution and client
    // construction await network/runtime work. Different origins can initialize
    // their clients concurrently.
    if let Some(client) = session.clients.lock().await.get(&key).cloned() {
        return Ok(client);
    }

    let client = build_pinned_client(target).await?;
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
    context: ProxyRequestContext,
) -> Response<Body> {
    let ProxyRequestContext { request_id, started_at: request_started, permit: request_permit } = context;
    let client = match client_for(session, &upstream_url).await {
        Ok(client) => client,
        Err((status, message)) => return plain(status, &message),
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
    let upstream = match builder
        .header(header::ACCEPT_ENCODING, "identity")
        .timeout(Duration::from_secs(AJAX_STREAM_TIMEOUT_SECONDS))
        .body(request_body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            warn!(
                error = ?error,
                request_id = %request_id,
                url = %upstream_url,
                elapsed_ms = request_started.elapsed().as_millis(),
                "AJAX upstream request failed"
            );
            push_event(
                session,
                "ajax_error",
                upstream_url.path().to_owned(),
                format!("rid={request_id} upstream request failed"),
            ).await;
            return plain(StatusCode::BAD_GATEWAY, "AJAX upstream request failed");
        }
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let upstream_elapsed_ms = request_started.elapsed().as_millis();

    let mut response = Response::builder().status(status);
    let response_headers = response.headers_mut().expect("fresh response builder");
    response_headers.insert("origin-agent-cluster", HeaderValue::from_static("?1"));
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

    push_event(
        session,
        "ajax_response",
        upstream_url.path().to_owned(),
        format!("{} · headers in {}ms", status.as_u16(), upstream_elapsed_ms),
    ).await;
    debug!(
        method = %request_method,
        url = %upstream_url,
        status = %status,
        upstream_elapsed_ms,
        streaming = true,
        "AJAX passthrough response opened"
    );

    let stream_url = upstream_url.to_string();
    let body_stream = upstream.bytes_stream().map(move |chunk| {
        let _keep_request_slot = &request_permit;
        chunk.map_err(|error| {
            warn!(
                %error,
                request_id = %request_id,
                url = %stream_url,
                "AJAX upstream response stream failed"
            );
            io::Error::other(error)
        })
    });
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
    let body_stream = upstream.bytes_stream().map(move |chunk| {
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
    let worker_script = parts.headers.get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "worker" | "sharedworker" | "serviceworker"));
    push_event(
        &session,
        if ajax_request { "ajax_request" } else { "http_request" },
        upstream_url.path().to_owned(),
        format!("rid={request_id} method={}", parts.method),
    ).await;
    let body = match to_bytes(body, MAX_REQUEST_BODY).await {
        Ok(body) => body,
        Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request body exceeds the 8 MiB limit"),
    };

    let accept_html = parts.headers.get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"));
    let is_document = parts.headers.get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("document")) || accept_html;
    let bootstrap_document = parts.method == Method::GET
        && !ajax_request
        && is_document
        && upstream_url.path() == session.base_url.path()
        && session.bootstrap_pending.swap(false, Ordering::AcqRel);
    if should_hold_request(&session, &parts.method, &upstream_url, bootstrap_document) {
        wait_for_authorization(&session).await;
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
    let cache_hit = cached.is_some();

    let mut upstream_elapsed_ms = 0u128;
    let (upstream_status, upstream_headers, mut response_body) = if let Some(cached) = cached {
        (cached.status, cached.headers, cached.body)
    } else {
        let upstream_started = Instant::now();
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
                warn!(
                    error = ?error,
                    request_id = %request_id,
                    url = %upstream_url,
                    elapsed_ms = request_started.elapsed().as_millis(),
                    "Upstream request failed"
                );
                return plain(StatusCode::BAD_GATEWAY, "Upstream request failed");
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
        while let Some(next) = stream.next().await {
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
            if !bypass_cache {
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
        let rewrite_worker_script = worker_script;

        let rewrite_result = tokio::task::spawn_blocking(move || {
            // Keep the CPU concurrency bounded to the configured worker count.
            let _permit = permit;
            let mut body = body;
            let mut transformed = false;

            if let Ok(text) = std::str::from_utf8(&body) {
                if rewrite_content_type.contains("text/html") {
                    match rewrite_html(text, &rewrite_base, &rewrite_session_base, &rewrite_session_id) {
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
        "a[href],area[href],link[href],script[src],img[src],source[src],iframe[src],video[src],video[poster],audio[src],input[src],form[action],button[formaction],base[href],object[data],embed[src],track[src],[srcset],[style]",
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
<div id="intercept-notice">Browser navigation and form submissions are held until authorization. State-changing HTTP requests are enforced by Rust.</div>
<details id="intercept-events"><summary id="intercept-events-summary">EVENT STREAM · loading</summary><pre id="intercept-events-list">Waiting for browser and HTTP events…</pre></details>
</aside>"#;
        el.append(banner, ContentType::Html);
        Ok(())
    }));

    rewrite_str(&html_with_styles_and_scripts, settings).map_err(|error| error.to_string())
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
        return format!("/p/{session_id}");
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
          return prefix+path;
        }}
        if(url.origin===primaryOrigin)return prefix+path;
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

fn rewrite_csp(policy: &str, session_id: &str) -> String {
    let local_origin = proxy_origin(session_id);
    const DASHBOARD_ORIGIN: &str = "http://127.0.0.1:5000";
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
        .collect::<Vec<_>>()
        .join("; ")
}

fn should_skip_request_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host" | "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade" | "content-length"
            | "accept-encoding" | "x-intercept-proxy-mode"
    )
}

fn should_skip_response_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade" | "origin-agent-cluster"
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
            events: Mutex::new(VecDeque::new()),
            policy: AuthorizationPolicy::Standard,
            rules: Vec::new(),
            bootstrap_pending: AtomicBool::new(false),
            last_accessed_ms: AtomicU64::new(0),
            start_delay_nanos: AtomicU64::new(0),
            inflight: Arc::new(Semaphore::new(1)),
            max_inflight: 1,
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
            Some("http://session123.localhost:5000/p/session123/settings?tab=security".to_owned())
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
            "http://session123.localhost:5000/p/session123/account/settings?tab=security#sessions"
        );
    }

    #[test]
    fn session_url_preserves_root_query_and_fragment() {
        let target = Url::parse("https://example.com/?mode=compact#top").unwrap();
        assert_eq!(
            local_url(&target, "session123"),
            "http://session123.localhost:5000/p/session123/?mode=compact#top"
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
    fn authority_banner_restores_event_stream_and_notice() {
        let base = Url::parse("https://example.com/").unwrap();
        let html = r#"<!doctype html><html><head></head><body></body></html>"#;
        let result = rewrite_html(html, &base, &base, "session123").unwrap();
        assert!(result.contains("INTERCEPT AUTHORITY"));
        assert!(result.contains("intercept-events"));
        assert!(result.contains("intercept-notice"));
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
        assert!(result.contains("intercept-events"));
        assert!(result.contains("intercept-notice"));
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
        assert!(output.contains("/p/"));
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
}
