(() => {
 'use strict';
 const bridge=parent.peakCMR2Bridge, canvas=document.getElementById('canvas'), loading=document.getElementById('loading');
 if(!canvas||!loading||!document.body.dataset.buildUrl)return;
 let userDir,stopped=false,saves,timer,gain,volume=.7,audioNode;
 const build=document.body.dataset.buildUrl,assetRoot=document.body.dataset.assetUrl;
 const report=message=>{loading.textContent=message;bridge?.status?.(message);};
 const fail=error=>{if(!stopped){report(error.message||String(error));bridge?.failed(error.message||String(error));}};
 window.setPeakGameVolume=value=>{volume=Math.max(0,Math.min(1,value));if(gain)gain.gain.value=volume;};
 window.resumePeakGameAudio=()=>window.Module?.SDL3?.audioContext?.resume();
 window.peakShutdown=async()=>{stopped=true;clearInterval(timer);if(window.Module)Module.cmr2Stopped=true;try{if(Module?.FS)await new Promise((resolve,reject)=>Module.FS.syncfs(false,e=>e?reject(e):resolve()));await saves?.flush();}finally{saves?.stop();await Module?.SDL3?.audioContext?.close();}};
 if(!bridge){report('Open this game from its Peak Decline room.');return;}
 window.addEventListener('error',event=>{if(event.error)fail(event.error);});
 window.addEventListener('unhandledrejection',event=>fail(event.reason));
 if(!navigator.gpu){fail(new Error('This game needs a browser with WebGPU enabled.'));return;}
 window.peakSpectatorAudioSource=()=>audioNode;
 let automaticMenu,automaticCount=0,roomConnected=false,lastSearch=0;
 const neutralPad=Object.freeze({buttons:0,x:0,y:0});
 function connectRoom(){
  if(bridge.session.players<2||roomConnected||!Module.cmr2State)return;
  const state=Module.cmr2State,movie=Module.cmr2Movie,now=performance.now();
  if(state.menu===-1&&movie&&movie.count!==automaticCount){automaticCount=movie.count;Module.cmr2SkipMovie=true;return;}
  if(state.menu===62){Module._peak_network_ready();roomConnected=true;bridge.status('Choose your car and race settings. Your room connects automatically.');return;}
  if(state.menu===53&&bridge.session.slot!==bridge.session.coordinator&&bridge.session.created){
   if(now-lastSearch>1000){lastSearch=now;Module.cmr2MenuRequest={menu:53,index:0};}
   return;
  }
  if(state.menu===automaticMenu)return;
  const choices={1:0,0:3,33:2,34:2,140:2,141:3,60:0,53:bridge.session.slot===bridge.session.coordinator?1:0,61:6,19:2};
  const choice=choices[state.menu];if(choice===undefined||state.count<=choice)return;
  if(state.menu===53&&bridge.session.slot!==bridge.session.coordinator&&!bridge.session.created)return;
  automaticMenu=state.menu;Module.cmr2MenuRequest={menu:state.menu,index:choice};
 }
 function audio(){
  const sdl=Module.SDL3,context=sdl?.audioContext,node=sdl?.audio_playback?.scriptProcessorNode;
  if(!context||!node||node===audioNode)return;
  audioNode=node;gain=context.createGain();gain.gain.value=volume;node.disconnect();node.connect(gain);gain.connect(context.destination);

 }
 window.Module={canvas,noInitialRun:true,cmr2Transport:bridge.session,
  cmr2ProfileFrame:bridge.profileFrame?(phase=>bridge.profileFrame(phase,!stopped&&!document.hidden&&Module.cmr2State?.race===8)):undefined,
  // The native input and movie bridges read this at the point of use. A UI
  // timer here previously held steering and button changes for up to 100 ms.
  get cmr2Pad(){return stopped?neutralPad:(bridge.readPad?.()||neutralPad);},
  locateFile:name=>build+name,print:line=>console.log(line),printErr:line=>{
   if(/^(fatal:|gfx: (SDL_CreateGPUDevice|could not set|shader:|pipeline:|clear pipeline:|BeginPass failed)|CMR2 command failure)|WebGPU uncaptured error|Uncaptured WebGPU error/.test(line)){
    console.error(line);fail(new Error('The game renderer stopped: '+line+' (frame '+(Module.cmr2Frames||0)+', bindings '+(Module.cmr2BindingsCreated||0)+')'));
   }else console.debug(line);
  },onAbort:reason=>fail(new Error(String(reason))),
  ensureGameFile:async path=>{
   if(stopped)throw new Error('Game stopped.');
   if(!path.startsWith('/data/'))return 1;
   const entry=Module.cmr2Files.get(path.slice(6));if(!entry)return 0;if(entry.loaded)return 1;
   report('Loading game assets…');
   const response=await fetch(assetRoot+entry.path.split('/').map(encodeURIComponent).join('/'));
   if(!response.ok)throw new Error('A game asset could not be loaded.');
   const bytes=new Uint8Array(await response.arrayBuffer());
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
   if(bytes.length!==entry.size||digest!==entry.sha256)throw new Error('The game files changed. Reload the room.');
   Module.FS.writeFile(path,bytes);entry.loaded=true;Module.cmr2Downloaded=(Module.cmr2Downloaded||0)+bytes.length;return 1;
  },
  onRuntimeInitialized:async()=>{
   try{
    const response=await fetch(build+'assets.json');if(!response.ok)throw new Error('The game manifest is unavailable.');
    const manifest=await response.json();if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('Invalid game manifest.');
    const accountHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(document.body.dataset.saveKey))),value=>value.toString(16).padStart(2,'0')).join('');
    userDir='/cmr2-save-'+accountHash;Module.cmr2UserDir=userDir;
    Module.cmr2Files=new Map();Module.FS.mkdir('/data');Module.FS.mkdir(userDir);
    for(const entry of manifest.files){
     if(!entry.path||entry.path.startsWith('/')||entry.path.split('/').some(p=>p==='..'||!p)||!Number.isSafeInteger(entry.size)||entry.size<1||!/^[0-9a-f]{64}$/.test(entry.sha256))throw new Error('Invalid game asset.');
     Module.cmr2Files.set(entry.path,entry);const path='/data/'+entry.path;Module.FS.mkdirTree(path.slice(0,path.lastIndexOf('/')));Module.FS.writeFile(path,new Uint8Array([0]));
    }
    Module.FS.mount(Module.IDBFS,{autoPersist:true},userDir);await new Promise((resolve,reject)=>Module.FS.syncfs(true,e=>e?reject(e):resolve()));
    const saveFS=Object.create(Module.FS);
    saveFS.readdir=path=>{
     if(path!==userDir)return Module.FS.readdir(path);
     const files=[];
     function walk(directory,prefix=''){
      for(const name of Module.FS.readdir(directory))if(name!=='.'&&name!=='..'){
       const relative=prefix+name,child=directory+'/'+name;
       if(Module.FS.isDir(Module.FS.stat(child).mode)){if(relative==='pps'||relative==='Configuration')walk(child,relative+'/');}
       else files.push(relative);
      }
     }
     walk(path);return files;
    };
    const savePattern=/^(pps\/[A-Za-z0-9 _.-]{1,48}\.pps|Configuration\/(GameInfo|Controller)\.rcf)$/i;
    // Ensure parent directories exist before restoring an account snapshot.
    Module.FS.mkdirTree(userDir+'/pps');Module.FS.mkdirTree(userDir+'/Configuration');
    saves=await PeakAccountSaves(saveFS,userDir,savePattern,bridge.saveStatus);
    window.peakFlushAccountSave=()=>saves.flush();
    Module.FS.writeFile(userDir+'/opencmr2.ini','[install]\nlanguage=English\nsku=EUROPE\nmenu_shortcut=0\n[video]\nfullscreen=0\nrenderer=modern\nmsaa=4\nanisotropy=1\nrun_in_background=1\n');
    bridge.ready(()=>{
     if(stopped)return;report('Starting game…');canvas.focus();
     timer=setInterval(()=>{
      if(stopped)return;connectRoom();audio();bridge.tick(Module.cmr2Frames||0);
      if(Module.cmr2Frames>0){loading.hidden=true;bridge.status('');}
     },100);
     Module.callMain(['--data','/data','--user-dir',userDir]);
    });
   }catch(error){fail(error);}
  }
 };
 // Count binding allocations in this game iframe so a GPU failure includes
 // useful evidence even when the browser does not expose descriptor usage.
 if(typeof GPUDevice!=='undefined'){
  const createBindGroup=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(descriptor){
   const group=createBindGroup.call(this,descriptor);
   Module.cmr2BindingsCreated=(Module.cmr2BindingsCreated||0)+1;
   return group;
  };
 }
 async function loadRuntime(){
  try{
   const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
   if(stopped)return;
   if(!adapter)throw new Error('The browser could not access your graphics card. Enable hardware acceleration and restart the browser.');
   if(adapter.info?.isFallbackAdapter)throw new Error('The browser is using software graphics. Enable hardware acceleration and restart the browser to play Colin McRae Rally 2.0.');
   Module.cmr2GPUInfo={vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,fallback:adapter.info?.isFallbackAdapter};
   const script=document.createElement('script');script.src=build+'opencmr2.js';script.onerror=()=>fail(new Error('The game runtime could not load.'));document.body.append(script);
  }catch(error){fail(error);}
 }
 loadRuntime();
})();
