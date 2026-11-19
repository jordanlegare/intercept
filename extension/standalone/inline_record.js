(() => {
  "use strict";
  const HOST="www.youtube.com";
  const INSTANCE_KEY="__playbackCaptureInlineButtonsV1";
  if(location.protocol!=="https:"||location.hostname.toLowerCase()!==HOST||(location.port&&location.port!=="443")||globalThis[INSTANCE_KEY]) return;

  const CARD_SELECTOR=["ytd-video-renderer","ytd-rich-item-renderer","ytd-compact-video-renderer","ytd-grid-video-renderer","ytd-reel-item-renderer","ytd-playlist-panel-video-renderer","yt-lockup-view-model"].join(",");
  const ACTIVE_STATES=new Set(["queued","opening","starting","recording","saving","downloading"]);
  const controls=new Set();
  const jobsByVideo=new Map();
  let refreshInFlight=false;
  let scanTimer=null;

  function extractVideoId(href) {
    try {
      const url=new URL(href,location.href);
      if(url.hostname!==HOST) return "";
      const path=url.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{1,24})/);
      const id=url.searchParams.get("v")||(path&&path[1])||"";
      return /^[A-Za-z0-9_-]{1,24}$/.test(id)?id:"";
    } catch(_){return "";}
  }
  function send(type,payload={}) { return browser.runtime.sendMessage({type,...payload}); }

  function titleFor(card,link) {
    const candidates=[card.querySelector("#video-title"),card.querySelector("h3 a"),card.querySelector(".yt-lockup-metadata-view-model__title"),card.querySelector("a[title]")];
    for(const node of candidates) {
      const value=node&&(node.textContent||node.getAttribute("title")||node.getAttribute("aria-label")||"").trim();
      if(value) return value.replace(/\s+/g," ").slice(0,180);
    }
    return (link&&(link.getAttribute("title")||link.getAttribute("aria-label"))||"YouTube video").replace(/\s+/g," ").slice(0,180);
  }

  function createControl(videoId,title,mode,placement) {
    const host=document.createElement("span");
    host.dataset.playbackCaptureControl="1";
    host.dataset.videoId=videoId;
    host.dataset.mode=mode;
    host.style.cssText=placement==="thumbnail"
      ?"position:absolute;right:8px;bottom:8px;z-index:2147483000;display:inline-flex;"
      :"display:inline-flex;vertical-align:middle;margin:0 6px 0 0;position:relative;z-index:2147483000;";
    const shadow=host.attachShadow({mode:"open"});
    const style=document.createElement("style");
    style.textContent="@keyframes playback-capture-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,40,40,.55);opacity:1}50%{box-shadow:0 0 0 6px rgba(255,40,40,0);opacity:.72}}button{all:initial;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:0 10px;border:1px solid #ff5353;border-radius:5px;background:#351313;color:#fff;font:800 10px/1.1 system-ui,sans-serif;letter-spacing:.04em;white-space:nowrap;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);user-select:none}button:hover{background:#581818;border-color:#ff7777}button.recording{background:#e21f2b;border-color:#ff6971;animation:playback-capture-pulse 1.15s infinite}button.pending{background:#593a0d;border-color:#e7a83d;color:#ffe3a6}button.saving{background:#333;border-color:#aaa;color:#fff}button.done{background:#16351e;border-color:#50a86b;color:#bdf6c9}button.error{background:#3d1919;border-color:#ff6969;color:#ffd1d1}button:disabled{opacity:.65;cursor:wait}@media(prefers-reduced-motion:reduce){button.recording{animation:none}}";
    const button=document.createElement("button");
    button.type="button";button.textContent="● REC";button.setAttribute("aria-label","Record "+title);
    button.title="Record this video in a background YouTube tab";
    button.addEventListener("click",async event=>{
      event.preventDefault();event.stopPropagation();
      const known=jobsByVideo.get(videoId);
      if(known&&ACTIVE_STATES.has(known.state)) {
        button.disabled=true;button.textContent="STOPPING…";
        const response=await send("playback-capture:inline-stop",{job_id:known.id});
        button.disabled=false;
        if(!response||!response.ok) {
          button.textContent="● REC";button.className="error";
          button.title=response&&response.error||"Could not stop this recording";return;
        }
        jobsByVideo.set(videoId,response.job);applyState(host,response.job);return;
      }
      button.disabled=true;button.textContent="QUEUED…";button.className="pending";
      const response=await send("playback-capture:inline-start",{
        video_id:videoId,title,mode,url:"https://www.youtube.com/watch?v="+videoId
      });
      button.disabled=false;
      if(!response||!response.ok) {
        button.textContent="RETRY";button.className="error";
        button.title=response&&response.error||"Could not queue recording";return;
      }
      jobsByVideo.set(videoId,response.job);applyState(host,response.job);
    });
    shadow.append(style,button);controls.add(host);return host;
  }

  function applyState(host,job) {
    const button=host.shadowRoot&&host.shadowRoot.querySelector("button");
    if(!button) return;
    button.className="";button.disabled=false;
    if(!job) {button.textContent="● REC";button.title="Record this video in a background YouTube tab";return;}
    const labels={queued:"QUEUED",opening:"OPENING",starting:"STARTING",awaiting_autoplay:"ALLOW PLAY",recording:"● REC",saving:"SAVING",downloading:"SAVING",completed:"SAVED",failed:"RETRY",interrupted:"RETRY",cancelled:"● REC"};
    button.textContent=labels[job.state]||"● REC";
    button.title=job.error||job.phase||(job.state==="recording"?"Recording to a WebM file. Click to stop and save.":"Capture state: "+job.state);
    if(job.state==="recording") button.className="recording";
    else if(["queued","opening","starting"].includes(job.state)) button.className="pending";
    else if(["saving","downloading"].includes(job.state)) button.className="saving";
    else if(job.state==="completed") button.className="done";
    else if(["failed","interrupted","awaiting_autoplay"].includes(job.state)) button.className="error";
  }

  function mountCard(card) {
    if(!(card instanceof Element)) return;
    const link=card.querySelector('a#thumbnail[href],a[href*="/watch?v="],a[href*="/shorts/"],a[href*="/live/"]');
    if(!link) return;
    const videoId=extractVideoId(link.href||link.getAttribute("href"));
    if(!videoId) return;
    const thumbnail=card.querySelector("ytd-thumbnail,#thumbnail,.ytThumbnailViewModelImage,.yt-lockup-view-model__content-image");
    if(thumbnail&&thumbnail.querySelector("[data-playback-capture-control]")) return;
    if(!thumbnail&&card.querySelector("[data-playback-capture-control]")) return;
    const title=titleFor(card,link);
    const control=createControl(videoId,title,"background",thumbnail?"thumbnail":"row");
    const job=jobsByVideo.get(videoId);if(job) applyState(control,job);
    if(thumbnail) {
      if(getComputedStyle(thumbnail).position==="static") thumbnail.style.position="relative";
      thumbnail.append(control);
    } else {
      const menu=card.querySelector("#menu,ytd-menu-renderer");
      if(menu&&menu.parentNode) menu.parentNode.insertBefore(control,menu);else card.append(control);
    }
  }

  function mountWatchButton() {
    const videoId=extractVideoId(location.href);
    if(!videoId) return;
    const actionRow=document.querySelector("#top-level-buttons-computed");
    if(!actionRow||actionRow.querySelector("[data-playback-capture-control]")) return;
    const heading=document.querySelector("h1.ytd-watch-metadata,ytd-watch-metadata h1");
    const title=heading&&heading.textContent.trim()?heading.textContent.trim().replace(/\s+/g," ").slice(0,180):document.title.replace(/\s+-\s+YouTube$/i,"");
    const control=createControl(videoId,title,"current","row");
    const job=jobsByVideo.get(videoId);if(job) applyState(control,job);
    actionRow.prepend(control);
  }

  function scan() {
    mountWatchButton();
    for(const card of document.querySelectorAll(CARD_SELECTOR)) mountCard(card);
  }

  async function refreshJobs() {
    if(refreshInFlight) return;refreshInFlight=true;
    try {
      const response=await send("playback-capture:inline-jobs");
      if(response&&response.ok&&Array.isArray(response.jobs)) {
        jobsByVideo.clear();
        for(const job of response.jobs) {
          const prior=jobsByVideo.get(job.videoId);
          if(!prior||job.createdAt>prior.createdAt) jobsByVideo.set(job.videoId,job);
        }
        for(const control of controls) {
          if(!control.isConnected){controls.delete(control);continue;}
          applyState(control,jobsByVideo.get(control.dataset.videoId));
        }
      }
    } catch(_) {
    } finally {refreshInFlight=false;}
  }

  globalThis[INSTANCE_KEY]={scan,refreshJobs};
  scan();void refreshJobs();
  for(const name of ["yt-navigate-finish","yt-page-data-updated"]) document.addEventListener(name,()=>{scan();void refreshJobs();},true);
  window.addEventListener("popstate",()=>{scan();void refreshJobs();});
  const observer=new MutationObserver(()=>{
    if(scanTimer) clearTimeout(scanTimer);
    scanTimer=setTimeout(()=>{scanTimer=null;scan();},180);
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  window.setInterval(()=>{scan();void refreshJobs();},1500);
})();