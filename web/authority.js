(() => {
  "use strict";

  const sessionId = document.documentElement.dataset.session;
  if (!sessionId) return;

  const apiPrefix = "/api/sessions/" + encodeURIComponent(sessionId);
  const stateNode = document.getElementById("state");
  const countdownNode = document.getElementById("countdown");
  const delayInput = document.getElementById("delay");
  const startButton = document.getElementById("start");
  const noticeNode = document.getElementById("notice");
  const eventsNode = document.getElementById("events");
  const eventSummary = document.getElementById("event-summary");
  const metricsNode = document.getElementById("metrics");
  const resizeButton = document.getElementById("resize-panel");
  const eventPanel = document.getElementById("event-panel");
  let panelExpanded = false;

  function setPanelExpanded(expanded) {
    panelExpanded = Boolean(expanded);
    eventPanel.open = panelExpanded;
    resizeButton.textContent = panelExpanded ? "[COLLAPSE ▼]" : "[EXPAND ▲]";
    resizeButton.setAttribute("aria-expanded", String(panelExpanded));
    resizeButton.setAttribute("aria-label", panelExpanded
      ? "Collapse authority panel to the bottom bar"
      : "Expand authority panel to half the screen");
    window.parent.postMessage({
      type: "intercept:authority-resize",
      session_id: sessionId,
      expanded: panelExpanded
    }, "http://" + sessionId + ".localhost:5000");
  }

  resizeButton.addEventListener("click", () => setPanelExpanded(!panelExpanded));

  let gateState = "waiting";
  let lastRelayedState = null;
  let countdownDeadline = 0;
  let startInFlight = false;
  let statusPollInFlight = false;
  let eventsPollInFlight = false;
  let metricsPollInFlight = false;

  async function controlFetch(suffix, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(apiPrefix + suffix, {
        ...options,
        cache: "no-store",
        signal: controller.signal
      });
      // The watchdog includes body consumption, not just response headers.
      const body = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        body,
        json: () => body ? JSON.parse(body) : null
      };
    } catch (error) {
      if (timedOut) throw new Error("control request timed out after " + timeoutMs + " ms");
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function renderGateState() {
    stateNode.textContent = gateState === "waiting" ? "WAITING"
      : gateState === "running" ? "AUTHORIZATION COUNTDOWN" : "AUTHORIZED";
    startButton.disabled = gateState !== "waiting" || startInFlight;
    delayInput.disabled = gateState !== "waiting" || startInFlight;
  }

  function applyStatus(data) {
    if (!data || !["waiting", "running", "released"].includes(data.state)) {
      throw new Error("invalid status response");
    }
    gateState = data.state;
    countdownDeadline = gateState === "running"
      ? performance.now() + Math.max(0, Number(data.remaining_ms) || 0)
      : 0;
    renderGateState();
    updateCountdown();
    // Relay state only on the initial status and actual transitions. The
    // status endpoint is polled frequently to keep the countdown accurate;
    // forwarding every unchanged poll only creates redundant parent messages.
    if (lastRelayedState !== gateState) {
      lastRelayedState = gateState;
      window.parent.postMessage({
        type: "intercept:authority-status",
        session_id: sessionId,
        state: gateState,
        remaining_ms: Number(data.remaining_ms) || 0
      }, "http://" + sessionId + ".localhost:5000");
    }
  }

  function updateCountdown() {
    if (gateState === "waiting") {
      countdownNode.textContent = "NOT STARTED";
    } else if (gateState === "released") {
      countdownNode.textContent = "00:00.00";
    } else if (!countdownDeadline) {
      countdownNode.textContent = "SYNCING…";
    } else {
      const remaining = Math.max(0, countdownDeadline - performance.now());
      countdownNode.textContent = (Math.ceil(remaining / 10) / 100).toFixed(2) + "s";
    }
  }

  async function pollStatus() {
    if (statusPollInFlight) return;
    statusPollInFlight = true;
    try {
      const response = await controlFetch("/status");
      if (!response.ok) throw new Error(response.body || "status " + response.status);
      applyStatus(response.json());
      if (gateState !== "running") {
        noticeNode.textContent = gateState === "waiting"
          ? "State-changing requests are held by Rust until the timer authorizes them."
          : "Timer complete. State-changing requests are authorized.";
      }
    } catch (error) {
      stateNode.textContent = "CONTROL LINK DEGRADED";
      noticeNode.textContent = String(error.message || error).slice(0, 180);
    } finally {
      statusPollInFlight = false;
    }
  }

  async function pollEvents() {
    if (eventsPollInFlight) return;
    eventsPollInFlight = true;
    try {
      const response = await controlFetch("/events");
      if (!response.ok) throw new Error("events " + response.status);
      const events = response.json() || [];
      eventSummary.textContent = "EVENT STREAM · " + events.length + " retained";
      eventsNode.textContent = events.slice(-30).reverse().map(item => {
        const time = new Date(Number(item.at_unix_ms)).toLocaleTimeString();
        return "[" + time + "] " + item.kind + " · " + item.detail + " · " + item.target;
      }).join("\n") || "No events recorded yet.";
    } catch (_) {
      // Event history is observational and must never interfere with the timer.
    } finally {
      eventsPollInFlight = false;
    }
  }

  async function pollMetrics() {
    if (metricsPollInFlight) return;
    metricsPollInFlight = true;
    try {
      const response = await controlFetch("/metrics");
      if (!response.ok) throw new Error("metrics " + response.status);
      const metrics = response.json();
      const cached = (Number(metrics.cached_bytes) / (1024 * 1024)).toFixed(1);
      metricsNode.textContent = "POLICY " + String(metrics.policy).toUpperCase()
        + " · CACHE " + cached + " MiB · ORIGINS " + metrics.upstream_origins
        + " · ACTIVE " + metrics.active_requests + "/" + metrics.max_inflight_requests
        + " · LAST ACTIVITY " + Math.round(metrics.last_activity_ago_ms / 1000) + "s";
    } catch (_) {
      metricsNode.textContent = "Resource metrics temporarily unavailable.";
    } finally {
      metricsPollInFlight = false;
    }
  }

  const expectedParentOrigin = "http://" + sessionId + ".localhost:5000";
  let readyAcknowledged = false;
  let readyRetryTimer = null;

  window.addEventListener("message", event => {
    const data = event.data;
    if (event.origin !== expectedParentOrigin
        || event.source !== window.parent
        || !data
        || data.session_id !== sessionId) {
      return;
    }

    if (data.type === "intercept:authority-ack") {
      readyAcknowledged = true;
      if (readyRetryTimer !== null) {
        window.clearInterval(readyRetryTimer);
        readyRetryTimer = null;
      }
      return;
    }

    if (data.type === "intercept:notice") {
      noticeNode.textContent = String(data.message || "").slice(0, 500);
    }
  });

  startButton.addEventListener("click", async () => {
    if (startButton.disabled || startInFlight) return;
    const seconds = Number(delayInput.value);
    if (!Number.isFinite(seconds) || seconds < 0.000000001 || seconds > 86400) {
      stateNode.textContent = "INVALID DELAY";
      noticeNode.textContent = "Enter a value from 0.000000001 to 86400 seconds.";
      return;
    }

    startInFlight = true;
    renderGateState();
    stateNode.textContent = "START REQUEST SENT";
    noticeNode.textContent = "START CLICK RECEIVED · contacting the Rust authority service…";
    try {
      const response = await controlFetch("/start", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({delay_seconds: seconds})
      }, 10000);
      if (!response.ok) throw new Error(response.body || "Timer start rejected");
      applyStatus(response.json());
      noticeNode.textContent = "SERVER ACCEPTED · Rust owns the authorization deadline.";
    } catch (error) {
      stateNode.textContent = "START NOT CONFIRMED";
      noticeNode.textContent = String(error.message || error).slice(0, 180);
      // The server may have accepted the request before a connection failed.
      // Reconcile status; repeated starts with the same delay are idempotent.
      await pollStatus();
    } finally {
      startInFlight = false;
      renderGateState();
    }
  });

  pollStatus();
  pollEvents();
  pollMetrics();
  window.setInterval(pollStatus, 500);
  window.setInterval(pollEvents, 1800);
  window.setInterval(pollMetrics, 3000);
  window.setInterval(updateCountdown, 100);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pollStatus();
      pollEvents();
      pollMetrics();
    }
  });

  // The embedding controller uses this handshake to distinguish an iframe
  // that merely fired "load" from one whose authority UI actually initialized.
  function announceAuthorityReady() {
    window.parent.postMessage({
      type: "intercept:authority-ready",
      session_id: sessionId
    }, expectedParentOrigin);
  }

  // The parent acknowledges this message. Re-send until acknowledged so a
  // lost early message or a parent-side initialization race cannot strand the
  // toolbar in its "FRAME NOT RESPONDING" fallback state.
  announceAuthorityReady();
  readyRetryTimer = window.setInterval(() => {
    if (!readyAcknowledged) announceAuthorityReady();
  }, 750);
})();
