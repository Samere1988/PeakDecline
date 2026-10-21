const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const trace=require('./fixtures/perfectdark-menu-inputs.json').trace;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-swiftshader']});
 const base='http://127.0.0.1:8076',account='pd-save-'+Date.now();
 try{
  async function launch(user,initial,owner=true){
   const page=await (await browser.newContext()).newPage();
   await page.goto(base+'/test-login/'+user);
   const remote=await (await page.request.get(base+'/games/retro/saves/perfectdark')).json();
   await page.evaluate(({initial,owner})=>{
    window.peakPerfectDarkBridge={players:2,seed:12345,initialSave:initial,saveOwner:owner,saveStatus:s=>window.saveStatus=s,failed:e=>window.failure=e,ready:engine=>window.testEngine=engine};
    const iframe=document.createElement('iframe');iframe.src='/games/retro/runtime/perfectdark';document.body.append(iframe);
   },{initial:initial||remote,owner});
   await page.waitForFunction(()=>window.testEngine||window.failure,null,{timeout:120000});
   assert.equal(await page.evaluate(()=>window.failure),undefined);
   return page;
  }
  const first=await launch(account);
  for(const batch of trace.slice(0,22)){
   await first.evaluate(([count,slot,buttons,moveX,moveY])=>{
    for(let n=0;n<count;n++){testEngine.step([0,1].map(s=>({buttons:s===slot?buttons:0,moveX:s===slot?moveX:0,moveY:s===slot?moveY:0,lookX:0,lookY:0})));testEngine.drainEvents();}
   },batch.commands);
  }
  const frame=first.frames().find(f=>f.url().includes('/runtime/'));
  const bytes=await frame.evaluate(async()=>{await peakFlushAccountSave();return Array.from(Module.FS.readFile('/save/eeprom.bin'));});
  assert.equal(bytes.length,2048);assert(bytes.some(x=>x!==0));
  const saved=await (await first.request.get(base+'/games/retro/saves/perfectdark')).json();
  assert.deepEqual(Array.from(Buffer.from(saved.files['eeprom.bin'],'base64')),bytes);
  await first.close();
  const second=await launch(account);
  const secondFrame=second.frames().find(f=>f.url().includes('/runtime/'));
  assert.deepEqual(await secondFrame.evaluate(()=>Array.from(Module.FS.readFile('/save/eeprom.bin'))),bytes);
  const watcher=await launch(account+'-spectator',saved,false);
  const watcherFrame=watcher.frames().find(f=>f.url().includes('/runtime/'));
  assert.deepEqual(await watcherFrame.evaluate(()=>Array.from(Module.FS.readFile('/save/eeprom.bin'))),bytes);
  assert.deepEqual((await (await watcher.request.get(base+'/games/retro/saves/perfectdark')).json()).files,{});
  console.log('PASS: native EEPROM created, account upload, fresh-browser restore, read-only spectator bootstrap');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
