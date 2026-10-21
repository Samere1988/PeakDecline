/* This file also participates in the build fingerprint; only runs in the iframe. */
(async () => {
 'use strict';
 if (!document.body.dataset.buildUrl) return;
 const bridge = parent.peakDiabloBridge;
 if (!bridge) return;
 const canvas = document.getElementById('canvas'), status = document.getElementById('loading');
 canvas.addEventListener('contextmenu', event => event.preventDefault());
 let tickTimer, accountSaves;
 window.peakFlushAccountSave=()=>accountSaves?.flush();
 let closed = false, volume = .7, outputGain, syncing;
 const contexts = new Set(), loading = new AbortController();
 const originalGetContext = HTMLCanvasElement.prototype.getContext;
 HTMLCanvasElement.prototype.getContext = function(kind, options) {
  return originalGetContext.call(this,kind,kind.includes('webgl') ? {...options,preserveDrawingBuffer:true} : options);
 };
 const originalConnect = AudioNode.prototype.connect;
 let audioMix;
 window.peakSpectatorAudioSource = () => audioMix;
 AudioNode.prototype.connect = function(destination, ...args) {
  if (destination === this.context.destination && this !== outputGain) {
   const context = this.context; contexts.add(context);
   if (!outputGain) {
    outputGain = context.createGain(); outputGain.gain.value = volume;
    originalConnect.call(outputGain, destination);
    audioMix = context.createGain(); originalConnect.call(audioMix, outputGain);
   }
   return originalConnect.call(this, audioMix, ...args);
  }
  return originalConnect.call(this, destination, ...args);
 };
 const originalDisconnect = AudioNode.prototype.disconnect;
 AudioNode.prototype.disconnect = function(...args) {
  if (args[0] === this.context.destination && this !== outputGain && audioMix) args[0] = audioMix;
  return originalDisconnect.apply(this, args);
 };
 window.setPeakGameVolume = value => { volume=value; if(outputGain)outputGain.gain.value=value; };
 window.resumePeakGameAudio = () => { for(const context of contexts) context.resume().catch(()=>{}); canvas.focus(); };
 canvas.addEventListener('pointerdown', window.resumePeakGameAudio);
 function fail(error) { if(!closed){status.hidden=false;status.textContent=String(error);bridge.failed(String(error));} }
 let unlock;
 if(navigator.locks){
  const acquired=await new Promise(resolve=>navigator.locks.request('diablo-save-'+document.body.dataset.saveKey,{ifAvailable:true},async lock=>{
   resolve(!!lock);if(lock)await new Promise(done=>unlock=done);
  }));
  if(!acquired){fail('Diablo is already open in another tab. Close it before playing here.');return;}
 }
 const savePath = '/diablo-saves-' + encodeURIComponent(document.body.dataset.saveKey);
 const Module = window.Module = {
  peakBridge:bridge, canvas, noInitialRun:true,
  arguments:['--diablo','--data-dir','/','--save-dir',savePath,'--config-dir',savePath],
  locateFile:path => document.body.dataset.buildUrl + path,
  print:message => console.log(message), printErr:message => console.warn(message), onAbort:fail,
  setStatus:message => { if(message)status.textContent=message; },
  preRun:[() => {
   Module.addRunDependency('diablo-data');
   Module.FS.mkdir(savePath);
   Module.FS.mount(Module.IDBFS,{autoPersist:true},savePath);
   Module.FS.syncfs(true, async error => {
    try {
     if(error)throw new Error('Browser save storage is unavailable. Allow site storage and retry.');
     if(window.PeakAccountSaves)accountSaves=await PeakAccountSaves(Module.FS,savePath,/^(single|multi)_[0-9]+\.sv$/,message=>bridge.saveStatus?.(message));
     const response = await fetch(document.body.dataset.dataUrl,{signal:loading.signal});
     if(!response.ok)throw new Error('Could not load the full Diablo data file.');
     const data = new Uint8Array(await response.arrayBuffer());
     if(closed)return;
     Module.FS.writeFile('/diabdat.mpq',data,{canOwn:true});
     const config = savePath+'/diablo.ini';
     if(!Module.FS.analyzePath(config).exists)
      Module.FS.writeFile(config,'[StartUp]\nDiablo Intro=0\n[Graphics]\nFullscreen=0\nWidth=640\nHeight=480\n[Audio]\nSample Rate=22050\n');
     Module.removeRunDependency('diablo-data');
    } catch(error){ fail(error.message); }
   });
  }],
  onRuntimeInitialized:() => {
   status.textContent='Waiting for the room…';
   bridge.ready(() => {
    status.hidden=true;
    tickTimer=setInterval(()=>{if(!closed)bridge.tick(Module._peakDiabloTicks());},250);
    Module.callMain(Module.arguments);
   });
  }
 };
 window.peakShutdown = async () => {
  accountSaves?.stop();try{await accountSaves?.flush();}catch{}
  closed=true;loading.abort();clearInterval(tickTimer);
  for(const context of contexts)context.close().catch(()=>{});
  if(Module.FS && !syncing) {
   syncing = new Promise(resolve=>{try{Module.FS.syncfs(false,resolve);}catch{resolve();}});
   await Promise.race([syncing,new Promise(resolve=>setTimeout(resolve,1200))]);
  }
  unlock?.();
 };
 window.addEventListener('pagehide',()=>{ unlock?.(); if(Module.FS)try{Module.FS.syncfs(false,()=>{});}catch{} });
 const script=document.createElement('script');script.src=document.body.dataset.buildUrl+'devilutionx.js';
 script.onerror=()=>fail('Could not load the Diablo runtime.');document.body.append(script);
})();
