/* Real sockets/WASM. Sustained network loss must release the match, retain the
 * connected group, and allow the disconnected player to rejoin the same room. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.SMASH_URL || 'http://127.0.0.1:8068';
assert.equal(new URL(base).hostname,'127.0.0.1');
const out=path.resolve(process.env.SMASH_INTERRUPTION_OUTPUT || '.tmp/smash-release/offline');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,
  args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
 const pages=[],errors=[];
 try{
  for(let seat=0;seat<3;seat++){
   const page=await (await browser.newContext()).newPage();pages.push(page);
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/games/retro/runtime/smash64',async route=>{
    const response=await route.fetch();let body=await response.text();
    assert.ok(body.includes("ENV.SSB64_START_SCENE = '27'"));
    body=body.replace("ENV.SSB64_START_SCENE = '27'","ENV.SSB64_START_SCENE = '22'")
     .replace(/ENV.SSB64_BOOT_BATTLE = [^;]+;/,"ENV.SSB64_BOOT_BATTLE = '8,6,4,0,1,-1';")
     .replace(/ENV.SSB64_BOOT_SLOTS = [^;]+;/,"ENV.SSB64_BOOT_SLOTS = 'hhco';");
    await route.fulfill({response,body});
   });
   // Install on each navigation, including the guest's real reconnect/rejoin.
   await page.addInitScript(()=>{
    window.testHashes={};
    const timer=setInterval(()=>{
     const host=window.PeakNet?.adapters?.get('smash64');if(!host || host.testHooked)return;
     clearInterval(timer);host.testHooked=true;
     const launch=host.launch;host.launch=options=>{
      const s=options.session,bind=s.bind.bind(s),emit=s.socket.emit.bind(s.socket);
      s.socket.emit=(name,data,...args)=>{if(name==='hash')testHashes[data.epoch+':'+data.frame]=data.hash;return emit(name,data,...args);};
      s.bind=adapter=>{adapter.sampleInput=()=>({buttons:0,x:0,y:0});bind(adapter);};
      return launch(options);
     };
    },10);
   });
   await page.goto(base+'/test-login/offline-'+seat);
   await page.waitForFunction(()=>window.PeakNet?.adapters.get('smash64')?.testHooked);
  }
  const [host,guest,watcher]=pages;
  await host.locator('#retro-open-create').click();
  await host.locator('#retro-game-select').selectOption('smash64');
  await host.locator('#retro-room-name').fill('Offline recovery');
  await host.locator('#retro-room-create').click();
  await host.locator('#retro-lobby').waitFor();
  const invite=await host.locator('#retro-invite').inputValue();
  for(const page of [guest,watcher])await page.getByRole('button',{name:'Join room',exact:true}).click();
  await guest.locator('#retro-choose-player').click();
  await watcher.locator('#retro-choose-spectator').click();
  for(const page of [host,guest])await page.locator('#retro-ready').click();
  await host.locator('#retro-start-race').click();
  await host.waitForFunction(()=>window.retroNetplay?.frame>600,null,{timeout:120000});
  const interruptedAt=await host.evaluate(()=>retroNetplay.frame);
  await guest.evaluate(()=>{for(const peer of retroNetplay.inputTransport.peers.values())peer.channel?.close();});
  const started=Date.now();
  await guest.context().setOffline(true);
  for(const page of [host,watcher]){
   await page.locator('#retro-interruption').waitFor({timeout:65000});
   await page.locator('#retro-lobby').waitFor();
   await page.waitForFunction(()=>!window.retroNetplay && !document.querySelector('#smash64-play-area iframe'));
   assert.equal(await page.locator('#retro-invite').inputValue(),invite);
   assert.match(await page.locator('#retro-interruption-message').textContent(),/left|connection|could not continue/);
  }
  const returnMs=Date.now()-started;
  await guest.context().setOffline(false);
  await guest.goto(base+'/test-login/offline-1');
  await guest.waitForFunction(()=>window.PeakNet?.adapters.get('smash64')?.testHooked);
  await guest.getByRole('button',{name:'Join room',exact:true}).click();
  await guest.locator('#retro-choose-player').click();
  for(const page of [host,guest])await page.locator('#retro-ready').click();
  await host.locator('#retro-start-race').click();
  for(const page of [host,guest])await page.waitForFunction(()=>
   window.retroNetplay?.epoch===1 && retroNetplay.frame>600 && Number.isInteger(testHashes['1:600']),null,{timeout:120000});
  const hashes=await Promise.all([host,guest].map(p=>p.evaluate(()=>testHashes['1:600'])));
  assert.equal(hashes[0],hashes[1]);
  await watcher.waitForFunction(()=>window.retroNetplay?.epoch===1 && retroNetplay.frame>30,null,{timeout:30000});
  await host.locator('#retro-close-game').click();
  for(const page of pages)await page.locator('#retro-lobby').waitFor();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,interruptedAt,returnMs,
   rejoinedSameRoom:true,retainedSpectator:true,nextEpoch:1,nextMatchCheckpoint:600,hash:hashes[0]},null,2)+'\n');
  console.log('PASS: offline interruption, usable same lobby, rejoin, spectator and matching restarted match.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
