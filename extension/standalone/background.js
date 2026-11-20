"use strict";

const downloadJobs = new Map();
const captureJobs = new Map();
const captureQueue = [];
const MAX_PARALLEL_CAPTURE_JOBS = 1;
const ACTIVE_CAPTURE_STATES = new Set(["opening", "starting", "awaiting_autoplay", "awaiting_retry", "recording", "saving", "download_queued", "downloading"]);
const pendingDownloadQueue = [];
let activeDownloadId = null;
let downloadQueueStarting = false;
const CAPTURE_STATE_STORAGE_KEY = "playbackCaptureQueueV1";
let captureRestorePromise = null;
let capturePersistChain = Promise.resolve();
let capturePumpRunning = false;

function safeFilename(value) {
  let filename = String(value || "youtube-playback.webm");
  const invalid = ["<", ">", ":", String.fromCharCode(34), "/", String.fromCharCode(92), "|", "?", "*"];
  for (const character of invalid) filename = filename.split(character).join("_");
  filename = Array.from(filename, character => character.charCodeAt(0) < 32 ? "_" : character)
    .join("").trim().slice(0, 140);
  if (!filename) filename = "youtube-playback";
  return filename.toLowerCase().endsWith(".webm") ? filename : filename + ".webm";
}

function persistCaptureState() {
  if (!browser.storage || !browser.storage.local) return Promise.resolve();
  capturePersistChain = capturePersistChain.catch(() => {}).then(() => {
    const snapshot = {
      version: 1,
      queue: captureQueue.slice(),
      jobs: Array.from(captureJobs.values()).map(job => ({...job}))
    };
    return browser.storage.local.set({[CAPTURE_STATE_STORAGE_KEY]: snapshot});
  }).catch(error => {
    console.error("[Playback Capture] Could not persist the recording queue:", error);
  });
  return capturePersistChain;
}

async function ensureCaptureStateRestored() {
  if (captureRestorePromise) return captureRestorePromise;
  captureRestorePromise = (async () => {
    if (!browser.storage || !browser.storage.local) return;
    const saved = await browser.storage.local.get(CAPTURE_STATE_STORAGE_KEY).catch(() => ({}));
    const stored = saved && saved[CAPTURE_STATE_STORAGE_KEY];
    if (!stored || stored.version !== 1 || !Array.isArray(stored.jobs)) return;

    captureJobs.clear();
    captureQueue.length = 0;
    for (const raw of stored.jobs) {
      if (!raw || typeof raw.id !== "string" || typeof raw.videoId !== "string") continue;
      const job = {...raw, slot: false};
      const needsTab = ["opening", "starting", "awaiting_autoplay", "awaiting_retry", "recording", "saving", "download_queued", "downloading"].includes(job.state);
      const tab = needsTab && Number.isInteger(job.tabId)
        ? await browser.tabs.get(job.tabId).catch(() => null)
        : null;

      if (["opening", "starting"].includes(job.state)) {
        job.state = "queued";
        job.phase = tab ? "Resuming queued capture in its existing inactive tab" : "Restored from the saved recording queue";
        if (!tab) { job.tabId = null; job.ownedTab = false; }
      } else if (["awaiting_autoplay", "awaiting_retry"].includes(job.state)) {
        if (tab) job.slot = true;
        else {
          job.state = "queued";
          job.phase = "Reopening capture tab after it was closed";
          job.tabId = null;
          job.ownedTab = false;
        }
      } else if (["recording", "saving", "download_queued", "downloading"].includes(job.state)) {
        if (tab) job.slot = true;
        else {
          job.state = "interrupted";
          job.phase = "Helper tab closed while capture was in progress";
          job.error = "The helper tab closed before this queued capture finished. Its temporary file may be recoverable from capture history.";
          job.completedAt = Date.now();
        }
      }
      captureJobs.set(job.id, job);
    }

    const queuedIds = Array.isArray(stored.queue) ? stored.queue : [];
    const queuedSet = new Set();
    for (const id of queuedIds) {
      const job = captureJobs.get(id);
      if (job && job.state === "queued" && !queuedSet.has(id)) {
        captureQueue.push(id);
        queuedSet.add(id);
      }
    }
    for (const job of Array.from(captureJobs.values()).sort((a,b) => a.createdAt-b.createdAt)) {
      if (job.state === "queued" && !queuedSet.has(job.id)) {
        captureQueue.push(job.id);
        queuedSet.add(job.id);
      }
    }

    // Reconcile a download that was already handed to Firefox before the
    // background context was restarted. It remains the only active download.
    for (const job of captureJobs.values()) {
      if (job.state !== "downloading" || !Number.isInteger(job.downloadId)) continue;
      const found = await browser.downloads.search({id: job.downloadId}).catch(() => []);
      const download = found && found[0];
      if (download && ["in_progress", "queued"].includes(download.state)) {
        activeDownloadId = job.downloadId;
      } else if (download && ["complete", "interrupted"].includes(download.state)) {
        finishJob(job.downloadId, download.state);
      } else if (job.tabId && job.captureId) {
        job.state = "download_queued";
        job.phase = "Rebuilding the download handoff from the saved WebM";
      }
    }
    await persistCaptureState();
  })().catch(error => {
    console.error("[Playback Capture] Could not restore the recording queue:", error);
  });
  return captureRestorePromise;
}

function finishJob(downloadId, state) {
  const downloadJob = downloadJobs.get(downloadId) || null;
  if (downloadJob) {
    downloadJobs.delete(downloadId);
    try { URL.revokeObjectURL(downloadJob.objectUrl); } catch (_) {}
    try { downloadJob.port.postMessage({type: "playback-download:finished", state, download_id: downloadId, capture_id: downloadJob.captureId, request_id: downloadJob.requestId}); } catch (_) {}
    try { downloadJob.port.disconnect(); } catch (_) {}
  }
  const captureJob = Array.from(captureJobs.values()).find(item =>
    item.downloadId === downloadId || (downloadJob && item.tabId === downloadJob.captureTabId
      && (!item.captureId || item.captureId === downloadJob.captureId))
  );
  if (activeDownloadId === downloadId) activeDownloadId = null;
  if (captureJob) {
    captureJob.state = state === "complete" ? "completed" : "failed";
    captureJob.error = state === "complete" ? null : "Firefox interrupted the WebM download.";
    captureJob.downloadId = downloadId;
    captureJob.completedAt = Date.now();
    captureJob.updatedAt = Date.now();
    captureJob.slot = false;
    if (captureJob.ownedTab && Number.isInteger(captureJob.tabId)) {
      setTimeout(() => { void browser.tabs.remove(captureJob.tabId).catch(() => {}); }, 1200);
    }
    void persistCaptureState();
    void pumpCaptureQueue();
  }
  void pumpDownloadQueue();
}

browser.downloads.onChanged.addListener(delta => {
  if (!delta || !delta.state) return;
  if (delta.state.current === "complete" || delta.state.current === "interrupted") {
    void ensureCaptureStateRestored().then(() => finishJob(delta.id, delta.state.current));
  }
});

browser.runtime.onConnect.addListener(port => {
  if (!port || port.name !== "standalone-playback-download") return;
  const senderUrl = (() => {
    try { return new URL(port.sender && port.sender.url || ""); }
    catch (_) { return null; }
  })();
  const senderHost = senderUrl ? senderUrl.hostname.toLowerCase() : "";
  const captureTabId = port.sender && port.sender.tab && Number.isInteger(port.sender.tab.id) ? port.sender.tab.id : null;
  const trustedSender = !!senderUrl
    && senderUrl.protocol === "https:"
    && (senderHost === "youtube.com" || senderHost.endsWith(".youtube.com"))
    && port.sender && port.sender.frameId === 0;

  let accepted = false;
  port.onMessage.addListener(async message => {
    if (accepted || !message || message.type !== "start") return;
    accepted = true;
    try {
      await ensureCaptureStateRestored();
      if (!trustedSender) {
        throw new Error("Downloads are accepted only from a top-level HTTPS YouTube page.");
      }
      const blob = message.blob;
      if (!blob || typeof blob.size !== "number"
          || typeof blob.slice !== "function"
          || typeof blob.type !== "string"
          || !blob.type.toLowerCase().startsWith("video/webm")
          || blob.size <= 0
          || blob.size > 2 * 1024 * 1024 * 1024) {
        throw new Error("The captured WebM file has an invalid type or size.");
      }

      const captureJob = Array.from(captureJobs.values()).find(item => item.tabId === captureTabId && (!item.captureId || item.captureId === message.capture_id));
      if (captureJob) {
        captureJob.captureId = message.capture_id || captureJob.captureId;
        captureJob.state = "download_queued";
        captureJob.phase = "Waiting for the previous WebM download to finish";
        captureJob.updatedAt = Date.now();
        await persistCaptureState();
      }
      pendingDownloadQueue.push({
        blob,
        filename: safeFilename(message.filename),
        port,
        captureId: message.capture_id || null,
        requestId: message.request_id || null,
        captureTabId
      });
      void pumpDownloadQueue();
    } catch (error) {
      try {
        port.postMessage({
          type: "playback-download:failed",
          error: String(error && error.message || error || "Firefox could not start the download.")
        });
      } catch (_) {}
      try { port.disconnect(); } catch (_) {}
    }
  });
});




async function pumpDownloadQueue() {
  if (activeDownloadId !== null || downloadQueueStarting || pendingDownloadQueue.length === 0) return;
  downloadQueueStarting = true;
  const item = pendingDownloadQueue.shift();
  let objectUrl = null;
  let downloadId = null;
  try {
    objectUrl = URL.createObjectURL(item.blob);
    downloadId = await browser.downloads.download({
      url: objectUrl,
      filename: item.filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    activeDownloadId = downloadId;
    downloadJobs.set(downloadId, {
      objectUrl,
      port: item.port,
      captureId: item.captureId,
      requestId: item.requestId,
      captureTabId: item.captureTabId
    });
    const captureJob = Array.from(captureJobs.values()).find(job =>
      job.tabId === item.captureTabId && (!job.captureId || job.captureId === item.captureId)
    );
    if (captureJob) {
      captureJob.state = "downloading";
      captureJob.phase = "Firefox is downloading this WebM";
      captureJob.downloadId = downloadId;
      captureJob.updatedAt = Date.now();
      await persistCaptureState();
    }
    // Once Firefox returns a download ID, keep the single-download lock until
    // downloads.onChanged reports completion or interruption. A disconnected page
    // must never release the lock and allow another download to overlap this one.
    try { item.port.postMessage({type: "playback-download:started", download_id: downloadId}); } catch (_) {}
    const matches = await browser.downloads.search({id: downloadId}).catch(() => []);
    const found = matches && matches[0];
    if (found && (found.state === "complete" || found.state === "interrupted")) {
      finishJob(downloadId, found.state);
    }
  } catch (error) {
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch (_) {}
    }
    const message = String(error && error.message || error || "Firefox could not start the queued WebM download.");
    try { item.port.postMessage({type: "playback-download:failed", error: message}); } catch (_) {}
    try { item.port.disconnect(); } catch (_) {}
    const captureJob = Array.from(captureJobs.values()).find(job => job.tabId === item.captureTabId);
    if (captureJob) {
      captureJob.state = "failed";
      captureJob.phase = "Download start failed";
      captureJob.error = message;
      captureJob.completedAt = Date.now();
      captureJob.updatedAt = Date.now();
      captureJob.slot = false;
      if (captureJob.ownedTab && Number.isInteger(captureJob.tabId)) {
        void browser.tabs.remove(captureJob.tabId).catch(() => {});
      }
      void persistCaptureState();
      void pumpCaptureQueue();
    }
    if (downloadId !== null && activeDownloadId === downloadId) activeDownloadId = null;
  } finally {
    downloadQueueStarting = false;
    if (activeDownloadId === null) void pumpDownloadQueue();
  }
}

function makeJobId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function publicCaptureJob(job) {
  return {id:job.id,videoId:job.videoId,title:job.title,url:job.url,selectedUrl:job.selectedUrl||job.url,
    selectedPath:job.selectedPath||null,sourceUrl:job.sourceUrl||null,sourcePath:job.sourcePath||null,
    state:job.state,phase:job.phase||null,queuePosition:job.queuePosition||null,
    createdAt:job.createdAt,updatedAt:job.updatedAt,startedAt:job.startedAt||null,
    completedAt:job.completedAt||null,downloadId:job.downloadId||null,error:job.error||null};
}

function captureJobSnapshot() {
  return Array.from(captureJobs.values()).sort((a,b)=>a.createdAt-b.createdAt).map((job,index)=>publicCaptureJob({
    ...job,queuePosition:job.state==="queued"?captureQueue.indexOf(job.id)+1:null
  }));
}

function activeCaptureSlots() {
  return Array.from(captureJobs.values()).filter(job=>job.slot && ACTIVE_CAPTURE_STATES.has(job.state)).length;
}

async function waitForTabComplete(tabId, timeoutMs=45000) {
  const started=Date.now();
  while(Date.now()-started<timeoutMs) {
    const tab=await browser.tabs.get(tabId).catch(()=>null);
    if(!tab) throw new Error("The background YouTube tab was closed before it finished loading.");
    if(tab.status==="complete") return;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error("The selected YouTube video took too long to load in its background tab.");
}

async function runCaptureCommand(tabId, command, payload) {
  const target={tabId};
  const readiness=await browser.scripting.executeScript({
    target,world:"MAIN",
    func:function(){return {core:!!globalThis.__standalonePlaybackCoreV1,playerApi:!!globalThis.__standaloneYouTubePlayerApiV1,runtime:!!globalThis.__standalonePlaybackDownloadV1};}
  });
  const ready=readiness&&readiness[0]&&readiness[0].result||{};
  if(!ready.core) await browser.scripting.executeScript({target,world:"MAIN",files:["capture_core.js"]});
  if(!ready.playerApi) await browser.scripting.executeScript({target,world:"MAIN",files:["youtube_player_api.js"]});
  if(!ready.runtime) await browser.scripting.executeScript({target,world:"MAIN",files:["video_download.js"]});
  const results=await browser.scripting.executeScript({
    target,world:"MAIN",
    func:async function(commandName,commandPayload){
      const api=globalThis.__standalonePlaybackDownloadV1;
      if(!api||typeof api.runCommand!=="function") return {ok:false,error:"The YouTube capture runtime did not initialize."};
      try{return {ok:true,result:await api.runCommand(commandName,commandPayload)};}
      catch(error){return {ok:false,error:String(error&&error.message||error||"Capture command failed.")};}
    },
    args:[command,payload]
  });
  const result=results&&results[0]&&results[0].result;
  if(!result||!result.ok) throw new Error(result&&result.error||"The YouTube player did not acknowledge the capture command.");
  return result.result;
}

async function launchCaptureJob(job) {
  job.slot=true;
  job.state="opening";
  job.phase="Opening the inactive YouTube tab";
  job.updatedAt=Date.now();
  void persistCaptureState();
  try {
    if(job.currentTab) {
      job.tabId=job.sourceTabId;
    } else {
      const existingTab = job.ownedTab && Number.isInteger(job.tabId)
        ? await browser.tabs.get(job.tabId).catch(()=>null)
        : null;
      if(existingTab) {
        job.phase="Reusing the inactive YouTube tab after autoplay was enabled";
        job.updatedAt=Date.now();
        await waitForTabComplete(existingTab.id);
      } else {
        const targetUrl = job.url + (job.url.includes("?") ? "&" : "?") + "__playback_capture_job=1";
        const tab=await browser.tabs.create({url:targetUrl,active:false});
        job.tabId=tab.id;
        job.ownedTab=true;
        job.phase="Waiting for YouTube's window load event";
        job.updatedAt=Date.now();
        await persistCaptureState();
        await waitForTabComplete(tab.id);
      }
    }
    job.state="starting";
    job.phase="Activating helper tab and waiting for the YouTube Play control";
    job.updatedAt=Date.now();
    await persistCaptureState();

    // Firefox blocks background-tab autoplay by default. Briefly activate the
    // helper so the player can initialize and its Play control can be targeted.
    // Restore the user's active tab immediately after the recorder is confirmed.
    const activeBefore = await browser.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[]);
    const returnTabId = activeBefore[0] && activeBefore[0].id !== job.tabId
      ? activeBefore[0].id : null;
    let helperActivated = false;
    try {
      const helper = await browser.tabs.get(job.tabId);
      if (!helper.active) {
        await browser.tabs.update(job.tabId,{active:true});
        helperActivated = true;
      }
      job.phase="Starting with YouTube player API: wakeUpControls -> playVideo";
      job.updatedAt=Date.now();
      await persistCaptureState();

      let result = null;
      let startupError = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        let timeoutId = null;
        try {
          const startup = runCaptureCommand(job.tabId,"record-video",{videoId:job.videoId,title:job.title});
          result = await Promise.race([
            startup,
            new Promise((_,reject) => {
              timeoutId = setTimeout(() => reject(new Error(
                "Startup timed out after 150 seconds. YouTube did not begin playback or MediaRecorder did not initialize."
              )),150000);
            })
          ]);
          startupError = null;
          break;
        } catch (error) {
          startupError = error;
          const detail = String(error && error.message || error || "");
          const autoplayBlocked = /NotAllowedError|autoplay permission|autoplay is blocked/i.test(detail);
          if (attempt >= 2 || autoplayBlocked) break;
          job.phase = "YouTube player is still initializing; retrying in the same helper tab (attempt 2 of 2)";
          job.error = detail;
          job.updatedAt = Date.now();
          await persistCaptureState();
          await new Promise(resolve => setTimeout(resolve, 1200));
          const stillOpen = await browser.tabs.get(job.tabId).catch(()=>null);
          if (!stillOpen) throw error;
          if (!stillOpen.active) await browser.tabs.update(job.tabId,{active:true});
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
        }
      }
      if (startupError) throw startupError;
      job.captureId=result&&result.capture_id||null;
      job.startedAt=Date.now();
      job.state="recording";
      job.phase="Recording confirmed; helper tab will return to the background";
      job.error=null;
      job.updatedAt=Date.now();
      await persistCaptureState();
      if(job.stopRequested) await stopCaptureJob({job_id:job.id});
    } finally {
      if (helperActivated && Number.isInteger(returnTabId)) {
        const activeNow = await browser.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[]);
        // Do not override a user's own tab switch made while the player was starting.
        if (activeNow[0] && activeNow[0].id === job.tabId) {
          await browser.tabs.update(returnTabId,{active:true}).catch(()=>{});
        }
      }
    }
  } catch(error) {
    job.error=String(error&&error.message||error||"Could not start this capture.");
    job.updatedAt=Date.now();
    const autoplayBlocked = /NotAllowedError|background playback|autoplay permission|autoplay is blocked/i.test(job.error);
    const helperTab = job.ownedTab && Number.isInteger(job.tabId)
      ? await browser.tabs.get(job.tabId).catch(()=>null) : null;
    if (job.stopRequested) {
      job.state="cancelled";
      job.phase="Cancelled while playback was starting";
      job.completedAt=Date.now();
      job.slot=false;
      if (helperTab) await browser.tabs.remove(job.tabId).catch(()=>{});
    } else if (helperTab) {
      // Preserve the warmed YouTube player after a transient startup failure.
      // The REC button can retry against this same tab instead of opening a new one.
      job.state=autoplayBlocked ? "awaiting_autoplay" : "awaiting_retry";
      job.phase=autoplayBlocked
        ? "Firefox blocked autoplay; enable Allow Audio and Video for youtube.com, then click ALLOW PLAY"
        : "Startup did not complete; helper tab retained. Click RETRY to resume this same selection";
      job.slot=true;
    } else {
      job.state="failed";
      job.phase="Startup failed";
      job.completedAt=Date.now();
      job.slot=false;
      if(Number.isInteger(job.tabId) && !job.ownedTab) {
        await runCaptureCommand(job.tabId,"stop",null).catch(()=>{});
      }
      job.tabId=null;
    }
    await persistCaptureState();
    void pumpCaptureQueue();
  }
}

async function pumpCaptureQueue() {
  await ensureCaptureStateRestored();
  if (capturePumpRunning) return;
  capturePumpRunning = true;
  try {
    while(activeCaptureSlots()<MAX_PARALLEL_CAPTURE_JOBS&&captureQueue.length) {
      const id=captureQueue.shift();
      const job=captureJobs.get(id);
      if(!job||job.state!=="queued") continue;
      void persistCaptureState();
      // launchCaptureJob claims the sole worker slot synchronously before its
      // first await, so browsing clicks can safely append while this runs.
      void launchCaptureJob(job);
      break;
    }
  } finally {
    capturePumpRunning = false;
  }
}

async function startInlineCapture(message,sender) {
  await ensureCaptureStateRestored();
  const senderUrl=(()=>{try{return new URL(sender&&sender.url||"");}catch(_){return null;}})();
  const trusted=!!senderUrl&&senderUrl.protocol==="https:"
    &&senderUrl.hostname.toLowerCase()==="www.youtube.com"
    &&(!senderUrl.port||senderUrl.port==="443")
    &&sender&&sender.frameId===0&&sender.tab&&Number.isInteger(sender.tab.id);
  const videoId=String(message.video_id||"");
  if(!trusted) throw new Error("Per-video recording is available only from a top-level www.youtube.com page.");
  if(!/^[A-Za-z0-9_-]{1,24}$/.test(videoId)) throw new Error("The selected YouTube video ID is invalid.");
  const blocked=Array.from(captureJobs.values()).find(job =>
    job.videoId===videoId && ["awaiting_autoplay","awaiting_retry"].includes(job.state)
      && job.ownedTab && Number.isInteger(job.tabId)
  );
  if(blocked) {
    const tab=await browser.tabs.get(blocked.tabId).catch(()=>null);
    if(tab) {
      const retryingAutoplayBlock = blocked.state === "awaiting_autoplay";
      blocked.state="queued";
      blocked.phase=retryingAutoplayBlock
        ? "Retrying after YouTube autoplay permission was changed"
        : "Retrying playback in the retained YouTube helper tab";
      blocked.error=null;
      blocked.slot=false;
      blocked.updatedAt=Date.now();
      if(!captureQueue.includes(blocked.id)) captureQueue.unshift(blocked.id);
      await persistCaptureState();
      void pumpCaptureQueue();
      return publicCaptureJob(blocked);
    }
    blocked.state="failed";
    blocked.phase="The helper tab was closed";
    blocked.error="The inactive YouTube helper tab was closed. Click REC to open a fresh one.";
    blocked.completedAt=Date.now();
    blocked.updatedAt=Date.now();
    blocked.tabId=null;
  }
  const existing=Array.from(captureJobs.values()).find(job =>
    job.videoId===videoId&&!["completed","failed","cancelled","interrupted"].includes(job.state)
  );
  if(existing) return publicCaptureJob(existing);
  const title=String(message.title||"YouTube video").replace(/\s+/g," ").trim().slice(0,180)||"YouTube video";
  const canonicalUrl="https://www.youtube.com/watch?v="+videoId;
  let selectedUrl=canonicalUrl;
  try {
    const candidate=new URL(String(message.video_url||canonicalUrl),senderUrl.href);
    const candidateHost=candidate.hostname.toLowerCase();
    const pathId=candidate.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{1,24})/);
    const candidateId=candidate.searchParams.get("v")||(pathId&&pathId[1])||"";
    if(candidate.protocol==="https:"&&candidateHost==="www.youtube.com"&&candidateId===videoId) selectedUrl=candidate.href;
  } catch (_) {}
  const sourceUrl=senderUrl.href;
  const sourcePath=senderUrl.pathname+(senderUrl.search||"");
  const selectedPath=new URL(selectedUrl).pathname+(new URL(selectedUrl).search||"");
  const job={
    id:makeJobId(),videoId,title,url:canonicalUrl,selectedUrl,selectedPath,
    sourceUrl,sourcePath,sourceTabId:sender.tab.id,tabId:null,ownedTab:false,slot:false,
    state:"queued",createdAt:Date.now(),updatedAt:Date.now(),stopRequested:false,error:null
  };
  captureJobs.set(job.id,job);
  captureQueue.push(job.id);
  await persistCaptureState();
  void pumpCaptureQueue();
  return publicCaptureJob(job);
}

async function stopCaptureJob(message) {
  await ensureCaptureStateRestored();
  const job=captureJobs.get(String(message&&message.job_id||""));
  if(!job) throw new Error("The selected capture job no longer exists.");
  if(job.state==="queued" || job.state==="awaiting_autoplay" || job.state==="awaiting_retry") {
    job.state="cancelled";job.completedAt=Date.now();job.updatedAt=Date.now();job.slot=false;
    const index=captureQueue.indexOf(job.id);
    if(index>=0) captureQueue.splice(index,1);
    if(job.ownedTab && Number.isInteger(job.tabId)) await browser.tabs.remove(job.tabId).catch(()=>{});
    await persistCaptureState();
    void pumpCaptureQueue();
    return publicCaptureJob(job);
  }
  if(["completed","failed","cancelled","interrupted","downloading"].includes(job.state)) return publicCaptureJob(job);
  if(job.state==="opening"||job.state==="starting") {
    job.stopRequested=true;job.updatedAt=Date.now();
    await persistCaptureState();
    return publicCaptureJob(job);
  }
  if(!Number.isInteger(job.tabId)) throw new Error("The capture tab is not available.");
  job.state="saving";job.phase="Finalizing the WebM file";job.updatedAt=Date.now();
  await persistCaptureState();
  try { await runCaptureCommand(job.tabId,"stop",null); }
  catch(error) {
    job.error=String(error&&error.message||error||"Could not stop the recording.");
    job.state="failed";job.completedAt=Date.now();job.slot=false;
    await persistCaptureState();
    void pumpCaptureQueue();
    throw error;
  }
  return publicCaptureJob(job);
}

browser.tabs.onRemoved.addListener(tabId=>{
  void ensureCaptureStateRestored().then(async()=>{
    const job=Array.from(captureJobs.values()).find(item=>item.tabId===tabId);
    if(!job) return;
    if(!job.slot && job.state!=="awaiting_autoplay" && job.state!=="awaiting_retry") return;
    if(!["completed","failed","cancelled"].includes(job.state)) {
      job.state="interrupted";
      job.error="The background recording tab was closed before the download completed.";
      job.completedAt=Date.now();job.updatedAt=Date.now();
    }
    job.slot=false;
    job.tabId=null;
    await persistCaptureState();
    void pumpCaptureQueue();
  });
});

function isSupportedOverlayTab(tab) {
  try {
    const url = new URL(tab && tab.url || "");
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "www.youtube.com"
      && (!url.port || url.port === "443")
      && !url.username && !url.password
      && Number.isInteger(tab && tab.id);
  } catch (_) { return false; }
}

const OVERLAY_COMMANDS = new Set([
  "snapshot", "set", "pause", "resume", "split", "stop", "discard",
  "history", "recover", "delete", "jobs"
]);

browser.action.onClicked.addListener(async tab => {
  if (!isSupportedOverlayTab(tab)) {
    if (tab && Number.isInteger(tab.id)) {
      try {
        await browser.action.setTitle({
          tabId: tab.id,
          title: "Playback Capture requires HTTPS www.youtube.com."
        });
        await browser.action.setBadgeText({tabId: tab.id, text: ""});
      } catch (_) {}
    }
    return;
  }

  try {
    const target = {tabId: tab.id};
    const readiness = await browser.scripting.executeScript({
      target,
      world: "MAIN",
      func: function() {
        return {
          core: !!globalThis.__standalonePlaybackCoreV1,
          playerApi: !!globalThis.__standaloneYouTubePlayerApiV1,
          runtime: !!globalThis.__standalonePlaybackDownloadV1
        };
      }
    });
    const ready = readiness && readiness[0] && readiness[0].result || {};
    if (!ready.core) {
      await browser.scripting.executeScript({
        target,
        world: "MAIN",
        files: ["capture_core.js"]
      });
    }
    if (!ready.playerApi) {
      await browser.scripting.executeScript({
        target,
        world: "MAIN",
        files: ["youtube_player_api.js"]
      });
    }
    if (!ready.runtime) {
      await browser.scripting.executeScript({
        target,
        world: "MAIN",
        files: ["video_download.js"]
      });
    }
    await browser.scripting.executeScript({
      target,
      world: "ISOLATED",
      files: ["inline_record.js"]
    });
    await browser.scripting.executeScript({
      target,
      world: "ISOLATED",
      files: ["overlay.js"]
    });
    await browser.action.setTitle({
      tabId: tab.id,
      title: "Playback Capture dark overlay is active"
    });
    await browser.action.setBadgeBackgroundColor({tabId: tab.id, color: "#9BE24B"});
    await browser.action.setBadgeText({tabId: tab.id, text: "ON"});
  } catch (error) {
    try {
      await browser.action.setBadgeText({tabId: tab.id, text: "ERR"});
      await browser.action.setTitle({
        tabId: tab.id,
        title: String(error && error.message || error || "Could not inject Playback Capture overlay.")
      });
    } catch (_) {}
  }
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return undefined;
  if (message.type === "playback-capture:inline-jobs") return ensureCaptureStateRestored().then(()=>({ok:true,jobs:captureJobSnapshot()}));
  if (message.type === "playback-capture:inline-start") {
    return startInlineCapture(message,sender).then(job=>({ok:true,job}))
      .catch(error=>({ok:false,error:String(error&&error.message||error||"Could not queue the capture.")}));
  }
  if (message.type === "playback-capture:inline-stop") {
    return stopCaptureJob(message).then(job=>({ok:true,job}))
      .catch(error=>({ok:false,error:String(error&&error.message||error||"Could not stop the capture.")}));
  }
  if (message.type !== "playback-capture:overlay-command") return undefined;
  const senderUrl = (() => {
    try { return new URL(sender && sender.url || ""); }
    catch (_) { return null; }
  })();
  const trusted = !!senderUrl
    && senderUrl.protocol === "https:"
    && senderUrl.hostname.toLowerCase() === "www.youtube.com"
    && (!senderUrl.port || senderUrl.port === "443")
    && sender && sender.frameId === 0
    && sender.tab && Number.isInteger(sender.tab.id);
  if (!trusted) {
    return Promise.resolve({ok: false, error: "Overlay commands are accepted only from a top-level www.youtube.com tab."});
  }
  if (message.command === "jobs") return ensureCaptureStateRestored().then(()=>({ok: true, result: captureJobSnapshot()}));
  if (!OVERLAY_COMMANDS.has(message.command)) {
    return Promise.resolve({ok: false, error: "Unsupported Playback Capture command."});
  }

  return browser.scripting.executeScript({
    target: {tabId: sender.tab.id},
    world: "MAIN",
    func: async function(command, payload) {
      const api = globalThis.__standalonePlaybackDownloadV1;
      if (!api || typeof api.runCommand !== "function") {
        return {ok: false, error: "Playback Capture is not ready. Reload this YouTube tab and activate the extension again."};
      }
      try {
        return {ok: true, result: await api.runCommand(command, payload)};
      } catch (error) {
        return {ok: false, error: String(error && error.message || error || "Playback Capture command failed.")};
      }
    },
    args: [message.command, message.payload]
  }).then(results => {
    const result = results && results[0] && results[0].result;
    return result || {ok: false, error: "The YouTube tab did not return a capture response."};
  }).catch(error => ({
    ok: false,
    error: String(error && error.message || error || "Could not communicate with the YouTube capture runtime.")
  }));
});


async function resumePersistedDownloadHandoffs() {
  const jobs = Array.from(captureJobs.values()).filter(job =>
    job.state === "download_queued" && Number.isInteger(job.tabId) && job.captureId
  );
  for (const job of jobs) {
    try {
      job.phase = "Restoring the queued WebM download from temporary storage";
      job.updatedAt = Date.now();
      await persistCaptureState();
      await runCaptureCommand(job.tabId, "recover", job.captureId);
    } catch (error) {
      job.state = "failed";
      job.slot = false;
      job.completedAt = Date.now();
      job.updatedAt = Date.now();
      job.error = "Could not resume the saved WebM download after the background manager restarted: "
        + String(error && error.message || error);
      await persistCaptureState();
    }
  }
}

void ensureCaptureStateRestored().then(() => {
  void resumePersistedDownloadHandoffs().then(() => pumpCaptureQueue());
});
