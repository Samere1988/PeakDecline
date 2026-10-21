/* This file also participates in the build fingerprint; only runs in the iframe. */
(async () => {
 'use strict';
 if (!document.body.dataset.buildUrl) return;
 const bridge = parent.peakOotBridge;
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
 const keys=new Set(), keyButtons={KeyX:0x8000,KeyC:0x4000,KeyZ:0x2000,Enter:0x1000,Space:0x1000,
  KeyQ:0x20,KeyE:0x10,ArrowUp:8,ArrowDown:4,ArrowLeft:2,ArrowRight:1};
 window.addEventListener('keydown',event=>{if(keyButtons[event.code]||['KeyW','KeyA','KeyS','KeyD'].includes(event.code)){keys.add(event.code);event.preventDefault();}});
 window.addEventListener('keyup',event=>keys.delete(event.code));
 window.addEventListener('blur',()=>keys.clear());
 window.peakReadPad=()=>{
  const pad={...bridge.readPad()};for(const key of keys)pad.buttons|=keyButtons[key]||0;
  if(keys.has('KeyA')||keys.has('KeyD'))pad.x=(keys.has('KeyD')?80:0)-(keys.has('KeyA')?80:0);
  if(keys.has('KeyW')||keys.has('KeyS'))pad.y=(keys.has('KeyW')?80:0)-(keys.has('KeyS')?80:0);
  return window.peakPad=pad;
 };
 window.peakSaveError=()=>fail('Local save storage is unavailable. Allow browser storage and reopen the game.');
 window.peakSaveWarning=()=>bridge.saveStatus('Could not store progress in this browser. Export Save to keep a backup.');
 window.peakSaveComplete=()=>{bridge.saveStatus('Saved in this browser.');accountSaves?.flush().catch(e=>bridge.saveStatus(e.message));};
 let unlock, started=false;
 // Keep two tabs for the same account from overwriting one another's progress.
 let acquire;
 const acquired=new Promise(resolve=>acquire=resolve);
 if(navigator.locks){navigator.locks.request('oot-save-'+document.body.dataset.saveKey,{ifAvailable:true},async lock=>{
  if(!lock){fail('Ocarina of Time is already open in another tab. Close it before playing here.');acquire(false);return;}
  acquire(true);await new Promise(resolve=>unlock=resolve);
 });}else acquire(true);
 if(!await acquired)return;
 // Runs in a worker from its source text, so it must not use this file's closure.
 function extractWorker(){
  self.onmessage=async({data})=>{
   const log=[],keep=line=>{log.push(line);if(log.length>12)log.shift();};
   const failed=()=>postMessage({error:'The original Ocarina of Time ROM could not be extracted.',log});
   let rom;
   try{const response=await fetch(data.romUrl);if(!response.ok)throw 0;rom=new Uint8Array(await response.arrayBuffer());}
   catch{postMessage({error:'Could not load game data.'});return;}
   // The extractor reports every asset; keep only the tail for failures.
   self.Module={noInitialRun:true,locateFile:path=>data.buildUrl+path,print:keep,printErr:keep,onAbort:failed,
    onRuntimeInitialized(){
     try{
      Module.FS.writeFile('/rom.z64',rom);rom=null;
      if(Module.ccall('web_extract_rom','number',['string','string'],['/rom.z64','/oot.o2r'])!==0)return failed();
      const bytes=Module.FS.readFile('/oot.o2r');postMessage({bytes:bytes.buffer},[bytes.buffer]);
     }catch{failed();}
    }};
   importScripts(data.buildUrl+'soh.js');
  };
 }
 // Native extraction runs for ~20 s without yielding. In this same-origin frame that
 // would freeze the room page and its socket, so it gets a separate engine instance.
 const extractRom=()=>new Promise((resolve,reject)=>{
  const source=URL.createObjectURL(new Blob(['('+extractWorker+')()'],{type:'text/javascript'}));
  const worker=new Worker(source);
  const finish=()=>{worker.terminate();URL.revokeObjectURL(source);loading.signal.removeEventListener('abort',cancel);};
  const cancel=()=>{finish();reject(new Error('Loading was cancelled.'));};
  loading.signal.addEventListener('abort',cancel);
  worker.onmessage=({data})=>{finish();if(data.log?.length)console.warn(data.log.join('\n'));data.error?reject(new Error(data.error)):resolve(data.bytes);};
  worker.onerror=event=>{event.preventDefault();finish();reject(new Error('Could not load Ocarina of Time.'));};
  worker.postMessage({buildUrl:new URL(document.body.dataset.buildUrl,location.href).href,romUrl:new URL(document.body.dataset.dataUrl,location.href).href});
 });
 // Cache extracted assets by runtime build and ROM URL, separately from saves.
 // Extract before loading the page's engine so the two instances never overlap in memory.
 const cacheKey=document.body.dataset.buildUrl+'oot-extracted-v1.o2r';
 let cache,extracted;try{cache=await caches.open('oot-assets-v1');}catch{}
 try{extracted=await (await cache?.match(cacheKey))?.arrayBuffer();}catch{}
 if(!extracted){
  status.textContent='Preparing Ocarina of Time…';
  try{extracted=await extractRom();}catch(error){fail(error.message);return;}
  if(closed)return;
  if(cache)await cache.put(cacheKey,new Response(extracted)).catch(()=>{});
 }
 const Module=window.Module={canvas,noInitialRun:true,
  locateFile:path=>document.body.dataset.buildUrl+path,
  print:message=>console.log(message),printErr:message=>console.warn(message),onAbort:fail,
  onRuntimeInitialized:async()=>{
   try{
    Module.callMain([]);
    const fs=Module.FS;
    const fetchBytes=async url=>{const response=await fetch(url,{signal:loading.signal});if(!response.ok)throw new Error('Could not load game data.');return new Uint8Array(await response.arrayBuffer());};
    fs.writeFile('/soh.o2r',await fetchBytes(document.body.dataset.buildUrl+'soh.o2r'));
    fs.writeFile('/oot.o2r',new Uint8Array(extracted));extracted=null;
    if(closed)return;
    // Explicit vanilla defaults; never configure the fork's external networking.
    fs.writeFile('/shipofharkinian.json',JSON.stringify({CVars:{gEnhancements:{TimeSavers:{}},gRemote:{Anchor:{Enabled:0}}}}));
    while(!Module._web_is_idbfs_ready()){if(closed)return;await new Promise(resolve=>setTimeout(resolve,50));}
    if(window.PeakAccountSaves)accountSaves=await PeakAccountSaves(fs,'/Save',/^(global|file[1-3])\.sav$/,message=>bridge.saveStatus(message));
    status.textContent='Waiting for the room…';
    bridge.ready(()=>{
     if(started||closed)return;started=true;status.hidden=true;
     Module._web_otr_loaded();
     tickTimer=setInterval(()=>bridge.tick(window.peakNativeTicks||0),250);

    });
   }catch(error){fail(error.message);}
  }
 };
 const sync=()=>new Promise((resolve,reject)=>{try{Module.FS.syncfs(false,error=>error?reject(error):resolve());}catch(error){reject(error);}});
 window.peakExportSave=async()=>{
  if(!started||!Module._web_is_idbfs_ready())throw new Error('Wait for the game to load.');
  await sync();const files={};
  for(const name of Module.FS.readdir('/Save')){
   if(!/^(global|file[1-3])\.sav$/.test(name))continue;
   const text=Module.FS.readFile('/Save/'+name,{encoding:'utf8'});files[name]=JSON.parse(text);
  }
  if(!Object.keys(files).some(name=>name.startsWith('file')))throw new Error('Create a save in the game first.');
  return {format:'peak-oot-save',version:1,files};
 };
 window.peakImportSave=async data=>{
  if(!started||!Module._web_is_idbfs_ready())throw new Error('Wait for the game to load.');
  if(data?.format!=='peak-oot-save'||data.version!==1||!data.files||typeof data.files!=='object'||Array.isArray(data.files))throw new Error('Not an Ocarina of Time save export.');
  const entries=Object.entries(data.files);
  if(!entries.length||entries.length>12||entries.some(([name,value])=>!/^(global|file[1-3])\.sav$/.test(name)||!value||typeof value!=='object'||Array.isArray(value)||!Number.isInteger(value.version)||(name.startsWith('file')&&(!value.sections||typeof value.sections!=='object'))))throw new Error('Invalid save contents.');
  if(JSON.stringify(data).length>4*1024*1024)throw new Error('Save file is too large.');
  // Pause the game before replacing files so a live save cannot race the import.
  Module._peak_oot_pause?.();
  const previous={};for(const name of Module.FS.readdir('/Save'))if(/^(global|file[1-3])\.sav$/.test(name))previous[name]=Module.FS.readFile('/Save/'+name);
  try{
   for(const name of Object.keys(previous))Module.FS.unlink('/Save/'+name);
   for(const [name,value]of entries)Module.FS.writeFile('/Save/'+name,JSON.stringify(value));
   await sync();await accountSaves?.flush();accountSaves?.stop();unlock?.();location.reload();
  }catch(error){for(const [name]of entries)try{Module.FS.unlink('/Save/'+name);}catch{}for(const [name,value]of Object.entries(previous))Module.FS.writeFile('/Save/'+name,value);await sync();Module._peak_oot_resume?.();throw error;}
 };
 window.peakShutdown=async()=>{
  closed=true;loading.abort();clearInterval(tickTimer);
  Module._peak_oot_pause?.();for(const context of contexts)context.close().catch(()=>{});
  accountSaves?.stop();if(started)try{await sync();await accountSaves?.flush();}catch{}unlock?.();
 };
 window.addEventListener('pagehide',()=>{if(started)sync().catch(()=>{});unlock?.();});
 const script=document.createElement('script');script.src=document.body.dataset.buildUrl+'soh.js';
 script.onerror=()=>fail('Could not load Ocarina of Time.');document.body.append(script);
})();
