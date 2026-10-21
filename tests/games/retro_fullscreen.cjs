const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
 try {for(const game of (process.env.RETRO_TEST_GAMES || 'mk64,fzerox').split(',')) {
 const context=await browser.newContext(),page=await context.newPage();
 await page.goto('http://127.0.0.1:8066/test-login/solo-'+game);
 await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption(game);
 await page.locator('#retro-room-name').fill('Solo '+game);await page.locator('#retro-room-create').click();
 await page.locator('#retro-lobby').waitFor();assert.equal(await page.locator('#retro-lobby-art').getAttribute('data-game'),game);
 assert.equal(await page.locator('#retro-start-race').isDisabled(),true);
 await page.locator('#retro-ready').click();await page.locator('#retro-start-race').click();
 await page.waitForFunction(()=>window.retroNetplay?.frame>180,null,{timeout:120000});
 assert.equal(await page.evaluate(()=>retroNetplay.players),1);assert.equal(await page.evaluate(()=>retroNetplay.failed),false);
 const area=page.locator('#'+game+'-play-area');
 const button=area.locator(game==='mk64'?'#mk64-fullscreen':'[data-game-fullscreen]');
 const surface=area.locator(game==='mk64'?'#mk64-canvas':'.retro-game-frame');
 await surface.hover();await button.click();
 await page.waitForFunction(()=>!!document.fullscreenElement);
 await surface.hover({position:{x:30,y:30}});
 await page.waitForTimeout(2300);
 assert.equal(await button.evaluate(e=>getComputedStyle(e).opacity),'0');
 await surface.hover({position:{x:60,y:60}});
 await page.waitForTimeout(250);
 assert.equal(await button.evaluate(e=>getComputedStyle(e).opacity),'1');
 await button.click();await page.waitForFunction(()=>!document.fullscreenElement);
 await page.waitForTimeout(2300);await page.keyboard.press('Tab');await button.focus();await page.waitForTimeout(2300);
 assert.equal(await button.evaluate(e=>getComputedStyle(e).opacity),'1');
 console.log(game+' fullscreen entry, idle fade, pointer reveal, exit and keyboard focus passed.');await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
