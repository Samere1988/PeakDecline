/* Uses an isolated fixture and the installed native Smash runtime. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8066/test-login/telemetry');
 await page.waitForFunction(()=>PeakNet.Telemetry&&PeakNet.adapters.has('smash64'));
 await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption('smash64');
 await page.locator('#retro-room-name').fill('Telemetry regression');await page.locator('#retro-room-create').click();
 await page.locator('#retro-ready').click();await page.locator('#retro-start-race').click();
 await page.waitForFunction(()=>window.retroNetplay,null,{timeout:30000});
 await page.evaluate(()=>{window.reports=[];retroNetplay.socket.onAnyOutgoing((name,data)=>{if(name==='diagnostics')reports.push(data);});});
 await page.waitForFunction(()=>reports.some(r=>r.frames>30&&r.inactiveMs<1000),null,{timeout:60000});
 const report=await page.evaluate(()=>reports.at(-1));
 assert.ok(report.frames>30);assert.ok(report.displayFrames>0);assert.ok(report.probes>0);assert.ok(report.rttMs>=0);
 assert.equal(await page.evaluate(()=>retroNetplay.failed),false);assert.deepEqual(errors,[]);
 console.log('Native game reports automatically:',JSON.stringify(report));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
