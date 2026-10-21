/* Uses an isolated Flask fixture; no production databases or game runtimes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH});
 try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const rendered = process.env.RETRO_CONTROLLER_HTML ? fs.readFileSync(process.env.RETRO_CONTROLLER_HTML, 'utf8') :
   execFileSync(process.env.PYTHON || '.venv/bin/python', ['-c', `
import sys, tempfile
from pathlib import Path
sys.path.insert(0, 'tests/games')
from retro_test import make_app
with tempfile.TemporaryDirectory() as instance:
    app, _ = make_app(Path(instance))
    with app.test_client() as client:
        print(client.get('/test-login/test', follow_redirects=True).text)
`], {encoding:'utf8'});
  const html = rendered.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  await page.route('http://retro.test/**', r => r.fulfill({contentType:'text/html',body:html}));
  await page.goto('http://retro.test/');
  await page.evaluate(() => {
   window.pads = [{connected:true,id:'Test controller',mapping:'standard',index:0,
    buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]}];
   Object.defineProperty(navigator,'getGamepads',{value:()=>pads});
   window.PeakNet = {adapters:new Map()};
   window.GameFullscreen = {create:()=>({bindSurface(){}})};
  });
  for (const script of ['mk64_gamepad.js','retro_controller.js','n64_touch.js','mk64_touch.js','mario_kart_64.js','netplay/fps_input.js','netplay/perfectdark_engine.js',
   'netplay/wasm_frame_adapter.js','netplay/fzerox_adapter.js','netplay/smash64_adapter.js','netplay/perfectdark_adapter.js'])
   await page.addScriptTag({path:path.resolve('static/js',script)});
  await page.evaluate(() => RetroControllers.create('mk64'));
  for (const id of ['mk64','fzerox','smash64','perfectdark']) {
   await page.evaluate(id => document.getElementById(id+'-play-area').hidden=false,id);
   const panel=page.locator(`#${id}-controller-panel`);
   await panel.locator('summary').click();
   assert.ok(await panel.locator('button[data-control]').count()>=14);
   assert.match(await page.locator(`#${id}-controller-status`).textContent(),/Controls ready/);
  }
  // A remap in one N64 game is immediately used in the others and saved for reload.
  await page.locator('#fzerox-controller-bindings [data-control=a]').click();
  assert.equal(await page.evaluate(()=>RetroControllers.create('fzerox').read().buttons),0);
  await page.waitForTimeout(220);
  await page.evaluate(()=>pads[0].buttons[2].pressed=true);
  await page.waitForFunction(()=>document.getElementById('fzerox-controller-step').textContent.includes('A saved'));
  for (const id of ['mk64','fzerox','smash64'])
   assert.equal(await page.evaluate(id=>RetroControllers.create(id).read().buttons,id),0x8000);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('mk64-gamepad-profiles-v1'))[mk64Gamepad.signature(pads[0])].bindings.a.indices[0]),2);
  await page.evaluate(()=>pads[0].buttons[2].pressed=false);
  await page.locator('#smash64-controller-deadzone').fill('40');
  await page.evaluate(()=>pads[0].axes[0]=0.3);
  assert.equal(await page.evaluate(()=>RetroControllers.create('fzerox').read().x),0);
  // Perfect Dark uses its own action bindings and both sticks, with remaps reaching FPS input.
  await page.locator('#perfectdark-controller-bindings [data-control=fire]').click();
  await page.waitForTimeout(220);
  await page.evaluate(()=>pads[0].buttons[8].pressed=true);
  await page.waitForFunction(()=>document.getElementById('perfectdark-controller-step').textContent.includes('Fire saved'));
  const fps = await page.evaluate(()=>{
   const c=RetroControllers.create('perfectdark');
   pads[0].axes=[0.75,-0.5,0.5,-0.75];
   const canvas=document.createElement('canvas');document.body.append(canvas);
   const input=new PeakNet.FpsInput({element:canvas,controllerInput:()=>{
    const s=c.read();return {buttons:s.buttons,moveX:s.x/80,moveY:-s.y/80,lookX:s.lookX/80,lookY:s.lookY/80};
   }});
   const result=input.sampleInput();input.destroy();return result;
  });
  assert.equal(fps.buttons,1);assert.ok(fps.moveX>0 && fps.moveY>0 && fps.lookX>0 && fps.lookY<0);
  // Reset cancels a pending capture; disconnect disables the panel without throwing.
  await page.locator('#perfectdark-controller-setup').click();
  await page.locator('#perfectdark-controller-reset').click();
  assert.equal(await page.locator('#perfectdark-controller-cancel').isVisible(),false);
  await page.evaluate(()=>{pads=[];window.dispatchEvent(new Event('gamepaddisconnected'));});
  assert.equal(await page.locator('#fzerox-controller-deadzone').isDisabled(),true);
  assert.deepEqual(errors,[]);
  console.log('All four controller panels, shared remapping, dead zone, FPS input, reset and disconnect passed.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
