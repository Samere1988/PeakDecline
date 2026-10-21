/* The room's immutable starting EEPROM is shared by all deterministic replicas.
 * Only seat zero writes it back; spectators never read or write their own save. */
window.peakPreparePerfectDarkSaves = async function(fs, bridge) {
 const initial=bridge.initialSave;
 if(!initial){bridge.saveStatus?.('Account saves will be available after the server update.');return;}
 for(const [name,data] of Object.entries(initial.files)){
  if(name!=='eeprom.bin')throw new Error('Invalid Perfect Dark save.');
  const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
  if(bytes.length!==2048)throw new Error('Invalid Perfect Dark EEPROM size.');
  fs.writeFile('/save/'+name,bytes);
 }
 if(!bridge.saveOwner)return;
 const url=document.body.dataset.saveUrl;
 const response=await fetch(url,{cache:'no-store'});
 if(!response.ok)throw new Error('Could not load account saves. Sign in and reopen the room.');
 const remote=await response.json();
 if(remote.revision!==initial.revision)throw new Error('Your save changed on another device. Reopen the room to load it.');
 let revision=remote.revision,last=initial.files['eeprom.bin'],busy,conflict=false,stopped=false;
 const backupKey='perfectdark-pending:'+document.body.dataset.saveKey;
 async function upload(){
  if(conflict)throw new Error('Save conflict: another device saved progress. This browser backup is preserved.');
  if(!fs.analyzePath('/save/eeprom.bin').exists)return;
  const data=btoa(String.fromCharCode(...fs.readFile('/save/eeprom.bin')));
  if(data===last)return;
  // Retain a recovery copy even if the network or account session goes away.
  localStorage.setItem(backupKey,JSON.stringify({revision,files:{'eeprom.bin':data}}));
  bridge.saveStatus?.('Saving to your account…');
  const result=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':remote.csrf},body:JSON.stringify({revision,files:{'eeprom.bin':data}})});
  if(result.status===409){conflict=true;throw new Error('Save conflict: another device saved progress. This browser backup is preserved.');}
  if(!result.ok)throw new Error('Account save failed. Keep this browser open; retrying automatically.');
  revision=(await result.json()).revision;last=data;localStorage.removeItem(backupKey);
  bridge.saveStatus?.('Saved to your account.');
 }
 function flush(){if(busy)return busy.then(flush);busy=upload().finally(()=>busy=null);return busy;}
 // Recover a previously failed upload before starting a new room. The room
 // snapshot must then be rebuilt so every replica starts from recovered data.
 const pending=localStorage.getItem(backupKey);
 if(pending){
  const recovery=JSON.parse(pending);
  if(recovery.files?.['eeprom.bin']!==last){
   if(recovery.revision!==revision)throw new Error('Unsynced browser progress conflicts with the account save. The browser backup is preserved.');
   const result=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':remote.csrf},body:pending});
   if(!result.ok)throw new Error('Could not recover browser progress. Keep this browser data and try again.');
   localStorage.removeItem(backupKey);
   throw new Error('Recovered your last save. Reopen the room to continue it.');
  }
  localStorage.removeItem(backupKey);
 }
 const report=error=>bridge.saveStatus?.(error.message);
 const timer=setInterval(()=>flush().catch(report),5000);
 const onHidden=()=>{if(document.hidden&&!stopped)flush().catch(report);};
 document.addEventListener('visibilitychange',onHidden);
 window.peakFlushAccountSave=flush;
 window.peakShutdown=()=>{stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',onHidden);return flush().catch(report);};
 window.addEventListener('pagehide',window.peakShutdown,{once:true});
 bridge.saveStatus?.('');
};
