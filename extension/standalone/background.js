"use strict";

const downloadJobs = new Map();
const captureJobs = new Map();
const captureQueue = [];
const MAX_PARALLEL_CAPTURE_JOBS = 3;
const ACTIVE_CAPTURE_STATES = new Set(["opening", "starting", "recording", "saving", "download_queued", "downloading"]);
const pendingDownloadQueue = [];
let activeDownloadId = null;
let downloadQueueStarting = false;

function safeFilename(value) {
  let filename = String(value || "youtube-playback.webm");
  const invalid = ["<", ">", ":", String.fromCharCode(34), "/", String.fromCharCode(92), "|", "?", "*"];
  for (const character of invalid) filename = filename.split(character).join("_");
  filename = Array.from(filename, character => character.charCodeAt(0) < 32 ? "_" : character)
    .join("").trim().slice(0, 140);
  if (!filename) filename = "youtube-playback";
  return filename.toLowerCase().endsWith(".webm") ? filename : filename + ".webm";
}

function finishJob(downloadId, state) {
  const job = downloadJobs.get(downloadId);
  if (!job) return;
  downloadJobs.delete(downloadId);
  try { URL.revokeObjectURL(job.objectUrl); } catch (_) {}
  try { job.port.postMessage({type: "playback-download:finished", state, download_id: downloadId, capture_id: job.captureId, request_id: job.requestId}); } catch (_) {}
  try { job.port.disconnect(); } catch (_) {}
  const captureJob = Array.from(captureJobs.values()).find(item =>
    item.tabId === job.captureTabId && (!item.captureId || item.captureId === job.captureId)
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
    void pumpCaptureQueue();
  }
  void pumpDownloadQueue();
}

browser.downloads.onChanged.addListener(delta => {
  if (!delta || !delta.state) return;
  if (delta.state.current === "complete" || delta.state.current === "interrupted") {
    finishJob(delta.id, delta.state.current);
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
    }
    item.port.postMessage({type: "playback-download:started", download_id: downloadId});
    const matches = await browser.downloads.search({id: downloadId});
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
  return {id:job.id,videoId:job.videoId,title:job.title,url:job.url,state:job.state,phase:job.phase||null,
    createdAt:job.createdAt,updatedAt:job.updatedAt,startedAt:job.startedAt||null,
    completedAt:job.completedAt||null,downloadId:job.downloadId||null,error:job.error||null};
}

function captureJobSnapshot() {
  return Array.from(captureJobs.values()).sort((a,b)=>b.createdAt-a.createdAt).slice(0,30).map(publicCaptureJob);
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
    func:function(){return {core:!!globalThis.__standalonePlaybackCoreV1,runtime:!!globalThis.__standalonePlaybackDownloadV1};}
  });
  const ready=readiness&&readiness[0]&&readiness[0].result||{};
  if(!ready.core) await browser.scripting.executeScript({target,world:"MAIN",files:["capture_core.js"]});
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
  try {
    if(job.currentTab) {
      job.tabId=job.sourceTabId;
    } else {
      const targetUrl = job.url + (job.url.includes("?") ? "&" : "?") + "__playback_capture_job=1";
      const tab=await browser.tabs.create({url:targetUrl,active:false});
      job.tabId=tab.id;
      job.ownedTab=true;
      job.phase="Waiting for YouTube's window load event";
      job.updatedAt=Date.now();
      await waitForTabComplete(tab.id);
    }
    job.state="starting";
    job.phase="Clicking the player and initializing MediaRecorder";
    job.updatedAt=Date.now();
    const startup = runCaptureCommand(job.tabId,"record-video",{videoId:job.videoId,title:job.title});
    const result = await Promise.race([
      startup,
      new Promise((_,reject)=>setTimeout(()=>reject(new Error(
        "Startup timed out after 45 seconds. YouTube did not begin playback or MediaRecorder did not initialize. Check Firefox's autoplay permission for youtube.com."
      )),45000))
    ]);
    job.captureId=result&&result.capture_id||null;
    job.startedAt=Date.now();
    job.state="recording";
    job.phase="Capturing decoded playback to the temporary WebM file";
    job.updatedAt=Date.now();
    if(job.stopRequested) await stopCaptureJob({job_id:job.id});
  } catch(error) {
    job.state="failed";
    job.phase="Startup failed";
    job.error=String(error&&error.message||error||"Could not start this capture.");
    job.completedAt=Date.now();
    job.updatedAt=Date.now();
    job.slot=false;
    if(Number.isInteger(job.tabId)) {
      if(job.ownedTab) await browser.tabs.remove(job.tabId).catch(()=>{});
      else await runCaptureCommand(job.tabId,"stop",null).catch(()=>{});
    }
    void pumpCaptureQueue();
  }
}

async function pumpCaptureQueue() {
  while(activeCaptureSlots()<MAX_PARALLEL_CAPTURE_JOBS&&captureQueue.length) {
    const id=captureQueue.shift();
    const job=captureJobs.get(id);
    if(!job||job.state!=="queued") continue;
    void launchCaptureJob(job);
  }
}

async function startInlineCapture(message,sender) {
  const senderUrl=(()=>{try{return new URL(sender&&sender.url||"");}catch(_){return null;}})();
  const trusted=!!senderUrl&&senderUrl.protocol==="https:"
    &&senderUrl.hostname.toLowerCase()==="www.youtube.com"
    &&(!senderUrl.port||senderUrl.port==="443")
    &&sender&&sender.frameId===0&&sender.tab&&Number.isInteger(sender.tab.id);
  const videoId=String(message.video_id||"");
  if(!trusted) throw new Error("Per-video recording is available only from a top-level www.youtube.com page.");
  if(!/^[A-Za-z0-9_-]{1,24}$/.test(videoId)) throw new Error("The selected YouTube video ID is invalid.");
  const existing=Array.from(captureJobs.values()).find(job =>
    job.videoId===videoId&&!["completed","failed","cancelled","interrupted"].includes(job.state)
  );
  if(existing) return publicCaptureJob(existing);
  const currentUrlId=(()=>{
    try {
      const url=new URL(sender.url);
      const path=url.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{1,24})/);
      return url.searchParams.get("v")||(path&&path[1])||"";
    } catch(_){return "";}
  })();
  const currentTab=message.mode==="current"&&currentUrlId===videoId;
  const title=String(message.title||"YouTube video").replace(/\s+/g," ").trim().slice(0,180)||"YouTube video";
  const job={
    id:makeJobId(),videoId,title,url:"https://www.youtube.com/watch?v="+videoId,
    currentTab,sourceTabId:currentTab?sender.tab.id:null,tabId:null,ownedTab:false,slot:false,
    state:"queued",createdAt:Date.now(),updatedAt:Date.now(),stopRequested:false,error:null
  };
  captureJobs.set(job.id,job);
  captureQueue.push(job.id);
  if(captureJobs.size>100) {
    for(const [id,item] of captureJobs) {
      if(captureJobs.size<=80) break;
      if(["completed","failed","cancelled","interrupted"].includes(item.state)) captureJobs.delete(id);
    }
  }
  void pumpCaptureQueue();
  return publicCaptureJob(job);
}

async function stopCaptureJob(message) {
  const job=captureJobs.get(String(message&&message.job_id||""));
  if(!job) throw new Error("The selected capture job no longer exists.");
  if(job.state==="queued") {
    job.state="cancelled";job.completedAt=Date.now();job.updatedAt=Date.now();
    return publicCaptureJob(job);
  }
  if(["completed","failed","cancelled","interrupted","downloading"].includes(job.state)) return publicCaptureJob(job);
  if(job.state==="opening"||job.state==="starting") {
    job.stopRequested=true;job.updatedAt=Date.now();
    return publicCaptureJob(job);
  }
  if(!Number.isInteger(job.tabId)) throw new Error("The capture tab is not available.");
  job.state="saving";job.phase="Finalizing the WebM file";job.updatedAt=Date.now();
  try { await runCaptureCommand(job.tabId,"stop",null); }
  catch(error) {
    job.error=String(error&&error.message||error||"Could not stop the recording.");
    job.state="failed";job.completedAt=Date.now();job.slot=false;
    void pumpCaptureQueue();
    throw error;
  }
  return publicCaptureJob(job);
}

browser.tabs.onRemoved.addListener(tabId=>{
  const job=Array.from(captureJobs.values()).find(item=>item.tabId===tabId&&item.slot);
  if(!job) return;
  if(!["completed","failed","cancelled"].includes(job.state)) {
    job.state="interrupted";
    job.error="The background recording tab was closed before the download completed.";
    job.completedAt=Date.now();job.updatedAt=Date.now();
  }
  job.slot=false;
  void pumpCaptureQueue();
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
  if (message.type === "playback-capture:inline-jobs") return Promise.resolve({ok:true,jobs:captureJobSnapshot()});
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
  if (message.command === "jobs") return Promise.resolve({ok: true, result: captureJobSnapshot()});
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
