/* Real HTTP/WebSocket/HLS status transitions; network failures are controlled by routing. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require(process.env.WATCH_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..'),fixtures=path.join(root,'tests/watch_together/fixtures');
const port=18781,base=`http://127.0.0.1:${port}`,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const results=[],errors=[];let server,browser,page,logs='',releaseSegments;
async function check(name,fn){await fn();results.push({name,pass:true});console.log('PASS '+name);}
async function textIs(pattern){await page.waitForFunction(source=>new RegExp(source).test(document.getElementById('current-status-text').textContent),pattern,{timeout:45000});}
async function click(selector){await page.bringToFront();await page.locator('#live-player-shell').hover();await page.locator(selector).click();}
async function live(){await textIs('^LIVE$');assert.equal(await page.evaluate(()=>video.paused),false);}
(async()=>{
 try{
  server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'server.py')],{env:{...process.env,LIVE_TEST_PORT:String(port),LIVE_TEST_VIDEO:'1920x1080'},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  let ready=false;for(let i=0;i<80&&!ready;i++){assert.equal(server.exitCode,null,'owned server remains running');try{await fetch(base+'/');ready=true;}catch{await sleep(250);}}
  assert.ok(ready);
  browser=await chromium.launch({headless:true,executablePath:process.env.WATCH_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext();
  await context.route('https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js',r=>r.fulfill({path:path.join(fixtures,'hls.min.js'),contentType:'application/javascript'}));
  await context.route('https://cdn.socket.io/4.6.0/socket.io.min.js',r=>r.fulfill({path:path.join(fixtures,'socket.io.min.js'),contentType:'application/javascript'}));
  await context.route('https://fonts.googleapis.com/**',r=>r.abort());
  await context.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
   window.statusTrace=[];const el=document.getElementById('current-status-text');
   new MutationObserver(()=>statusTrace.push({text:el.textContent,at:performance.now(),paused:document.querySelector('video').paused})).observe(el,{subtree:true,childList:true,characterData:true});
  }));
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/test/login/0',{waitUntil:'domcontentloaded'});
  await check('initial no-stream message',()=>textIs('No active stream'));
  await page.route('**/api/play/1',async r=>{await sleep(600);await r.continue();});
  // Delay the master playlist, leaving the encoder and status requests operational.
  let releaseMaster;const masterGate=new Promise(r=>releaseMaster=r);
  await page.route('**/static/stream/1/index.m3u8*',async r=>{await masterGate;await r.continue();});
  await check('channel switching and loading messages',async()=>{
   await page.locator('#channel-list .channel-item').filter({hasText:'Synthetic live sports 1'}).click();
   await textIs('Switching to');await textIs('Loading');
  });
  await check('slow loading warning without false success',async()=>{await textIs('Taking longer');assert.equal(await page.evaluate(()=>video.paused),true);});
  releaseMaster();await page.unroute('**/static/stream/1/index.m3u8*');
  await check('actual playing event then LIVE',async()=>{await live();assert.ok(await page.evaluate(()=>statusTrace.some(s=>s.text.startsWith('Now playing')&&!s.paused)));});
  await check('clock outage while video continues, then clock recovery',async()=>{
   await page.route('**/api/live-clock/*',r=>r.fulfill({status:503,body:'unavailable'}));
   await textIs('Playing — live sync temporarily unavailable');const before=await page.evaluate(()=>video.currentTime);
   await page.waitForFunction(t=>video.currentTime>t+0.5,before);await page.unroute('**/api/live-clock/*');await live();
  });
  await check('pause and resume messages',async()=>{await click('#live-play-toggle');await textIs('^Paused');await click('#live-play-toggle');await live();});
  await check('unchanged quality and Auto do not claim buffering',async()=>{
   await click('#live-quality-cog');await page.locator('#live-quality-select').selectOption('native');
   await page.waitForFunction(()=>document.getElementById('live-quality-note').textContent==='Using native resolution.');
   await page.locator('#live-quality-select').selectOption('auto');
   assert.equal(await page.locator('#live-quality-note').textContent(),'Automatic quality enabled.');
   await live();await click('#live-quality-cog');
  });
  await check('quality selection while paused preserves pause feedback',async()=>{
   await click('#live-play-toggle');await textIs('^Paused');await click('#live-quality-cog');
   await page.locator('#live-quality-select').selectOption('480');
   assert.equal(await page.evaluate(()=>video.paused),true);await textIs('^Paused');
   assert.match(await page.locator('#live-quality-note').textContent(),/480p selected|Using 480p/);
   await click('#live-quality-cog');await click('#live-play-toggle');
   await page.waitForFunction(()=>video.videoHeight===480);await live();
  });
  await check('real download starvation shows buffering, then clears on recovery',async()=>{
   const gate=new Promise(r=>releaseSegments=r);
   await page.route('**/*.ts',async r=>{await gate;try{await r.continue();}catch{}});
   await textIs('Buffering');assert.equal(await page.evaluate(()=>video.readyState<3),true);
   releaseSegments();await page.unroute('**/*.ts');await live();
  });
  await check('fatal loader error reports reconnecting and clears after retry',async()=>{
   await page.evaluate(()=>hls.trigger(Hls.Events.ERROR,{fatal:true,type:Hls.ErrorTypes.NETWORK_ERROR}));
   await textIs('Playback interrupted. Reconnecting');await live();
  });
  await check('failed channel produces actionable failure, retry clears it',async()=>{
   await page.locator('#channel-list .channel-item').filter({hasText:'Unavailable test channel'}).click();
   await textIs('Unable to switch');await page.locator('#channel-list .channel-item').filter({hasText:'Synthetic live sports 1'}).click();await live();
  });
  await check('no browser errors',async()=>assert.deepEqual(errors,[]));
 }catch(e){results.push({name:'completion',pass:false,error:e.stack});console.error(e);process.exitCode=1;}
 finally{
  releaseSegments?.();
  let trace=[];try{trace=await page.evaluate(()=>statusTrace);}catch{}
  if(browser)await browser.close();
  if(server&&server.exitCode===null){try{await fetch(base+'/test/stop',{method:'POST'});}catch{}server.kill();}
  fs.writeFileSync(path.join(__dirname,'status-integration-results.json'),JSON.stringify({at:new Date().toISOString(),method:'Local production routes and FFmpeg 1080p with real HLS playback. Clock/download failures routed; fatal error injected. Autoplay permitted by test flag.',results,errors,trace},null,2));
 }
})();
