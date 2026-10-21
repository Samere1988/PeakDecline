/* Run against devilutionx_browser_server.py. Uses real MPQ/WASM and temporary browser profiles. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_PATH || path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const base=process.env.RETRO_TEST_URL || 'http://127.0.0.1:8075';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 try {
  const pages=[], errors=[], stamp=Date.now();
  for(let i=0;i<3;i++){
   const context=await browser.newContext({viewport:{width:1200,height:1050}}),page=await context.newPage();
   page.on('pageerror',error=>errors.push(error.message));
   await page.goto(base+'/test-login/diablo-test-'+stamp+'-'+i);pages.push(page);
  }
  const [host,guest,watch]=pages;
  async function create(page,name){
   await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption('devilutionx');
   await page.locator('#retro-room-name').fill(name);await page.locator('#retro-room-create').click();
   await page.waitForFunction(()=>document.getElementById('retro-invite').value);
   return new URL(await page.locator('#retro-invite').inputValue()).searchParams.get('room');
  }
  const code=await create(host,'Diablo integration test');
  await guest.goto(base+'/games/retro?room='+code);await guest.locator('#retro-choose-player').click();
  for(const page of [host,guest])await page.locator('#retro-ready').click();
  await host.locator('#retro-start-race').click();
  for(const page of [host,guest])await page.waitForFunction(()=>window.retroNetplay?.running,null,{timeout:120000});
  const frames=[host,guest].map(page=>page.frames().find(frame=>frame.url().includes('/runtime/')));
  for(let i=0;i<2;i++){
   const page=pages[i],frame=frames[i];
   await frame.locator('canvas').click({position:{x:10,y:10}});await page.keyboard.press('Escape');await page.waitForTimeout(600);
   await page.keyboard.press('Enter');await page.waitForTimeout(600);await page.keyboard.press('Enter');await page.waitForTimeout(600);
   await page.keyboard.type(i?'Guest':'Host');await page.keyboard.press('Enter');
   await frame.waitForFunction(()=>Module._peakDiabloState()===3,null,{timeout:30000});
  }
  const observe=frame=>frame.evaluate(()=>({state:Module._peakDiabloState(),ticks:Module._peakDiabloTicks(),players:[0,1].map(slot=>[0,1,2,3,4].map(field=>Module._peakDiabloPlayer(slot,field)))}));
  for(const frame of frames)await frame.waitForFunction(()=>Module._peakDiabloPlayer(0,0)&&Module._peakDiabloPlayer(1,0));
  for(const frame of frames)await frame.waitForFunction(()=>Module._peakDiabloTicks()>80,null,{timeout:30000});
  const before=await observe(frames[0]);
  await frames[0].locator('canvas').click({position:{x:550,y:400}});
  await host.waitForTimeout(3000);
  const moved=await Promise.all(frames.map(observe));
  assert.notDeepEqual(moved[0].players[0].slice(1,3),before.players[0].slice(1,3),'Host moved');
  assert.deepEqual(moved[0].players,moved[1].players,'Both clients agree on player positions');
  let archiveRequests=0;watch.on('request',request=>{if(request.url().endsWith('diabdat.mpq'))archiveRequests++;});
  await watch.goto(base+'/games/retro?room='+code);await watch.waitForFunction(()=>window.retroNetplay?.running);
  await watch.locator('#devilutionx-play-area [data-enable-audio]').click();
  await watch.evaluate(()=>{
   window.diabloAudioPackets=0;
   retroNetplay.socket.on('diablo_media',event=>{if(event.kind==='audio'&&new Int16Array(event.payload).some(x=>x!==0))window.diabloAudioPackets++;});
  });
  await watch.waitForFunction(()=>retroNetplay.frame>8 && window.diabloAudioPackets>2,null,{timeout:20000});
  assert.equal(archiveRequests,0,'Spectators never download the full archive');
  const pixels=await watch.locator('#devilutionx-play-area canvas').evaluate(canvas=>{
   const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
   let nonBlack=0;for(let i=0;i<data.length;i+=4)if(data[i]+data[i+1]+data[i+2]>30)nonBlack++;return nonBlack;
  });
  assert(pixels>10000,'Spectator renders actual gameplay');
  // A long enough window to catch native turn stalls, not just successful loading.
  const ticks=(await observe(frames[0])).ticks;
  await host.waitForTimeout(20000);
  const after=await Promise.all(frames.map(observe));
  for(const state of after){assert.equal(state.state,3);assert(state.ticks>ticks+250,'Native simulation keeps advancing');assert(state.players.every(player=>player[0]===1));}
  assert.deepEqual(after[0].players,after[1].players);
  await watch.locator('#devilutionx-play-area canvas').screenshot({path:'.tmp/devilutionx/watcher.png'});
  const files=await frames[0].evaluate(()=>Module.FS.readdir('/diablo-saves-'+encodeURIComponent(document.body.dataset.saveKey)));
  assert(files.some(name=>name.endsWith('.sv')),'Native hero save exists');
  // Flush then reload the browser page and verify the hero file came from IndexedDB.
  await frames[0].evaluate(()=>new Promise((resolve,reject)=>Module.FS.syncfs(false,error=>error?reject(error):resolve())));
  await guest.locator('#retro-return').click();
  await host.goto(base+'/games/retro');await create(host,'Saved hero check');
  await host.locator('#retro-ready').click();await host.locator('#retro-start-race').click();
  await host.waitForFunction(()=>window.retroNetplay?.running,null,{timeout:120000});
  const reloaded=host.frames().find(frame=>frame.url().includes('/runtime/'));
  const restored=await reloaded.evaluate(()=>Module.FS.readdir('/diablo-saves-'+encodeURIComponent(document.body.dataset.saveKey)));
  assert(files.filter(name=>name.endsWith('.sv')).every(name=>restored.includes(name)),'Heroes survive reload');
  await reloaded.evaluate(()=>peakFlushAccountSave());
  const hero=await reloaded.evaluate(()=>Array.from(Module.FS.readFile('/diablo-saves-'+encodeURIComponent(document.body.dataset.saveKey)+'/multi_0.sv')));
  await host.close();
  const fresh=await (await browser.newContext({viewport:{width:1200,height:1050}})).newPage();
  await fresh.goto(base+'/test-login/diablo-test-'+stamp+'-0');await create(fresh,'Account hero restore');
  await fresh.locator('#retro-ready').click();await fresh.locator('#retro-start-race').click();
  await fresh.waitForFunction(()=>window.retroNetplay?.running,null,{timeout:120000});
  const freshFrame=fresh.frames().find(frame=>frame.url().includes('/runtime/'));
  const restoredHero=await freshFrame.evaluate(()=>Array.from(Module.FS.readFile('/diablo-saves-'+encodeURIComponent(document.body.dataset.saveKey)+'/multi_0.sv')));
  assert.deepEqual(restoredHero,hero,'Full native hero restored on a fresh PC');
  await freshFrame.locator('canvas').screenshot({path:'.tmp/devilutionx/start-game-menu.png'});
  console.log('CROSS-PC DIABLO HERO RESTORE PASSED');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({players:after, spectatorFrames:await watch.evaluate(()=>window.retroNetplay?.frame), archiveRequests, saves:restored, result:'passed'}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
