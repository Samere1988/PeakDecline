/* Account snapshots: the server is authoritative; IndexedDB is a retry backup. */
(() => {
'use strict';
const encode = bytes => {let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);};
const decode = text => Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const canonical = files => JSON.stringify(Object.fromEntries(Object.keys(files).sort().map(k=>[k,files[k]])));
let dbPromise;
function database(){return dbPromise ||= new Promise((resolve,reject)=>{const r=indexedDB.open('peak-account-sync-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('snapshots');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function local(key,value){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('snapshots',value===undefined?'readonly':'readwrite'), store=tx.objectStore('snapshots');const r=value===undefined?store.get(key):store.put(value,key);tx.oncomplete=()=>resolve(r.result);tx.onerror=tx.onabort=()=>reject(tx.error);});}
function status(message){
 let el=document.getElementById('account-save-status');
 if(!message){el?.remove();return;}
 if(!el){el=document.createElement('div');el.id='account-save-status';el.setAttribute('role','status');el.style.cssText='position:fixed;right:12px;bottom:12px;z-index:20000;max-width:420px;background:#18212fee;color:#eef3ff;padding:8px 12px;border-radius:8px;font:13px system-ui';document.body.append(el);}
 el.textContent=message;
}
async function connect({url,key,read,write,report=status,initial,owner=true,replay}){
 if(!owner){await write(initial?.files||{});return {flush:async()=>{},stop:async()=>{}};}
 key ||= (document.body.dataset.accountId || document.body.dataset.saveKey)+':'+url;
 const response=await fetch(url,{cache:'no-store'});
 if(!response.ok)throw Error('Cannot load account saves. Sign in and retry; the game has not started.');
 let remote=await response.json(), state=await local(key), busy, stopped=false, conflict=false;
 if(initial && !replay && (initial.revision!==remote.revision || canonical(initial.files)!==canonical(remote.files)))throw Error('Account save changed. Reopen the room before playing.');
 function conflictError(message){
  conflict=true;
  let panel=document.getElementById('account-save-recovery');
  if(!panel){panel=document.createElement('div');panel.id='account-save-recovery';panel.style.cssText='position:fixed;top:16px;right:16px;z-index:30000;max-width:420px;background:#18212f;color:white;padding:16px;border-radius:8px;font:14px system-ui';document.body.append(panel);}
  panel.replaceChildren();const text=document.createElement('p');text.textContent=message;panel.append(text);
  const download=document.createElement('button');download.textContent='Download browser backup';
  download.onclick=async()=>{const backup=await local(key),a=document.createElement('a'),blob=URL.createObjectURL(new Blob([JSON.stringify({game:url,...backup})],{type:'application/json'}));a.href=blob;a.download='peakdecline-save-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(blob),1000);};
  const useServer=document.createElement('button');useServer.textContent='Use server save and reload';
  useServer.onclick=async()=>{useServer.disabled=true;try{const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('Could not load server save. Retry when connected.');const latest=await r.json();await local(key+':conflict:'+Date.now(),await local(key));await write(latest.files);await local(key,{revision:latest.revision,files:latest.files});location.reload();}catch(e){text.textContent=e.message;useServer.disabled=false;}};
  panel.append(download,useServer);return Error(message);
 }
 const current=await read();
 if(replay && state?.pending)await local(key+':before-replay:'+Date.now(),state);
 if(state?.pending && !replay){
  if(canonical(state.pending)===canonical(remote.files)){state={revision:remote.revision,files:remote.files};await local(key,state);}
  else {
   if(state.revision!==remote.revision)throw conflictError('Unsynced progress conflicts with another device. Your browser backup is preserved.');
   const result=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':remote.csrf},body:JSON.stringify({revision:remote.revision,files:state.pending})});
   if(!result.ok)throw Error('Could not recover unsynced progress. Keep this browser data and retry.');
   remote=await result.json();state={revision:remote.revision,files:remote.files};await local(key,state);
   if(initial)throw Error('Recovered your last save. Reopen the room so all players load it.');
  }
 }
 // Existing local data may be from before cloud saves. Never replace it silently.
 const differs=canonical(current)!==canonical(remote.files);
 if(replay){
  // Reconstruct from the match's starting snapshot, never a newer account save.
  // Keep the fetched revision as the upload baseline; normal conflict checks
  // still reject another device's writes after recovery began.
  await write(initial?.files||{});state={revision:remote.revision,files:remote.files};
 }else if(!initial && Object.keys(current).length && differs && (!state || canonical(current)!==canonical(state.files))){
  if(remote.revision && (!state || state.revision!==remote.revision)){
   await local(key,{revision:state?.revision??0,files:state?.files||{},pending:current});
   throw conflictError('Existing browser progress differs from your account save. Both copies are preserved; choose the server save to continue.');
  }
  state={revision:remote.revision,files:remote.files,pending:current};await local(key,state);
 }else {await write(remote.files);state={revision:remote.revision,files:remote.files};await local(key,state);}
 async function upload(){
  if(replay?.())return; // Never publish intermediate replay EEPROM.
  if(conflict)throw Error('Another device saved progress. This browser backup is preserved; close this session.');
  const files=await read();
  if(canonical(files)===canonical(state.files))return;
  await local(key,{revision:state.revision,files:state.files,pending:files});
  report('Saving to your account…');
  const result=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':remote.csrf},body:JSON.stringify({revision:state.revision,files})});
  if(result.status===409){
   // The previous upload may have committed even if its reply was lost.
   const check=await fetch(url,{cache:'no-store'}), latest=check.ok?await check.json():null;
   if(latest && canonical(latest.files)===canonical(files)){state={revision:latest.revision,files};await local(key,state);report('Saved to your account.');return;}
   throw conflictError('Save conflict: another device saved progress. Your browser backup is preserved.');
  }
  if(!result.ok)throw Error('Save upload failed. Keep this tab open; retrying automatically.');
  const saved=await result.json();state={revision:saved.revision,files};await local(key,state);report('Saved to your account.');
 }
 function flush(){if(busy)return busy.then(flush);busy=upload().finally(()=>busy=null);return busy;}
 await flush();report('');
 const error=e=>report(e.message);
 const timer=setInterval(()=>{if(!stopped)flush().catch(error);},2000);
 const hidden=()=>{if(document.hidden&&!stopped)flush().catch(error);};
 document.addEventListener('visibilitychange',hidden);
 return {flush,async stop(){stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',hidden);await flush();},backup:()=>local(key)};
}
async function fs(module,{game,paths,bridge,report}={}){
 const FS=module.FS, url='/games/saves/'+game;
 const read=async()=>Object.fromEntries(Object.entries(paths).filter(([,p])=>FS.analyzePath(p).exists).map(([name,p])=>[name,encode(FS.readFile(p))]));
 const write=async files=>{for(const [name,p] of Object.entries(paths)){FS.mkdirTree(p.slice(0,p.lastIndexOf('/'))||'/');if(Object.hasOwn(files,name))FS.writeFile(p,decode(files[name]));else if(FS.analyzePath(p).exists)FS.unlink(p);}};
 const sync=await connect({url,read,write,initial:bridge?.initialSave,owner:bridge?bridge.saveOwner:true,replay:bridge?.restoreSave?bridge.replaying:undefined,report});
 window.peakFlushAccountSave=sync.flush;window.peakShutdown=sync.stop;return sync;
}
window.PeakSaves={connect,fs,encode,decode,status};
})();
