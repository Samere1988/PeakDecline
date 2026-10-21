const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require(process.env.WATCH_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..'),fixtures=path.join(root,'tests/watch_together/fixtures'),port=18772,base=`http://127.0.0.1:${port}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 let server,browser;
 try {
  server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'server.py')],{env:{...process.env,LIVE_TEST_PORT:String(port),LIVE_TEST_VIDEO:'1920x1080'},stdio:['ignore','pipe','pipe']});
  server.stdout.resume();server.stderr.resume();
  let ready=false; for(let i=0;i<80&&!ready;i++){try{await fetch(base+'/');ready=true;}catch{await sleep(250);}}
  assert.equal(ready,true,'test server starts');
  browser=await chromium.launch({headless:true,executablePath:process.env.WATCH_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext();
  await context.route('https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js',r=>r.fulfill({path:path.join(fixtures,'hls.min.js'),contentType:'application/javascript'}));
  await context.route('https://cdn.socket.io/4.6.0/socket.io.min.js',r=>r.fulfill({path:path.join(fixtures,'socket.io.min.js'),contentType:'application/javascript'}));
  await context.route('https://fonts.googleapis.com/**',r=>r.abort());
  const page=await context.newPage();
  const pageErrors=[]; page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(`${base}/test/login/0`,{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>fetch('/test/start',{method:'POST'}));
  await page.waitForFunction(()=>Array.isArray(hls?.levels)&&hls.levels.length===3,{timeout:30000});
  await page.waitForFunction(()=>!video.paused,{timeout:30000});
  await page.waitForFunction(()=>hls.currentLevel===2 || hls.nextLevel===2);
  assert.deepEqual(await page.evaluate(()=>hls.levels.map(level=>level.height)),[480,720,1080]);
  for(const [value,index] of [['native',2],['720',1],['480',0],['auto',-1]]){
   await page.locator('#live-quality-cog').click();
   await page.locator('#live-quality-panel').waitFor({state:'visible'});
   await page.locator('#live-quality-select').selectOption(value);
   await page.waitForFunction(i=>hls.currentLevel===i || hls.nextLevel===i,index);
   if (value !== 'auto') {
    const expected = index === 0 ? 480 : index === 1 ? 720 : 1080;
    await page.waitForFunction(h => video.videoHeight === h, expected);
   }
   assert.equal(await page.locator('#live-quality-select').inputValue(),value);
   await page.locator('#live-quality-cog').click();
  }
  assert.deepEqual(pageErrors,[],'quality control has no browser errors');
  console.log('PASS actual HLS master playlist exposes 3 levels and native/720p/480p/Auto selection switches levels');
  await context.close();
 } finally {
  try{await fetch(`${base}/test/stop`,{method:'POST'});}catch{}
  if(browser)await browser.close();
  if(server)server.kill();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
