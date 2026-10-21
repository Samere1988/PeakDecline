const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try {
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8066/test-login/dimensions');
 await page.waitForFunction(()=>document.querySelector('#retro-browser-notice').textContent!=='Connecting to game rooms…');
 for(const [width,height,touch] of [[1440,1000,false],[800,700,false],[390,844,true],[844,390,true]]) {
 await page.setViewportSize({width,height});
 const sizes=[];
 for(const game of ['mk64','fzerox']) {
 await page.evaluate(({game,touch})=>{
 document.querySelectorAll('.mk64-play-area').forEach(e=>e.hidden=true);
 const area=document.getElementById(game+'-play-area');area.hidden=false;
 const shell=area.querySelector('.game-viewport');shell.classList.toggle('mk64-touch-layout',touch);
 shell.querySelector('.game-surface').hidden=false;shell.querySelector('.mk64-touch-controls').hidden=!touch;
 },{game,touch});
 const shell=page.locator('#'+game+'-play-area .game-viewport');
 const dimensions=()=>shell.evaluate(e=>[e,e.querySelector('.game-surface')].map(n=>{const b=n.getBoundingClientRect();return [b.width,b.height]}));
 const normal=await dimensions();await shell.evaluate(e=>e.requestFullscreen());
 await page.waitForFunction(()=>!!document.fullscreenElement);
 const full=await dimensions();await page.evaluate(()=>document.exitFullscreen());
 sizes.push({normal,full});
 }
 assert.deepEqual(sizes[0],sizes[1]);console.log(width+'x'+height,JSON.stringify(sizes[0]));
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
