/* Pinned EmulatorJS 4.2.3 integration: server snapshots before boot and every 10s. */
window.PeakPrepareEmulatorSave=async function(core,romPath){
 await window.peakEmulatorSave?.stop();
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(romPath)))).map(b=>b.toString(16).padStart(2,'0')).join('');
 let files={},started=false,timer,blob,legacyBattery={};
 document.getElementById("emulator-save-import")?.remove();
 const sync=await PeakSaves.connect({url:'/games/saves/emulator-'+hash,read:async()=>files,write:async value=>{files={...value};}});
 window.EJS_gameName='peak-'+document.body.dataset.accountId+'-'+hash;
 window.EJS_disableDatabases=true;
 // EmulatorJS still mounts its shared battery-save DB when caches are disabled.
 // Detach that legacy mount before the core starts so accounts cannot inherit
 // another person's save, especially for compressed ROMs with fixed inner names.
 window.EJS_ready=()=>EJS_emulator.on('saveDatabaseLoaded',fs=>{
  const visit=dir=>{for(const name of fs.readdir(dir)){if(name==='.'||name==='..')continue;const path=dir+'/'+name;if(fs.isDir(fs.stat(path).mode))visit(path);else legacyBattery[path]=new Uint8Array(fs.readFile(path));}};
  visit('/data/saves');fs.unmount('/data/saves');
 });
 window.EJS_loadStateURL=undefined;
 if(files['state.bin']){blob=URL.createObjectURL(new Blob([PeakSaves.decode(files['state.bin'])]));window.EJS_loadStateURL=blob;}
 async function capture(){
  if(!started)return;
  const manager=window.EJS_emulator?.gameManager;
  if(!manager)throw Error('The emulator save interface is unavailable.');
  const state=manager.getState();
  const battery=manager.getSaveFile();
  if(state?.length)files['state.bin']=PeakSaves.encode(state);
  if(battery?.length)files['battery.sav']=PeakSaves.encode(battery);
  await sync.flush();
 }
 window.EJS_onGameStart=async()=>{
  started=true;
  // Native battery data is a fallback for cores without a saved state.
  if(!files['state.bin']&&files['battery.sav']){
   const m=EJS_emulator.gameManager,p=m.getSaveFilePath();m.FS.mkdirTree(p.slice(0,p.lastIndexOf('/')));m.FS.writeFile(p,PeakSaves.decode(files['battery.sav']));m.loadSaveFiles();
  }
  timer=setInterval(()=>capture().catch(e=>PeakSaves.status(e.message)),10000);
  const emulator=EJS_emulator,m=emulator.gameManager,oldBase=emulator.fileName.replace(/\.[^.]+$/,''),savePath=m.getSaveFilePath();
  const oldState=await emulator.storage.states.get(oldBase+'.state');
  const oldBattery=legacyBattery[savePath]||legacyBattery[savePath.replace(window.EJS_gameName,oldBase)];
  const panel=document.createElement('div');panel.id='emulator-save-import';panel.style.cssText='position:fixed;bottom:52px;right:12px;z-index:20000';
  async function importState(bytes){m.loadState(bytes);files['state.bin']=PeakSaves.encode(bytes);await sync.flush();}
  if(oldState?.byteLength||oldBattery?.length){
   const previous=document.createElement('button');previous.textContent='Import previous browser progress';
   previous.onclick=async()=>{try{if(oldState?.byteLength)await importState(new Uint8Array(oldState));else {m.FS.mkdirTree(savePath.slice(0,savePath.lastIndexOf('/')));m.FS.writeFile(savePath,oldBattery);m.loadSaveFiles();await capture();}previous.remove();}catch(e){PeakSaves.status(e.message);}};panel.append(previous);
  }
  const fromFile=document.createElement('button');fromFile.textContent='Import save state';
  fromFile.onclick=()=>{const input=document.createElement('input');input.type='file';input.accept='.state,.bin';input.onchange=async()=>{try{if(input.files[0])await importState(new Uint8Array(await input.files[0].arrayBuffer()));}catch(e){PeakSaves.status(e.message);}};input.click();};panel.append(fromFile);document.body.append(panel);
 };
 window.EJS_onSaveState=event=>{files['state.bin']=PeakSaves.encode(new Uint8Array(event.state));sync.flush().catch(e=>PeakSaves.status(e.message));};
 window.EJS_onLoadState=()=>{if(files['state.bin'])EJS_emulator.gameManager.loadState(PeakSaves.decode(files['state.bin']));else PeakSaves.status('No account snapshot yet.');};
 const hidden=()=>{if(document.hidden)capture().catch(e=>PeakSaves.status(e.message));};
 document.addEventListener('visibilitychange',hidden);
 let stopped=false;
 window.peakEmulatorSave={flush:capture,async stop(){if(stopped)return;stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',hidden);await capture();started=false;await sync.stop();if(blob)URL.revokeObjectURL(blob);document.getElementById("emulator-save-import")?.remove();}};
 window.peakFlushAccountSave=capture;
};
