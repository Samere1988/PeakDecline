/* Restore before the engine starts; upload complete native userdata snapshots. */
window.peakGtaSaveReady=(async()=>{
 const cfg=document.getElementById('peak-gta-save-config').dataset;
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(cfg.database,1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const read=()=>new Promise((resolve,reject)=>{const files={},times={},tx=db.transaction('files'),r=tx.objectStore('files').openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;const p=String(c.key);if(p.startsWith('/userdata/Documents/')){files[p]=PeakSaves.encode(new Uint8Array(c.value.data));times[p]=c.value.mtime;}c.continue();};tx.oncomplete=()=>{if(Object.keys(times).length)files['timestamps.json']=PeakSaves.encode(new TextEncoder().encode(JSON.stringify(times)));resolve(files);};tx.onerror=tx.onabort=()=>reject(tx.error);});
 const write=files=>new Promise((resolve,reject)=>{const times=files['timestamps.json']?JSON.parse(new TextDecoder().decode(PeakSaves.decode(files['timestamps.json']))):{};const tx=db.transaction('files','readwrite'),store=tx.objectStore('files');const cursor=store.openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(c){if(String(c.key).startsWith('/userdata/Documents/')&&!Object.hasOwn(files,c.key))c.delete();c.continue();}};for(const [p,data]of Object.entries(files))if(p.startsWith('/userdata/Documents/'))store.put({data:PeakSaves.decode(data),mtime:times[p]||Date.now()},p);tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});
 const sync=await PeakSaves.connect({url:'/games/saves/gta5',key:cfg.database,read,write});
 window.peakFlushAccountSave=sync.flush;
 const updates=new BroadcastChannel(cfg.database+'-changed');updates.onmessage=()=>sync.flush().catch(e=>PeakSaves.status(e.message));
 document.querySelector('[data-gta-exit]')?.addEventListener('click',async e=>{e.preventDefault();try{await sync.stop();location.href='/games/gta5';}catch(error){PeakSaves.status(error.message);}});
 return sync;
})();
window.peakGtaSaveReady.catch(error=>{PeakSaves.status(error.message);document.getElementById('label').textContent=error.message;});
