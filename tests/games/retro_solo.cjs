const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
 try {for(const game of ['mk64','fzerox']) {
 const context=await browser.newContext(),page=await context.newPage();
 await page.goto('http://127.0.0.1:8066/test-login/solo-'+game);
 await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption(game);
 await page.locator('#retro-room-name').fill('Solo '+game);await page.locator('#retro-room-create').click();
 await page.locator('#retro-lobby').waitFor();assert.equal(await page.locator('#retro-lobby-art').getAttribute('data-game'),game);
 assert.equal(await page.locator('#retro-start-race').isDisabled(),true);
 await page.locator('#retro-ready').click();await page.locator('#retro-start-race').click();
 await page.waitForFunction(()=>window.retroNetplay?.frame>180,null,{timeout:120000});
 assert.equal(await page.evaluate(()=>retroNetplay.players),1);assert.equal(await page.evaluate(()=>retroNetplay.failed),false);
 console.log(game+' solo runtime advanced past 180 frames.');await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
