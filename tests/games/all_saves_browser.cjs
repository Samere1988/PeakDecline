const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 const base='http://127.0.0.1:8078';
 async function page(user){const p=await(await browser.newContext()).newPage();await p.goto(base+'/test-login/'+user);return p;}
 try{
  const a=await page('sync-owner'),b=await page('sync-owner'),other=await page('sync-other');
  for(const p of [a,b,other])await p.addScriptTag({url:base+'/static/js/account_sync.js'});
  await a.evaluate(async()=>{window.files={};window.sync=await PeakSaves.connect({url:'/games/saves/mk64',key:'owner:mk64',read:async()=>files,write:async f=>files=f});files={'eeprom.bin':PeakSaves.encode(new Uint8Array(512).fill(37))};await sync.flush();});
  for(const p of [b,other])await p.evaluate(async()=>{window.files={};window.sync=await PeakSaves.connect({url:'/games/saves/mk64',key:'test:mk64',read:async()=>files,write:async f=>files=f});});
  assert.equal(await b.evaluate(()=>PeakSaves.decode(files['eeprom.bin'])[0]),37);
  assert.deepEqual(await other.evaluate(()=>files),{});
  await b.evaluate(async()=>{files={'eeprom.bin':PeakSaves.encode(new Uint8Array(512).fill(38))};await sync.flush();});
  const conflict=await a.evaluate(async()=>{files={'eeprom.bin':PeakSaves.encode(new Uint8Array(512).fill(39))};try{await sync.flush();return false}catch(e){return (await sync.backup()).pending['eeprom.bin']===files['eeprom.bin'];}});
  assert(conflict,'Conflicting browser copy preserved');
  assert(await a.locator('#account-save-recovery').isVisible());
  await a.getByRole('button',{name:'Use server save and reload'}).click();
  await a.waitForFunction(()=>!document.getElementById('account-save-recovery'));
  await a.addScriptTag({url:base+'/static/js/account_sync.js'});
  await a.evaluate(async()=>{window.files={};window.sync=await PeakSaves.connect({url:'/games/saves/mk64',key:'owner:mk64',read:async()=>files,write:async f=>files=f});});
  assert.equal(await a.evaluate(()=>PeakSaves.decode(files['eeprom.bin'])[0]),38);
  await other.evaluate(async()=>{window.shared={};const s=await PeakSaves.connect({url:'/games/saves/mk64',owner:false,initial:{revision:5,files:{'eeprom.bin':'shared'}},read:async()=>shared,write:async f=>shared=f});if(shared['eeprom.bin']!=='shared')throw Error('Missing shared initial save');shared['eeprom.bin']='changed';await s.flush();});
  assert.deepEqual(await other.evaluate(async()=>(await(await fetch('/games/saves/mk64')).json()).files),{});
  console.log('PASS fresh-browser restore, separate accounts, conflict recovery and spectator read-only saves');
  // The actual GTA page bootstrap, with only the expensive game engine disabled.
  async function gta(user){const p=await page(user);await p.route('**/games/gta5/play',async route=>{const response=await route.fetch();let html=await response.text();html=html.replace(/<script type="module">[\s\S]*?<\/script>/,'');await route.fulfill({response,body:html});});await p.goto(base+'/games/gta5/play');await p.evaluate(()=>peakGtaSaveReady);return p;}
  const g=await gta('gta-owner');
  const filename='/userdata/Documents/Rockstar Games/GTA V/Profiles/test/SGTA50000';
  await g.evaluate(async filename=>{const db=await new Promise((res,rej)=>{let r=indexedDB.open(document.getElementById('peak-gta-save-config').dataset.database,1);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});await new Promise((res,rej)=>{let t=db.transaction('files','readwrite');t.objectStore('files').put({data:new Uint8Array([1,9,7,3]),mtime:123456},filename);t.oncomplete=res;t.onerror=()=>rej(t.error)});await peakFlushAccountSave();},filename);
  const g2=await gta('gta-owner');
  const restored=await g2.evaluate(async filename=>{const db=await new Promise(res=>{const r=indexedDB.open(document.getElementById('peak-gta-save-config').dataset.database,1);r.onsuccess=()=>res(r.result)});return new Promise(res=>{const r=db.transaction('files').objectStore('files').get(filename);r.onsuccess=()=>res({bytes:[...r.result.data],mtime:r.result.mtime})});},filename);
  assert.deepEqual(restored,{bytes:[1,9,7,3],mtime:123456});
  console.log('PASS GTA native userdata and timestamps restored into fresh IndexedDB');
  const derby=await page('derby-owner');await derby.goto(base+'/test-derby');await derby.waitForFunction(()=>window.peakFlushAccountSave);await derby.evaluate(()=>peakFlushAccountSave());
  const progress=await derby.evaluate(async()=>{const r=await fetch('/games/saves/derby');return(await r.json()).files});assert(progress['progress.json']);
  const derby2=await page('derby-owner');await derby2.goto(base+'/test-derby');await derby2.waitForFunction(()=>window.peakFlushAccountSave);assert.equal(await derby2.locator('#bankroll-display').textContent(),'1,000');
  console.log('PASS Derby server save and fresh-browser initialization');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
