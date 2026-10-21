// Verify four independent browser simulations with different pad inputs.
const {chromium} = require(process.env.MK64_PLAYWRIGHT || 'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.MK64_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--enable-unsafe-swiftshader']});
  const pages = [];
  const errors = [];
  try {
    for (let slot = 0; slot < 4; slot++) {
      const page = await browser.newPage();
      pages.push(page);
      page.on('pageerror', error => errors.push({slot, message: error.message}));
      await page.addInitScript(localSlot => {
        window.mk64Multiplayer = true;
        window.mk64LocalSlot = localSlot;
        window.mk64PlayerCount = 4;
        window.mk64InputsAtFrame = frame => Array.from({length: 4}, (_, player) => ({
          buttons: frame >= 180 && frame < 540 ? 0x8000 : 0,
          x: frame >= 340 && frame < 410 ? [-60, -25, 25, 60][player] : 0,
          y: 0
        }));
      }, slot);
    }
    await Promise.all(pages.map(page => page.goto('http://127.0.0.1:8066/')));
    await Promise.all(pages.map(page => page.waitForFunction(() => window.mk64?._web_frame() >= 510, {}, {timeout: 120000})));
    const traces = await Promise.all(pages.map(page => page.evaluate(() => ({
      frame: mk64._web_frame(), race: mk64._web_race_state(),
      players: Array.from({length: 4}, (_, slot) => [0, 1, 2].map(axis => mk64._web_player_position(slot, axis))),
      hashes: Array.from({length: 300}, (_, index) => mk64._web_hash_for_frame(200 + index) >>> 0)
    }))));
    const mismatches = traces[0].hashes.reduce((count, hash, index) => count + traces.slice(1).filter(trace => trace.hashes[index] !== hash).length, 0);
    console.log(JSON.stringify({frames: traces.map(trace => trace.frame), races: traces.map(trace => trace.race), players: traces.map(trace => trace.players), mismatches, errors}, null, 2));
    assert.deepEqual(errors, []);
    assert.ok(traces.every(trace => trace.race === 3));
    assert.ok(traces.every(trace => trace.hashes.every(Boolean)));
    assert.equal(mismatches, 0);
    assert.equal(new Set(traces[0].players.map(position => position.join(','))).size, 4);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
