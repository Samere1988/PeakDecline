const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-webgpu','--enable-gpu','--disable-gpu-sandbox','--use-angle=gl']});
 try{
  const page=await browser.newPage();let gameRequests=0;
  page.on('request',request=>{if(/opencmr2\.(js|wasm)|\/data\/cmr2\/file\//.test(request.url()))gameRequests++;});
  await page.goto('http://127.0.0.1:8088/test-login/cmr-software-'+Date.now());
  const software=await page.evaluate(async()=> (await navigator.gpu.requestAdapter()).info.isFallbackAdapter);
  assert.equal(software,true,'This fixture must use a real software adapter');
  await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption('cmr2');await page.locator('#retro-room-name').fill('Software GPU rejection');await page.locator('#retro-room-create').click();await page.locator('#retro-ready').click();await page.locator('#retro-start-race').click();
  await page.waitForFunction(()=>document.getElementById('retro-runtime-status').textContent.match(/software graphics|graphics card/i),null,{timeout:30000});
  assert.equal(gameRequests,0,'Reject software graphics before downloading the native runtime or game data');
  console.log('PASS software GPU produces an actionable error before game download');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
