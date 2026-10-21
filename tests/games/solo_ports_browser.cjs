const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 const base='http://127.0.0.1:8076',errors=[];
 async function launch(id,user){
  const page=await (await browser.newContext({viewport:{width:1200,height:1000}})).newPage();
  if(process.env.DEBUG_SOLO)page.on('console',m=>console.log(id,m.text()));
  page.on('pageerror',e=>{errors.push(e.message);console.log(id,'ERROR',e.message);});
  await page.goto(base+'/test-login/'+user);
  await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption(id);await page.locator('#retro-room-name').fill(id+' test');await page.locator('#retro-room-create').click();
  await page.waitForFunction(()=>document.getElementById('retro-invite').value);
  const invite=await page.locator('#retro-invite').inputValue();
  await page.locator('#retro-ready').click();await page.locator('#retro-start-race').click();
  await page.waitForFunction(()=>window.retroNetplay?.running||window.retroNetplay?.failed,null,{timeout:120000});
  assert.equal(await page.evaluate(()=>retroNetplay.failed),false,await page.locator('#retro-runtime-status').textContent());
  const frame=page.frames().find(f=>f.url().includes('/runtime/'));
  await frame.waitForFunction(()=>window.peakNativeTicks>100,null,{timeout:90000});
  return {page,frame,invite};
 }
 try{for(const id of (process.env.SOLO_GAMES||'sm64,zelda3').split(',')){
  const user=id+'-'+Date.now();const {page,frame,invite}=await launch(id,user);
  await frame.locator('canvas').screenshot({path:'.tmp/'+id+'-native.png'});
  const watcher=await (await browser.newContext()).newPage();let gameDownloads=0;
  watcher.on('request',r=>{if(/\/runtime\/|\/build\/|\/data\//.test(r.url()))gameDownloads++;});
  await watcher.goto(base+'/test-login/watch-'+user);await watcher.goto(invite);
  await watcher.waitForFunction(()=>window.retroNetplay?.running);
  await watcher.locator('#'+id+'-play-area [data-enable-audio]').click();
  await watcher.evaluate(()=>{window.audioPackets=0;retroNetplay.socket.on('solo_media',e=>{if(e.kind==='audio'&&new Int16Array(e.payload).some(x=>x))audioPackets++;});});
  await watcher.waitForFunction(()=>retroNetplay.frame>5,null,{timeout:30000});assert.equal(gameDownloads,0);
  await frame.locator('canvas').click();
  for(const key of (id.startsWith('sonic')?['Enter','s','s','s','x','x']:['Enter','x','x','Enter','Enter'])){await page.keyboard.press(key,{delay:150});await page.waitForTimeout(1800);}
  if(id==='driver2'){
   // Original Options > Save Settings creates a native config.dat.
   for(const key of ['s','s','s','s','x','w','w','x']){await page.keyboard.press(key,{delay:150});await page.waitForTimeout(450);}
   await frame.waitForFunction(()=>Module.FS.analyzePath('/save/config.dat').exists);
   assert.equal(await frame.evaluate(()=>Module.FS.readdir('/game/DRIVER2/FMV').some(n=>n.endsWith('.avi'))),false,'Finished cutscenes release their downloaded movie');
  }
  if(id.startsWith('sonic')){await page.waitForTimeout(8000);await page.keyboard.press('Enter',{delay:150});await page.waitForTimeout(8000);await page.keyboard.press('x',{delay:150});await page.waitForTimeout(6000);await page.keyboard.down('d');await page.keyboard.press('x',{delay:150});await page.waitForTimeout(1000);await page.keyboard.up('d');}
  if(id==='zelda3'){
   await frame.waitForFunction(()=>peakNativeTicks>950);
   for(const key of ['Enter','Enter','x','x','Enter','Enter']){await page.keyboard.press(key,{delay:200});await page.waitForTimeout(1700);}
  }
  await frame.locator('canvas').screenshot({path:'.tmp/'+id+'-play.png'});
  if(process.env.DEBUG_SOLO)console.log('AUDIO',await frame.evaluate(()=>({sdl:Module.SDL2?{audio:!!Module.SDL2.audio,context:Module.SDL2.audioContext?.state}:null,files:Module.FS.readdir('/game')})));
  await watcher.waitForFunction(()=>audioPackets>0,null,{timeout:30000});
  assert((await frame.evaluate(()=>Module.FS.readlink('/save'))).includes(user),'Local cache is scoped to this account');
  const saved=await frame.evaluate(async()=>{await peakFlushAccountSave();return peakExportSave();});
  assert(Object.keys(saved.files).length,'Native save exists');
  if(id.startsWith('sonic'))assert(Buffer.from(saved.files['SData.bin'],'base64').readInt32LE(16)>0,'A real playthrough slot was saved');
  await page.close();await watcher.close();
  const fresh=await launch(id,user);
  assert.deepEqual((await fresh.frame.evaluate(()=>peakExportSave())).files,saved.files,'Native save restored on another PC');
  await fresh.page.close();
  console.log(id,'PASS: native game and input, spectator video/audio, account saves, fresh-PC restore');
 }
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
