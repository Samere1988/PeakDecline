/* Shared account storage. Only game saves are uploaded, never settings or assets. */
window.PeakAccountSaves = async function(fs, root, pattern, report) {
 const url=document.body.dataset.saveUrl;
 if(!url)return {flush:async()=>{},stop:()=>{}}; // Existing server process has no save API yet.
 const key='retro-account-save:'+document.body.dataset.saveKey+':'+url;
 let state, busy, stopped=false, conflict=false;
 const snapshot=()=>{
  const files={};
  for(const name of fs.readdir(root).sort())if(pattern.test(name)){
   const bytes=fs.readFile(root+'/'+name);let binary='';
   for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
   files[name]=btoa(binary);
  }
  return files;
 };
 const digest=async files=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(files))))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const persist=()=>localStorage.setItem(key,JSON.stringify(state));
 const response=await fetch(url,{cache:'no-store'});
 if(!response.ok)throw new Error('Cannot load account saves. Please sign in and try again.');
 const remote=await response.json(), local=snapshot();
 const localHash=await digest(local);
 let prior;try{prior=JSON.parse(localStorage.getItem(key));}catch{}
 if(prior && prior.hash!==localHash && prior.revision!==remote.revision)
  throw new Error('This browser has unsynced progress and the account save changed elsewhere. Keep this browser data; resolve the save conflict before playing.');
 if(!prior && remote.revision && Object.keys(local).length && localHash!==await digest(remote.files))
  throw new Error('Existing browser saves differ from your account saves. Local progress has been preserved; resolve this conflict before playing.');
 state={revision:remote.revision,hash:await digest(remote.files)};
 if(remote.revision && !(prior && prior.hash!==localHash)){
  for(const name of Object.keys(local))fs.unlink(root+'/'+name);
  for(const [name,value] of Object.entries(remote.files)){
   if(!pattern.test(name))throw new Error('Invalid account save filename.');
   fs.writeFile(root+'/'+name,Uint8Array.from(atob(value),c=>c.charCodeAt(0)));
  }
  await new Promise((resolve,reject)=>fs.syncfs(false,e=>e?reject(e):resolve()));
 }
 persist();
 async function upload(){
  if(conflict)throw new Error('Account save changed on another PC. Close this session before continuing.');
  const files=snapshot(), hash=await digest(files);
  if(hash===state.hash)return;
  report('Saving to your account…');
  const result=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':remote.csrf},body:JSON.stringify({revision:state.revision,files})});
  if(result.status===409){conflict=true;throw new Error('Save conflict: another PC saved progress. This browser copy is preserved.');}
  if(!result.ok)throw new Error('Account save failed. Keep this browser open; retrying automatically.');
  const saved=await result.json();state={revision:saved.revision,hash};persist();report('Saved to your account.');
 }
 function flush(){if(busy)return busy.then(()=>flush());busy=upload().finally(()=>busy=null);return busy;}
 await flush();report('');
 const onHidden=()=>{if(document.hidden&&!stopped)flush().catch(e=>report(e.message));};
 document.addEventListener('visibilitychange',onHidden);
 const timer=setInterval(()=>{if(!stopped)flush().catch(e=>report(e.message));},5000);
 return {flush,stop:()=>{stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',onHidden);}};
};
