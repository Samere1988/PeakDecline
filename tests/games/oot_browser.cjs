/* Full engine test against the isolated loopback fixture. */
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 const base='http://127.0.0.1:8076',errors=[];
 try{
  const context=await browser.newContext({viewport:{width:1200,height:1050}});let host=await context.newPage();
  host.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message);});
  host.on('console',m=>{if(m.type()==='error')console.log('BROWSER',m.text());});
  const loginUrl=base+'/test-login/oot-'+Date.now();await host.goto(loginUrl);
  async function create(){await host.locator('#retro-open-create').click();await host.locator('#retro-game-select').selectOption('oot');await host.locator('#retro-room-name').fill('Ocarina test');await host.locator('#retro-room-create').click();await host.waitForFunction(()=>document.getElementById('retro-invite').value);return new URL(await host.locator('#retro-invite').inputValue()).searchParams.get('room');}
  async function start(){await host.locator('#retro-ready').click();await host.locator('#retro-start-race').click();await host.waitForFunction(()=>window.retroNetplay?.running,null,{timeout:240000});const frame=host.frames().find(f=>f.url().includes('/runtime/oot'));await frame.waitForFunction(()=>window.peakNativeTicks>20,null,{timeout:90000});return frame;}
  const code=await create();let frame=await start();
  console.log('BOOTED',await frame.evaluate(()=>({ticks:window.peakNativeTicks,files:Module.FS.readdir('/Save')})));
  await frame.locator('canvas').screenshot({path:'.tmp/oot-title.png'});
  if(process.env.OOT_BOOT_ONLY)return;
  const watcher=await (await browser.newContext({viewport:{width:1200,height:1050}})).newPage();let gameDownloads=0;
  watcher.on('request',req=>{if(/\/runtime\/oot|\.z64|soh\.wasm/.test(req.url()))gameDownloads++;});
  await watcher.goto(base+'/test-login/watcher-'+Date.now());await watcher.goto(base+'/games/retro?room='+code);
  await watcher.waitForFunction(()=>window.retroNetplay?.running);await watcher.locator('#oot-play-area [data-enable-audio]').click();
  await watcher.evaluate(()=>{window.audioPackets=0;retroNetplay.socket.on('solo_media',e=>{if(e.kind==='audio'&&new Int16Array(e.payload).some(x=>x))audioPackets++;});});
  await watcher.waitForFunction(()=>retroNetplay.frame>5&&window.audioPackets>1,null,{timeout:25000});
  assert.equal(gameDownloads,0);console.log('SPECTATORS PASSED');
  await watcher.locator('#oot-play-area canvas').screenshot({path:'.tmp/oot-spectator.png'});
  await frame.locator('canvas').click({position:{x:20,y:20}});
  for(let i=0;i<10&&await frame.evaluate(()=>Module._peak_oot_mode())!==2;i++){
   await host.keyboard.press('Enter',{delay:150});await host.waitForTimeout(1000);
  }
  assert.equal(await frame.evaluate(()=>Module._peak_oot_mode()),2,'Native file select opened');
  await host.waitForTimeout(2500);
  const key=async(code,wait=1500)=>{await host.keyboard.press(code,{delay:150});await host.waitForTimeout(wait);};
  await key('x'); // Select empty file.
  await key('x'); // Select the original quest.
  await key('x',300); // Name A.
  await key('Enter',300);await key('x');
  await frame.locator('canvas').screenshot({path:'.tmp/oot-test-create.png'});
  await frame.waitForFunction(()=>Module.FS.analyzePath('/Save/file1.sav').exists);
  let saved=await frame.evaluate(()=>peakExportSave());
  assert(saved.files['file1.sav'].sections,'Native save sections exist');
  const downloadEvent=host.waitForEvent('download');
  await host.locator('#oot-play-area [data-export-save]').click();
  const download=await downloadEvent;
  assert.equal(download.suggestedFilename(),'ocarina-of-time-save.json');
  await download.saveAs('.tmp/oot-export-test.json');
  assert.deepEqual(JSON.parse(require('node:fs').readFileSync('.tmp/oot-export-test.json','utf8')),saved);
  await frame.locator('canvas').click({position:{x:20,y:20}});await key('x');await key('x');
  await frame.waitForFunction(()=>Module._peak_oot_mode()===0);
  const ticks=await frame.evaluate(()=>peakNativeTicks);await host.waitForTimeout(10000);
  assert((await frame.evaluate(()=>peakNativeTicks))>ticks+150,'Original simulation advances at roughly 20 ticks/s');
  await host.evaluate(()=>{
   window.testPad={id:'Oot test controller',index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
   Object.defineProperty(navigator,'getGamepads',{value:()=>[testPad],configurable:true});testPad.buttons[0]={pressed:true,value:1};
  });
  await frame.waitForFunction(()=>window.peakPad?.buttons===0x8000);
  await host.evaluate(()=>testPad.buttons[0]={pressed:false,value:0});
  saved=await frame.evaluate(()=>peakExportSave());
  console.log('NATIVE GAME, CONTROLLER, SAVE AND EXPORT PASSED');
  // Destroy the old runtime and create a new room, retaining only browser storage.
  await host.goto(base+'/games/retro');await create();frame=await start();
  const restored=await frame.evaluate(()=>peakExportSave());
  assert.deepEqual(restored.files['file1.sav'],saved.files['file1.sav'],'Native save restored from IndexedDB');
  const invalid={format:'peak-oot-save',version:1,files:{'../escape.sav':{version:1}}};
  await host.locator('[data-import-save]').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalid))});
  await host.waitForFunction(()=>document.querySelector('[data-save-status]').textContent.includes('Invalid'));
  assert.deepEqual((await frame.evaluate(()=>peakExportSave())).files['file1.sav'],saved.files['file1.sav']);
  await frame.evaluate(async()=>{Module.FS.unlink('/Save/file1.sav');await new Promise((r,j)=>Module.FS.syncfs(false,e=>e?j(e):r()));});
  await host.locator('[data-import-save]').setInputFiles({name:'restore.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(saved))});
  await host.waitForTimeout(1500);
  frame=host.frames().find(f=>f.url().includes('/runtime/oot'));
  await frame.waitForFunction(()=>window.peakNativeTicks>20,null,{timeout:90000});
  assert.deepEqual((await frame.evaluate(()=>peakExportSave())).files['file1.sav'],saved.files['file1.sav'],'Export restores deleted save');
  console.log(JSON.stringify({result:'passed',localSaveReload:true,exportImport:true,spectatorGameDownloads:gameDownloads}));
  saved=await frame.evaluate(()=>peakExportSave());
  await frame.evaluate(()=>peakFlushAccountSave());
  await host.close();
  host=await (await browser.newContext({viewport:{width:1200,height:1050}})).newPage();
  await host.goto(loginUrl);await create();frame=await start();
  assert.deepEqual((await frame.evaluate(()=>peakExportSave())).files['file1.sav'],saved.files['file1.sav'],'Account save restored on a fresh PC/browser');
  console.log('CROSS-PC ACCOUNT RESTORE PASSED');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
