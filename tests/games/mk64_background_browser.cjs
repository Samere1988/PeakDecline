const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--enable-unsafe-swiftshader']});
  try {
    const context = await browser.newContext();
    const game = await context.newPage();
    await game.goto('http://127.0.0.1:8067/');
    await game.waitForFunction(() => window.mk64?._web_frame() >= 180, {}, {timeout: 45000});
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    const start = await game.evaluate(() => mk64._web_frame());
    await other.waitForTimeout(5000);
    const end = await game.evaluate(() => mk64._web_frame());
    console.log({start, end, advanced: end - start});
    assert.ok(end - start >= 75, 'The background game must continue sending frames');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
