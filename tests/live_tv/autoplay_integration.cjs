const path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require(process.env.WATCH_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..'),fixtures=path.join(root,'tests/watch_together/fixtures'),port=18776,base=`http://127.0.0.1:${port}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{let server,browser;
 try {
  server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'server.py')],{env:{...process.env,LIVE_TEST_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let ready=false;for(let i=0;i<80&&!ready;i++){try{await fetch(base+'/');ready=true;}catch{await sleep(250);}}
  assert.equal(ready,true,'test server starts');
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=document-user-activation-required'],executablePath:process.env.WATCH_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const context=await browser.newContext();
  await context.route('https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js',r=>r.fulfill({path:path.join(fixtures,'hls.min.js'),contentType:'application/javascript'}));
  await context.route('https://cdn.socket.io/4.6.0/socket.io.min.js',r=>r.fulfill({path:path.join(fixtures,'socket.io.min.js'),contentType:'application/javascript'}));
  await context.route('https://fonts.googleapis.com/**',r=>r.abort());
  const page=await context.newPage();await page.goto(`${base}/test/login/0`,{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>fetch('/test/start',{method:'POST'}));
  await page.waitForFunction(()=>!video.paused,{timeout:30000});
  const initialMuted=await page.evaluate(()=>video.muted);
  assert.equal(typeof initialMuted,'boolean','autoplay state is readable');
  if(initialMuted) await page.locator('#live-mute-toggle').click();
  assert.equal(await page.evaluate(()=>video.muted),false,'speaker button enables sound');
  await page.waitForFunction(()=>document.querySelectorAll('#channel-list .channel-item').length>=2,{timeout:10000});
  await page.locator('#channel-list .channel-item').nth(1).click();
  await page.waitForFunction(()=>currentChannelId===2 && !video.paused,{timeout:30000});
  assert.equal(await page.evaluate(()=>video.muted),false,'user-initiated channel switch keeps sound enabled');
  await page.waitForFunction(()=>Number.isFinite(clockSample?.stream_start_pdt) && sharedTarget() !== null && programOffset() !== null,{timeout:30000});
  const origin=await page.evaluate(()=>clockSample.stream_start_pdt);
  await page.waitForFunction(()=>sharedTarget()-clockSample.stream_start_pdt>18,{timeout:30000});
  // Fresh sessions join a running stream without clicking any player controls.
  for (const clockUnavailable of [false,true]) {
   const joinContext=await browser.newContext();
   // Enforce sound-policy rejection in one session regardless of machine
   // autoplay allowlists; muted playback still uses the real media engine.
   if(clockUnavailable) await joinContext.addInitScript(() => {
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){
     if(!this.muted) return Promise.reject(new DOMException('Sound requires interaction','NotAllowedError'));
     return play.call(this);
    };
   });
   await joinContext.route('https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js',r=>r.fulfill({path:path.join(fixtures,'hls.min.js'),contentType:'application/javascript'}));
   await joinContext.route('https://cdn.socket.io/4.6.0/socket.io.min.js',r=>r.fulfill({path:path.join(fixtures,'socket.io.min.js'),contentType:'application/javascript'}));
   await joinContext.route('https://fonts.googleapis.com/**',r=>r.abort());
   if(clockUnavailable) await joinContext.route('**/api/live-clock/**',r=>r.fulfill({status:503,body:'{}',contentType:'application/json'}));
   const joiner=await joinContext.newPage();
   await joiner.goto(`${base}/test/login/${clockUnavailable?2:1}`,{waitUntil:'domcontentloaded'});
   await joiner.waitForFunction(()=>!video.paused && video.readyState>=2 && video.currentTime>0,{timeout:30000});
   const before=await joiner.evaluate(()=>video.currentTime);
   await joiner.waitForFunction(t=>video.currentTime>t+0.5,before,{timeout:10000});
   if(!clockUnavailable) {
    await joiner.waitForFunction(()=>sharedTarget()!==null && programOffset()!==null && Math.abs(sharedTarget()-programOffset()-video.currentTime)<1,{timeout:30000});
    assert.equal(await joiner.evaluate(()=>clockSample.stream_start_pdt),origin,'late viewer retains first chunk origin after playlist rolls');
    assert.ok(await joiner.evaluate(()=>sharedTarget()-clockSample.stream_start_pdt>18));
    console.log('Elapsed sync:',await joiner.locator('.live-sync-times').innerText());
   }
   if(clockUnavailable) assert.equal(await joiner.evaluate(()=>video.muted),true,'sound-policy rejection falls back to real muted playback');
   await joinContext.close();
  }
  // Selecting the current channel after a deliberate pause resumes it too.
  await page.bringToFront();
  await page.locator('#live-player-shell').hover();
  await page.locator('#live-play-toggle').click();
  assert.equal(await page.evaluate(()=>video.paused),true);
  await page.locator('#channel-list .channel-item.active').click();
  await page.waitForFunction(()=>!video.paused,{timeout:10000});
  console.log('PASS automatic channel playback, sound activation, fresh joins, unavailable-clock joins and selecting a paused current channel');
  await context.close();
 } finally {try{await fetch(`${base}/test/stop`,{method:'POST'});}catch{} if(browser)await browser.close();if(server)server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
