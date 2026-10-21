const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');

(async () => {
  const playerCount = Number(process.env.MK64_TEST_PLAYERS || 2);
  const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--enable-unsafe-swiftshader']});
  const contexts = await Promise.all(Array.from({length: playerCount}, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors = [];
  try {
    pages.forEach((page, slot) => page.on('pageerror', error => errors.push({slot, message: error.message})));
    await Promise.all(pages.map(page => page.goto('http://127.0.0.1:8066/test-login/test')));
    await pages[0].locator('#retro-open-create').click();
    await pages[0].locator('#retro-room-name').fill('Retro framework test');
    assert.equal(await pages[0].locator('#retro-game-select').inputValue(), 'mk64');
    await pages[0].locator('#retro-room-create').click();
    await pages[0].locator('#retro-lobby').waitFor();
    for (const page of pages.slice(1)) {
      await page.getByRole('button', {name: 'Join room'}).click();
      await page.locator('#retro-lobby').waitFor();
    }
    for (const page of pages) { await page.locator('#retro-choose-player').click(); await page.locator('#retro-ready').click(); }
    await pages[0].screenshot({path: '.tmp/retro/lobby.png'});
    await pages[0].locator('#retro-start-race').click();
    await Promise.all(pages.map(page => page.waitForFunction(() => window.mk64 && mk64._web_frame() >= 250, {}, {timeout: 90000})));
    if (process.env.MK64_TEST_BACKGROUND) {
      const other = await contexts[0].newPage();
      await other.goto('about:blank');
      await other.bringToFront();
      const before = await Promise.all(pages.map(page => page.evaluate(() => mk64._web_frame())));
      await other.waitForTimeout(5000);
      const after = await Promise.all(pages.map(page => page.evaluate(() => mk64._web_frame())));
      console.log('Background progress', before, after);
      assert.ok(after.every((frame, slot) => frame - before[slot] >= 75));
      await other.close();
    }
    assert.ok((await Promise.all(pages.map(page => page.evaluate(() => retroNetplay.core._pn_ready instanceof Function)))).every(Boolean));
    await Promise.all(pages.map(page => page.locator('#mk64-canvas').focus()));
    const state = () => Promise.all(pages.map(page => page.evaluate(() => ({frame: mk64._web_frame(), menu: mk64._web_menu(), game: mk64._web_state(), race: mk64._web_race_state(), status: document.querySelector('#retro-room-status').textContent}))));
    async function tap(slot, key) {
      await pages[slot].keyboard.down(key);
      await pages[slot].waitForTimeout(180);
      await pages[slot].keyboard.up(key);
      await pages[slot].waitForTimeout(900);
      console.log(slot, key, (await state()).map(({frame, menu, game, race}) => ({frame, menu, game, race})));
    }
    await tap(0, 'Enter');
    await tap(0, 'x');
    await tap(0, 'c');
    for (let i = 1; i < playerCount; i++) await tap(0, 'ArrowRight');
    for (let i = 0; i < 6; i++) await tap(0, 'x');
    for (let slot = 1; slot < playerCount; slot++) {
      await tap(slot, 'ArrowRight');
      await tap(slot, 'x');
    }
    for (let i = 0; i < 6; i++) await tap(0, 'x');
    await Promise.all(pages.map(page => page.waitForFunction(() => mk64._web_frame() >= 1150, {}, {timeout: 120000})));
    await pages[0].screenshot({path: '.tmp/retro/race.png'});
    const result = await Promise.all(pages.map(page => page.evaluate(() => ({state: {frame: mk64._web_frame(), menu: mk64._web_menu(), game: mk64._web_state(), race: mk64._web_race_state()}, hashes: Array.from({length: 300}, (_, i) => mk64._web_hash_for_frame(850 + i) >>> 0)}))));
    console.log(JSON.stringify({states: result.map(row => row.state), mismatchCount: result[0].hashes.filter((hash, i) => hash !== result[1].hashes[i]).length, errors}));
    assert.deepEqual(errors, []);
    assert.ok(result.every(row => row.state.game === 4));
    assert.ok(result.every(row => row.state.race === 3));
    for (const row of result.slice(1)) assert.deepEqual(result[0].hashes, row.hashes);
    const beforePositions = await pages[0].evaluate(total => Array.from({length:total}, (_, slot) => mk64._web_player_position(slot, 2)), playerCount);
    const driveFrom = Math.max(...result.map(row => row.state.frame));
    for (const page of pages) await page.keyboard.down('x');
    await pages[1].keyboard.down('ArrowRight');
    await Promise.all(pages.map(page => page.waitForFunction(frame => mk64._web_frame() > frame + 120, driveFrom, {timeout:30000})));
    const driven = await Promise.all(pages.map(page => page.evaluate(({total, frame}) => ({
      hashes:Array.from({length:50},(_,i)=>mk64._web_hash_for_frame(frame+50+i)>>>0),
      positions:Array.from({length:total},(_,slot)=>mk64._web_player_position(slot,2))
    }), {total:playerCount,frame:driveFrom})));
    for (const row of driven.slice(1)) assert.deepEqual(row.hashes, driven[0].hashes);
    assert.ok(driven[0].positions.every((value,slot) => Number.isFinite(value) && Math.abs(value-beforePositions[slot])>1));
    for (const page of pages) await page.keyboard.up('x');
    await pages[1].keyboard.up('ArrowRight');
    if (true) {
      await pages[0].locator('#mk64-restart').click();
      await Promise.all(pages.map(page => page.waitForFunction(() => window.mk64 && mk64._web_frame() < 150, {}, {timeout: 60000})));
      await Promise.all(pages.map(page => page.waitForFunction(() => mk64._web_frame() >= 240, {}, {timeout: 60000})));
      const restarted = await Promise.all(pages.map(page => page.evaluate(() => ({frame: mk64._web_frame(), title: document.querySelector('#mk64-play-title').textContent, hashes: Array.from({length: 100}, (_, i) => mk64._web_hash_for_frame(130 + i) >>> 0)}))));
      console.log('Restarted', restarted.map(({hashes, ...rest}) => rest));
      assert.ok(restarted.every(row => row.title.includes('Retro framework test') && row.hashes.every(Boolean)));
      for (const row of restarted.slice(1)) assert.deepEqual(restarted[0].hashes, row.hashes);
      assert.deepEqual(errors, []);
    }
    await pages[1].locator('#retro-return').click();
    await pages[0].waitForFunction(() => document.querySelector('#retro-runtime-status').textContent.includes('A player left'));
    assert.equal(await pages[0].evaluate(() => retroNetplay.failed), true);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
