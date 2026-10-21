// Start gta5_browser_server.py first. Requires a real WebGPU-capable browser.
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require(path.join(process.env.HOME,
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));

(async () => {
  const browser = await chromium.launch({
    headless: process.env.GTA_HEADLESS === '1',
    executablePath: process.env.CHROME_PATH || path.join(process.env.HOME,
      '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
    args: ['--enable-unsafe-webgpu', '--use-angle=gl', '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 720}});
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('response', response => {
      // Cached batches are optional: a miss falls back to the POST endpoint.
      if (response.status() >= 400 && !response.url().includes('/batchc/'))
        failures.push(response.status() + ' ' + response.url());
    });
    const base = 'http://127.0.0.1:8077';
    await page.goto(base + '/test-login/browser-smoke');
    await page.goto(base + '/games/gta5');
    await page.waitForFunction(() => !document.getElementById('gta-launch').hidden);
    await page.screenshot({path: '.tmp/gta5-landing.png'});
    const mode = process.env.GTA_MODE || 'sandbox';
    await page.goto(base + `/games/gta5/play?mode=${mode}&low=1&fps=30&res=1280x720&cores=4`);
    assert(await page.evaluate(() => crossOriginIsolated));
    await page.evaluate(() => {
      window.gtaPresented = 0;
      new BroadcastChannel('game-fps').onmessage = event => { window.gtaPresented += event.data.fps; };
    });
    await page.waitForFunction(() => !document.getElementById('loading') && window.gtaPresented > 10,
      null, {timeout: 180000});
    await page.locator('canvas').screenshot({path: `.tmp/gta5-${mode}-world.png`});
    await page.locator('canvas').click();
    await page.keyboard.down('w');
    await page.waitForTimeout(1500);
    await page.keyboard.up('w');
    await page.locator('canvas').screenshot({path: `.tmp/gta5-${mode}-input.png`});
    assert.deepEqual(failures, []);
    console.log('PASS: browser checks, authenticated runtime, isolation, world startup, frames and keyboard input sent. Inspect screenshots for rendering.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
