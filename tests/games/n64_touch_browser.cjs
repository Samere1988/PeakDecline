const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
 try {
 const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844},userAgent:'Mozilla/5.0 iPhone'});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8066/test-login/touch-check');
 await page.waitForFunction(()=>document.querySelector('#retro-browser-notice').textContent !== 'Connecting to game rooms…');
 for(const game of ['mk64','fzerox']) {
 await page.evaluate(game=>{
  document.querySelectorAll('.mk64-play-area').forEach(e=>e.hidden=true);
  document.querySelector('#retro-room-browser').hidden=true;
  const area=document.getElementById(game+'-play-area');area.hidden=false;
  (area.querySelector('.retro-frame-shell')||area.querySelector('.mk64-game')).classList.add('mk64-touch-layout');
  window.testTouch?.destroy();window.testTouch=N64Touch.create({overlay:document.getElementById(game+'-touch-controls')});testTouch.setEnabled(true);
 },game);
 for(const [width,height] of [[390,844],[844,390]]) {
 await page.setViewportSize({width,height});
 const overlay=page.locator('#'+game+'-touch-controls');await overlay.scrollIntoViewIfNeeded();
 assert.equal(await overlay.locator('button img').count(),11);
 assert.ok(await overlay.locator('img').evaluateAll(imgs=>imgs.every(i=>i.complete&&i.naturalWidth>0)));
 const stick=await overlay.locator('[data-n64-stick]').boundingBox(),a=await overlay.locator('[data-n64-button="a"]').boundingBox();
 const cdp=await context.newCDPSession(page);
 const points=[{id:1,x:stick.x+stick.width*.8,y:stick.y+stick.height*.5},{id:2,x:a.x+a.width/2,y:a.y+a.height/2}];
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points});
 let input=await page.evaluate(()=>testTouch.read());assert.ok(input.buttons&0x8000);assert.ok(input.x>40);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
 assert.deepEqual(await page.evaluate(()=>testTouch.read()),{buttons:0,x:0,y:0});
 await page.screenshot({path:'.tmp/retro/'+game+'-touch-'+width+'.png'});
 await cdp.detach();
 }
 }
 assert.deepEqual(errors,[]);console.log('Both layouts: images, simultaneous analog + A, and touch cancellation passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
