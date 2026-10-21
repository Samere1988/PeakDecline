const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.mk64Multiplayer = true; window.mk64NativeMenus = true; window.mk64PlayerCount = 2;
      window.testPads = [{buttons: 0, x: 0, y: 0}, {buttons: 0, x: 0, y: 0}];
      window.mk64InputsAtFrame = () => window.testPads;
    });
    await page.goto('http://127.0.0.1:8066/');
    await page.waitForFunction(() => window.mk64?._web_frame() >= 250, {}, {timeout: 45000});
    const state = () => page.evaluate(() => ({frame: mk64._web_frame(), menu: mk64._web_menu(), game: mk64._web_state(), race: mk64._web_race_state()}));
    console.log('Idle', await state(), errors);
    await page.locator('canvas').screenshot({path: path.resolve(__dirname, '../../.tmp/mk64/native-idle.png')});
    async function tap(slot, field, value) {
      await page.evaluate(([s, f, v]) => { testPads[s][f] = v; }, [slot, field, value]);
      await page.waitForTimeout(180);
      await page.evaluate(([s, f]) => { testPads[s][f] = 0; }, [slot, field]);
      await page.waitForTimeout(900);
      console.log('Tap', slot, field, value, await state(), errors);
    }
    await tap(0, 'buttons', 0x1000);
    await page.locator('canvas').screenshot({path: path.resolve(__dirname, '../../.tmp/mk64/native-after-start.png')});
    await tap(0, 'buttons', 0x8000);
    await page.locator('canvas').screenshot({path: path.resolve(__dirname, '../../.tmp/mk64/native-after-a.png')});
    await tap(0, 'buttons', 0x4000);
    await tap(0, 'x', 80);
    await page.locator('canvas').screenshot({path: path.resolve(__dirname, '../../.tmp/mk64/native-2p.png')});
    for (let step = 0; step < 6; step++) {
      await tap(0, 'buttons', 0x8000);
      await page.locator('canvas').screenshot({path: path.resolve(__dirname, `../../.tmp/mk64/native-2p-step-${step}.png`)});
    }
    await tap(1, 'x', 80);
    await page.locator('canvas').screenshot({path: path.resolve(__dirname, '../../.tmp/mk64/native-p2-moved.png')});
    await tap(1, 'buttons', 0x8000);
    await page.locator('canvas').screenshot({path: path.resolve(__dirname, '../../.tmp/mk64/native-p2-confirmed.png')});
    for (let step = 0; step < 8; step++) {
      await tap(0, 'buttons', 0x8000);
      await page.locator('canvas').screenshot({path: path.resolve(__dirname, `../../.tmp/mk64/native-course-step-${step}.png`)});
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
