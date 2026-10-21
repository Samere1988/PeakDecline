// Run against dev_server.py. A boot is not a gameplay or multiplayer certification.
const {chromium} = require(process.env.MK64_PLAYWRIGHT || 'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.MK64_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
 try {
  const page = await browser.newPage();
  const errors=[];
  page.on('console', message => { if(message.type()==='error') console.log(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8064/');
  await page.waitForTimeout(12000);
  await page.screenshot({path:path.resolve(__dirname,'../../.tmp/mk64/browser.png')});
  const before = await page.evaluate(()=>({frame:window.mk64?._web_frame(),menu:window.mk64?._web_menu()}));
  assert.ok(before.frame>120,'The native game loop must advance beyond startup');
  await page.keyboard.down('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.up('Enter');
  await page.waitForTimeout(3000);
  await page.screenshot({path:path.resolve(__dirname,'../../.tmp/mk64/menu.png')});
  const after = await page.evaluate(()=>({frame:window.mk64?._web_frame(),menu:window.mk64?._web_menu(),error:window.mk64Error||null}));
  assert.ok(after.frame>before.frame+30,'The native game loop must continue');
  assert.notEqual(after.menu,before.menu,'Start must change the game menu');
  assert.equal(after.error,null); assert.deepEqual(errors,[]);
  console.log('PASS native WASM boot and Start navigation',JSON.stringify({before,after}));
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
