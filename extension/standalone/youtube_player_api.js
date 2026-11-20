(() => {
  "use strict";

  const KEY = "__standaloneYouTubePlayerApiV1";
  if (globalThis[KEY]) return;

  const PLAYER_STATE = Object.freeze({
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2,
    BUFFERING: 3,
    CUED: 5
  });
  const REQUIRED_METHODS = ["playVideo", "getPlayerState", "getCurrentTime"];

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function apiMethods(player) {
    if (!player || typeof player.getApiInterface !== "function") return null;
    try {
      const exposed = player.getApiInterface();
      return Array.isArray(exposed) && exposed.length
        ? new Set(exposed.filter(value => typeof value === "string"))
        : null;
    } catch (_) {
      return null;
    }
  }

  function supports(player, name, methods) {
    return typeof player[name] === "function" && (!methods || methods.has(name));
  }

  function readState(player) {
    try {
      const value = Number(player.getPlayerState());
      return Number.isFinite(value) ? value : NaN;
    } catch (_) {
      return NaN;
    }
  }

  function readTime(player) {
    try {
      const value = Number(player.getCurrentTime());
      return Number.isFinite(value) ? value : NaN;
    } catch (_) {
      return NaN;
    }
  }

  function readVideoId(player, methods) {
    if (!supports(player, "getVideoData", methods)) return "";
    try {
      const data = player.getVideoData();
      return String(data && (data.video_id || data.videoId) || "");
    } catch (_) {
      return "";
    }
  }

  function inspectPlayer(player, expectedVideoId) {
    if (!player || player.isConnected === false) return null;
    const methods = apiMethods(player);
    if (!REQUIRED_METHODS.every(name => supports(player, name, methods))) return null;

    const videoId = readVideoId(player, methods);
    if (expectedVideoId && videoId && videoId !== expectedVideoId) return null;

    const state = readState(player);
    if (!Number.isFinite(state)) return null;
    return {player, methods, videoId, state};
  }

  async function waitForPlayerApi(doc, expectedVideoId) {
    while (true) {
      const player = doc.getElementById("movie_player")
        || doc.querySelector("#movie_player");
      const api = inspectPlayer(player, expectedVideoId);
      if (api) return api;
      await delay(100);
    }
    // Keep waiting for YouTube's SPA/player to finish initializing, regardless of delay.
  }

  function subscribeToState(player, methods, callback) {
    if (!supports(player, "addEventListener", methods)) return () => {};
    const listener = event => {
      const value = event && typeof event === "object" && "data" in event
        ? event.data : event;
      const state = Number(value);
      if (Number.isFinite(state)) callback(state);
    };
    try {
      player.addEventListener("onStateChange", listener);
      return () => {
        if (!supports(player, "removeEventListener", methods)) return;
        try { player.removeEventListener("onStateChange", listener); } catch (_) {}
      };
    } catch (_) {
      return () => {};
    }
  }

  async function waitForPlaybackToAdvance(api, video, initialTime, lastEventState) {
    const player = api.player;
    while (true) {
      if (!video.isConnected) {
        throw new Error("YouTube replaced the video element while playback was starting.");
      }
      const reportedState = readState(player);
      const state = lastEventState.value === PLAYER_STATE.PLAYING
        ? PLAYER_STATE.PLAYING : reportedState;
      const playerTime = readTime(player);
      const mediaTime = Number(video.currentTime);
      const currentTime = Number.isFinite(playerTime) ? playerTime : mediaTime;

      if (state === PLAYER_STATE.PLAYING && !video.paused && !video.ended
          && Number.isFinite(currentTime) && currentTime > initialTime + 0.12) {
        return true;
      }
      if (video.error) {
        throw new Error("The YouTube player reported a media error while starting playback (code "
          + video.error.code + ").");
      }
      await delay(120);
    }
    return false;
  }

  async function startPlayback(api, video) {
    if (!api || !api.player || !video) {
      throw new Error("A ready YouTube player API and video element are required.");
    }

    const player = api.player;
    const methods = api.methods;
    const initialState = readState(player);
    if (initialState === PLAYER_STATE.PLAYING && !video.paused && !video.ended) {
      return {state: initialState, currentTime: readTime(player)};
    }

    const ended = initialState === PLAYER_STATE.ENDED || video.ended;
    const initialTime = ended ? 0 : readTime(player);
    const baseline = Number.isFinite(initialTime) ? initialTime : Number(video.currentTime) || 0;
    const lastEventState = {value: initialState};
    const unsubscribe = subscribeToState(player, methods, state => {
      lastEventState.value = state;
    });
    let commandError = null;
    let mediaError = null;

    try {
      if (supports(player, "wakeUpControls", methods)) {
        try { player.wakeUpControls(); } catch (_) {}
      }

      try {
        const result = player.playVideo();
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(error => { commandError = error; });
        }
      } catch (error) {
        commandError = error;
      }

      // Let YouTube's own player pipeline react before using the HTMLMediaElement fallback.
      await delay(250);
      if (video.paused || video.ended || readState(player) !== PLAYER_STATE.PLAYING) {
        if (typeof video.play === "function") {
          try {
            const result = video.play();
            if (result && typeof result.then === "function") {
              await Promise.resolve(result);
            }
          } catch (error) {
            mediaError = error;
            if (error && (error.name === "NotAllowedError"
                || /not allowed|autoplay/i.test(String(error.message || error)))) {
              throw new Error(
                "Firefox blocked automatic YouTube playback (NotAllowedError). " +
                "Allow Audio and Video for youtube.com in Firefox Settings > Privacy & Security > Permissions > Autoplay. " +
                String(error.message || error)
              );
            }
          }
        }
      }

      const advanced = await waitForPlaybackToAdvance(
        api, video, baseline, lastEventState
      );
      if (!advanced) {
        const failure = mediaError || commandError;
        if (failure && (failure.name === "NotAllowedError"
            || /not allowed|autoplay/i.test(String(failure.message || failure)))) {
          throw new Error(
            "Firefox blocked automatic YouTube playback (NotAllowedError). " +
            "Allow Audio and Video for youtube.com in Firefox Settings > Privacy & Security > Permissions > Autoplay. " +
            String(failure.message || failure)
          );
        }
        throw new Error(
          "YouTube's player API did not reach PLAYING with advancing time. Current player state: "
          + String(readState(player)) + ". "
          + String(failure && failure.message || failure || "No playback progress was reported.")
        );
      }

      return {state: readState(player), currentTime: readTime(player), videoId: api.videoId};
    } finally {
      unsubscribe();
    }
  }

  globalThis[KEY] = Object.freeze({
    PLAYER_STATE,
    waitForPlayerApi,
    startPlayback
  });
})();