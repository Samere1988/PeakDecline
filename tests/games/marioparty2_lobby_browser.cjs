const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8078/test-login/mp-lobby');
  await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption('marioparty2');
  await page.locator('#retro-room-name').fill('Mario Party 2');await page.locator('#retro-room-create').click();
  await page.locator('#retro-lobby').waitFor({state:'visible'});
  await page.locator('#retro-controller-setup #marioparty2-controller-panel').waitFor({state:'visible'});
  assert.match(await page.locator('#retro-seat-count').textContent(),/\/4 seats/);
  assert.equal(await page.locator('#retro-room-status').textContent(),'Ready up when you’re set.');
  await page.locator('#marioparty2-controller-panel summary').click();
  assert(await page.locator('#marioparty2-controller-panel').getAttribute('open')!==null);
  assert.equal(await page.locator('#marioparty2-controller-bindings').evaluate(el=>getComputedStyle(el).display),'grid');
  assert.equal(await page.locator('#retro-lobby-art').isVisible(),true);
  assert.match(await page.locator('#retro-lobby-art').evaluate(e=>getComputedStyle(e).backgroundImage),/marioparty2-title-screen.png/);
  await page.locator('#retro-choose-spectator').click();
  await page.locator('#retro-controller-setup [data-lobby-controller]').waitFor({state:'hidden'});
  await page.locator('#retro-choose-player').click();
  await page.locator('#retro-controller-setup #marioparty2-controller-panel').waitFor({state:'visible'});
  await page.screenshot({path:'.tmp/marioparty2-lobby.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: shared four-seat lobby, spectator role, controller setup, no flavour text. Game runtime was not launched.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
