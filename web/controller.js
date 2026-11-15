(() => {
  "use strict";

  const script = document.currentScript;
  const sessionId = script && script.dataset.session;
  if (!sessionId) return;

  const api = suffix => "/api/sessions/" + encodeURIComponent(sessionId) + suffix;
  const stateNode = () => document.getElementById("intercept-state");
  const countdownNode = () => document.getElementById("intercept-countdown");
  const delayInput = () => document.getElementById("intercept-delay");
  const startButton = () => document.getElementById("intercept-start");

  async function pollStatus() {
    try {
      const response = await fetch(api("/status"), { cache: "no-store" });
      if (!response.ok) throw new Error("status " + response.status);
      const data = await response.json();

      const state = data.state;
      const status = stateNode();
      const countdown = countdownNode();
      const button = startButton();
      const input = delayInput();

      if (status) {
        status.textContent = state === "waiting" ? "WAITING" :
          state === "running" ? "AUTHORIZATION COUNTDOWN" : "AUTHORIZED";
      }
      if (countdown) {
        countdown.textContent = state === "waiting" ? "NOT STARTED" :
          state === "released" ? "00:00.00" :
          (Math.ceil((data.remaining_ms || 0) / 10) / 100).toFixed(2) + "s";
      }
      if (button) button.disabled = state !== "waiting";
      if (input) input.disabled = state !== "waiting";
    } catch (error) {
      const status = stateNode();
      const countdown = countdownNode();
      if (status) status.textContent = "SERVICE UNAVAILABLE";
      if (countdown) countdown.textContent = String(error.message || error).slice(0, 80);
    }
  }

  document.addEventListener("click", async event => {
    const target = event.target;
    const button = target instanceof Element ? target.closest("#intercept-start") : null;
    if (!button || button.disabled) return;

    const seconds = Number(delayInput() && delayInput().value);
    if (!Number.isFinite(seconds) || seconds < 0.000000001 || seconds > 86400) {
      const status = stateNode();
      if (status) status.textContent = "INVALID DELAY";
      return;
    }

    button.disabled = true;
    try {
      const response = await fetch(api("/start"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delay_seconds: seconds })
      });
      if (!response.ok) throw new Error(await response.text() || "Timer could not start");
      await pollStatus();
    } catch (error) {
      const status = stateNode();
      const countdown = countdownNode();
      if (status) status.textContent = "START FAILED";
      if (countdown) countdown.textContent = String(error.message || error).slice(0, 80);
      button.disabled = false;
    }
  });

  pollStatus();
  window.setInterval(pollStatus, 200);
})();
