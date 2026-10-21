const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{const b=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
 const base='http://127.0.0.1:8078';
 async function pc(user){let p=await(await b.newContext()).newPage();p.on('pageerror',e=>console.log('ERROR',e.message));await p.route('**/static/js/account_sync.js*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:await r.text()+`;{const original=PeakSaves.fs;PeakSaves.fs=async(module,options)=>{const sync=await original(module,options);window.restoredAtBoot=Object.fromEntries(Object.entries(options.paths).filter(([,p])=>module.FS.analyzePath(p).exists).map(([n,p])=>[n,PeakSaves.encode(module.FS.readFile(p))]));return sync;};}`});});await p.goto(base+'/test-login/'+user);return p;}
 try{
  async function mk(user){const p=await pc(user);await p.addScriptTag({url:base+'/test-mk64/mk64.js'});await p.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;document.body.append(canvas);window.native=await createMK64({canvas,noInitialRun:true,locateFile:n=>'/test-mk64/'+n,print:()=>{},printErr:console.warn});window.sync=await PeakSaves.fs(native,{game:'mk64',paths:{'eeprom.bin':'/eeprom.bin'}});native.FS.writeFile('/baserom.us.z64',new Uint8Array(await(await fetch('/static/roms/N64/Mario%20Kart%2064%20(U)%20%5B!%5D.z64')).arrayBuffer()));native.mk64Input={buttons:0,x:0,y:0};native.mk64NativeMenus=true;native.callMain([]);});await p.waitForFunction(()=>native.FS.analyzePath('/eeprom.bin').exists,null,{timeout:60000});await p.evaluate(()=>sync.flush());return p;}
  const account='mk-native-'+Date.now(),p=await mk(account);const save=await p.evaluate(()=>PeakSaves.encode(native.FS.readFile('/eeprom.bin')));assert.equal(Buffer.from(save,'base64').length,512);await p.evaluate(async()=>{native._web_stop();await sync.stop();});await p.close();
  const p2=await mk(account);assert.equal(await p2.evaluate(()=>PeakSaves.encode(native.FS.readFile('/eeprom.bin'))),save);await p2.close();console.log('PASS rebuilt MK64 writes native EEPROM and restores it on a fresh browser');
  for(const id of (process.env.NATIVE_GAMES||'fzerox,marioparty,marioparty2,smash64').split(',')){
   const user=id+'-native-'+Date.now();
   const p=await pc(user);await p.locator('#retro-open-create').click();await p.locator('#retro-game-select').selectOption(id);await p.locator('#retro-room-name').fill(id+' saves');await p.locator('#retro-room-create').click();await p.locator('#retro-ready').click();await p.locator('#retro-start-race').click();
   await p.waitForFunction(()=>window.retroNetplay?.running||window.retroNetplay?.failed,null,{timeout:120000});assert.equal(await p.evaluate(()=>retroNetplay.failed),false,await p.locator('#retro-runtime-status').textContent());
   const frame=p.frames().find(f=>f.url().includes('/runtime/'));
   await frame.waitForFunction(()=>window.peakFlushAccountSave,null,{timeout:120000});
   await frame.locator('canvas').click();for(let i=0;i<4;i++){await p.keyboard.press('Enter',{delay:120});await p.waitForTimeout(1200);}
   await frame.evaluate(()=>peakFlushAccountSave());
   const data=await p.evaluate(async id=>(await(await fetch('/games/saves/'+id)).json()).files,id);
   console.log('NATIVE',id,Object.keys(data),Object.values(data).map(x=>Buffer.from(x,'base64').length));
   assert(Object.keys(data).length,'Native game generated a save: '+id);
   const fresh=await pc(user);const remote=await fresh.evaluate(async id=>(await(await fetch('/games/saves/'+id)).json()).files,id);assert.deepEqual(remote,data);
   await fresh.locator('#retro-open-create').click();await fresh.locator('#retro-game-select').selectOption(id);await fresh.locator('#retro-room-name').fill(id+' restore');await fresh.locator('#retro-room-create').click();await fresh.locator('#retro-ready').click();await fresh.locator('#retro-start-race').click();
   await fresh.waitForFunction(()=>window.retroNetplay?.running||window.retroNetplay?.failed,null,{timeout:120000});assert.equal(await fresh.evaluate(()=>retroNetplay.failed),false);
   const restoredFrame=fresh.frames().find(f=>f.url().includes('/runtime/'));assert.deepEqual(await restoredFrame.evaluate(()=>restoredAtBoot),data,'Exact account bytes restored before native startup');
   await frame.locator('canvas').screenshot({path:'.tmp/'+id+'-account-save.png'});
   await p.close();await fresh.close();console.log('PASS',id,'native boot, save upload, fresh-browser native restore');
  }
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
