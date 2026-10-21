/* Isolated fixture: retro_test.py --serve --perfectdark. No production DB. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {}),
        args: ['--autoplay-policy=no-user-gesture-required']});
    const errors = [], logs = [];
    try {
        const page = await browser.newPage({viewport: {width: 1100, height: 1000}});
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') logs.push(message.text()); });
        await page.request.get('http://127.0.0.1:8066/test-login/pd-preview');
        const response = await page.goto('http://127.0.0.1:8066/games/retro/preview/perfectdark');
        assert.equal(response.status(), 200);
        await page.locator('#start').click();
        await page.waitForFunction(() => window.peakPdError || (window.Module?._peakPdLevelFrame?.() > 120), null, {timeout: 120000});
        assert.equal(await page.evaluate(() => window.peakPdError || null), null);
        assert.equal(await page.evaluate(() => Module._peakPdStage()), 0x5a, 'Original title-stage startup must be retained.');
        assert.equal(await page.evaluate(() => Module._peakPdInterpolation()), 0);
        await page.locator('#volume').fill('25');
        assert.equal(await page.evaluate(() => Module.peakAudioGain.gain.value), 0.25);
        await page.locator('#screen').hover();
        await page.locator('#fullscreen').click();
        await page.waitForFunction(() => document.fullscreenElement?.id === 'screen');
        assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'screen');
        await page.evaluate(() => document.exitFullscreen());
        await page.locator('#canvas').focus();
        await page.waitForFunction(() => Module._peakPdLevelFrame() > 1100, null, {timeout: 90000});
        await page.locator('#canvas').screenshot({path: '.tmp/perfectdark/title.png'});
        const audio = await page.evaluate(() => ({state: Module.pdAudioContext.state, queued: Module.pdAudio.nextTime > 0}));
        assert.equal(audio.state, 'running'); assert.equal(audio.queued, true);
        await page.keyboard.press('Tab');
        await page.waitForTimeout(2500);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2500);
        await page.locator('#canvas').screenshot({path: '.tmp/perfectdark/menu.png'});
        assert.deepEqual(errors, []);
        assert.ok(!logs.some(line => /Aborted|RuntimeError|memory access|signature mismatch/i.test(line)), logs.join('\n'));
        console.log(JSON.stringify({stage: await page.evaluate(() => Module._peakPdStage()), frames: await page.evaluate(() => Module._peakPdLevelFrame()), audio, errors, glLoaderWarnings: logs.filter(line => line.includes("GL: could not find function")).length}, null, 2));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
