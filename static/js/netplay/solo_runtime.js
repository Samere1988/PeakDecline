/* This file also participates in the build fingerprint; only runs in the iframe. */
(async () => {
 'use strict';
 if (!document.body.dataset.buildUrl) return;
 const bridge = parent.peakSoloBridge;
 if (!bridge) return;
 const canvas = document.getElementById('canvas'), status = document.getElementById('loading');
 canvas.addEventListener('contextmenu', event => event.preventDefault());
 let tickTimer, accountSaves;
 window.peakFlushAccountSave=()=>accountSaves?.flush();
 let closed = false, volume = .7, outputGain;
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
  if(id!=='sm64'){
   if(pad.buttons&0x0800)pad.y=80;if(pad.buttons&0x0400)pad.y=-80;
   if(pad.buttons&0x0200)pad.x=-80;if(pad.buttons&0x0100)pad.x=80;
  }
  return window.peakPad=pad;
 };

 const id=document.body.dataset.engine;
 const configs={
  sm64:{script:'sm64.js',args:['--savepath','/save'],pattern:/^sm64_save_file\.bin$/},
  zelda3:{script:'zelda3.js',args:['--config','/game/zelda3.ini'],pattern:/^(sram\.dat|save[0-9]+\.sav)$/},
  sonic1:{script:'sonic.js',args:['UsingCWD'],pattern:/^(SData|SGame|UData)\.bin$/},
  sonic2:{script:'sonic.js',args:['UsingCWD'],pattern:/^(SData|SGame|UData)\.bin$/},
  driver2:{script:'driver2.js',args:[],pattern:/^(config|progress)\.dat$/}
 };
 const cfg=configs[id];if(!cfg)return fail('Unknown game.');
 window.peakSnesPad=()=>{
  const p=peakReadPad(),b=p.buttons;
  return (p.y>20?16:0)|(p.y< -20?32:0)|(p.x< -20?64:0)|(p.x>20?128:0)|
   (b&0x8000?256:0)|(b&0x4000?1:0)|(b&0x2000?512:0)|(b&0x1000?8:0)|(b&0x20?1024:0)|(b&0x10?2048:0)|(b&8?2:0)|(b&4?4:0);
 };
 let unlock,started=false;
 if(navigator.locks){const acquired=await new Promise(resolve=>navigator.locks.request(id+'-save-'+document.body.dataset.saveKey,{ifAvailable:true},async lock=>{
  resolve(!!lock);if(lock)await new Promise(done=>unlock=done);
 }));if(!acquired)return fail('This game is already open in another tab.');}
 const Module=window.Module={canvas,noInitialRun:true,arguments:cfg.args,
  locateFile:path=>document.body.dataset.buildUrl+(path.endsWith('.wasm')?cfg.script.replace('.js','.wasm'):path),
  print:message=>console.log(message),printErr:message=>console.warn(message),onAbort:fail,
  preRun:[()=>{
   Module.addRunDependency('account-data');
   (async()=>{
    const fs=Module.FS,saveRoot='/retro-saves/'+id+'/'+encodeURIComponent(document.body.dataset.saveKey);
    fs.mkdirTree(saveRoot);fs.mount(Module.IDBFS,{autoPersist:true},saveRoot);fs.symlink(saveRoot,'/save');
    fs.mkdirTree('/game');fs.chdir('/game');
    await new Promise((resolve,reject)=>fs.syncfs(true,e=>e?reject(e):resolve()));
    accountSaves=await PeakAccountSaves(fs,'/save',cfg.pattern,m=>bridge.saveStatus(m));
    const importKey='solo-import:'+id+':'+document.body.dataset.saveKey;
    const staged=sessionStorage.getItem(importKey);
    if(staged){const data=JSON.parse(staged);for(const name of fs.readdir('/save'))if(cfg.pattern.test(name))fs.unlink('/save/'+name);
     for(const [name,value]of Object.entries(data.files)){if(!cfg.pattern.test(name))throw new Error('Invalid import path.');fs.writeFile('/save/'+name,Uint8Array.from(atob(value),c=>c.charCodeAt(0)));}
     await new Promise((resolve,reject)=>fs.syncfs(false,e=>e?reject(e):resolve()));await accountSaves.flush();sessionStorage.removeItem(importKey);
    }
    const fetchData=async()=>{const r=await fetch(document.body.dataset.dataUrl,{signal:loading.signal});if(!r.ok)throw new Error('Game data could not be loaded.');return new Uint8Array(await r.arrayBuffer());};
    if(id==='zelda3'){
     fs.symlink('/save','/game/saves');fs.writeFile('/game/zelda3_assets.dat',await fetchData());
     fs.writeFile('/game/zelda3.ini','[General]\nAutosave=0\nExtendedAspectRatio=4:3\n[Graphics]\nWindowSize=640x480\nFullscreen=0\nNewRenderer=0\nEnhancedMode7=0\nNoSpriteLimits=0\nOutputMethod=SDL\n[Sound]\nEnableAudio=1\nAudioFreq=44100\nAudioChannels=2\nAudioSamples=1024\nEnableMSU=false\n');
    }else if(id.startsWith('sonic')){fs.writeFile('/game/Data.rsdk',await fetchData());}
    if(!closed)Module.removeRunDependency('account-data');
   })().catch(e=>fail(e.message));
  }],
  onRuntimeInitialized:()=>bridge.ready(()=>{
   if(started||closed)return;started=true;status.hidden=true;

   tickTimer=setInterval(()=>bridge.tick(window.peakNativeTicks||0),50);

   Module.callMain(cfg.args);
  })
 };
 const sync=()=>new Promise((resolve,reject)=>Module.FS.syncfs(false,e=>e?reject(e):resolve()));
 const snapshot=()=>{const files={};for(const name of Module.FS.readdir('/save'))if(cfg.pattern.test(name)){const bytes=Module.FS.readFile('/save/'+name);let value='';for(let i=0;i<bytes.length;i+=16384)value+=String.fromCharCode(...bytes.subarray(i,i+16384));files[name]=btoa(value);}return files;};
 window.peakExportSave=async()=>{if(!started)throw new Error('Wait for the game to load.');await sync();return {format:'peak-solo-save',game:id,version:1,files:snapshot()};};
 window.peakImportSave=async data=>{
  if(!started)throw new Error('Wait for the game to load.');
  if(data?.format!=='peak-solo-save'||data.game!==id||data.version!==1||!data.files||Array.isArray(data.files)||typeof data.files!=='object')throw new Error('Invalid save export.');
  const entries=Object.entries(data.files);if(!entries.length||entries.length>20)throw new Error('Invalid save contents.');
  entries.map(([name,value])=>{if(!cfg.pattern.test(name)||typeof value!=='string'||value.length>4*1024*1024)throw new Error('Invalid save contents.');return [name,Uint8Array.from(atob(value),c=>c.charCodeAt(0))];});
  // Reload is required so the native engine cannot keep the previous save in memory.
  // Imports are staged in sessionStorage and installed before the next native startup.
  sessionStorage.setItem('solo-import:'+id+':'+document.body.dataset.saveKey,JSON.stringify(data));
  await accountSaves?.flush();accountSaves?.stop();unlock?.();location.reload();
 };
 window.peakShutdown=async()=>{
  closed=true;loading.abort();clearInterval(tickTimer);accountSaves?.stop();
  for(const c of contexts)c.close().catch(()=>{});
  if(started)try{await sync();await accountSaves?.flush();}catch{}unlock?.();
 };
 window.addEventListener('pagehide',()=>{accountSaves?.stop();if(started)sync().catch(()=>{});unlock?.();});
 const script=document.createElement('script');script.src=document.body.dataset.buildUrl+cfg.script;
 script.onerror=()=>fail('Game runtime could not be loaded.');document.body.append(script);
})();
