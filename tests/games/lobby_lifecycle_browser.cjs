/* Real engines, separate browser accounts, and an isolated loopback server. */
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const base = process.env.LOBBY_TEST_URL || 'http://127.0.0.1:8079';
assert.equal(new URL(base).hostname, '127.0.0.1');
(async () => {
    const browser = await chromium.launch({headless: true,
        executablePath: process.env.BROWSER_PATH || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
        args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']});
    const errors = [];
    try {
        const pages = [];
        for (let i = 0; i < 3; i++) {
            const page = await (await browser.newContext({viewport: {width: i === 1 ? 1280 : 390, height: 900}})).newPage();
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(base + '/test-login/lifecycle-' + i);
            pages.push(page);
        }
        const [host, player, watcher] = pages;
        await host.locator('#retro-open-create').click();
        await host.locator('#retro-room-name').fill('Persistent room');
        await host.locator('#retro-room-create').click();
        await host.locator('#retro-lobby').waitFor();
        const invite = await host.locator('#retro-invite').inputValue();
        await player.goto(invite);
        await player.locator('#retro-choose-player').click();
        for (const page of [host, player]) await page.locator('#retro-ready').click();
        await host.locator('#retro-start-race').click();
        await host.waitForFunction(() => window.mk64?._web_frame() > 90, {}, {timeout: 90000});
        console.log('MK64 running; room remains visible.');
        await watcher.getByRole('button', {name: 'Spectate', exact: true}).click();
        await watcher.waitForFunction(() => window.retroNetplay?.frame > 3, {}, {timeout: 30000});
        await watcher.evaluate(() => {
            window.spectatorAudioPackets = 0;
            retroNetplay.socket.on('spectator_media', event => { if (event.kind === 'audio') spectatorAudioPackets++; });
        });
        await watcher.locator('#retro-spectator-sound').click();
        await watcher.waitForFunction(() => spectatorAudioPackets > 2, {}, {timeout: 15000});
        assert.equal(await watcher.evaluate(() => retroNetplay.spectator), true);
        assert.equal(await watcher.locator('#retro-close-game').isHidden(), true);
        assert.equal(await watcher.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        const colors = await watcher.evaluate(() => {
            const canvas = document.getElementById('retro-spectator-canvas'), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            const values = new Set(); for (let i = 0; i < pixels.length; i += 64) values.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`);
            return values.size;
        });
        assert.ok(colors > 10, 'Spectator sees rendered pixels, not an empty canvas');
        await watcher.screenshot({path: '.tmp/lobby-live-spectator.png', fullPage: true});
        assert.equal(await host.getByText('Account saves ready.', {exact: true}).count(), 0);
        assert.equal(await host.evaluate(() => document.getElementById('mk64-game').contains(document.getElementById('retro-close-game'))), false);
        await host.locator('#retro-close-game').click();
        for (const page of pages) await page.locator('#retro-lobby').waitFor();
        assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await host.screenshot({path: '.tmp/lobby-host-mobile.png', fullPage: true});
        for (const page of [host, player]) assert.equal(await page.locator('#retro-choose-player').getAttribute('aria-pressed'), 'true');
        assert.equal(await watcher.locator('#retro-choose-spectator').getAttribute('aria-pressed'), 'true');
        assert.equal(await host.locator('#retro-invite').inputValue(), invite);
        console.log('Late spectator saw live pixels; all members returned with their roles.');
        await player.locator('#retro-choose-spectator').click();
        await watcher.locator('#retro-choose-player').click();
        await host.locator('#retro-next-game').selectOption(process.env.NEXT_GAME || 'fzerox');
        await host.locator('#retro-apply-game').click();
        await watcher.waitForFunction(id => JSON.parse(document.getElementById('retro-catalog').textContent).find(g => g.id === id).title === document.getElementById('retro-game-title').textContent, process.env.NEXT_GAME || 'fzerox');
        await player.locator('#retro-leave-room').click();
        for (const page of [host, watcher]) await page.locator('#retro-ready').click();
        await host.locator('#retro-start-race').click();
        for (const page of [host, watcher]) await page.waitForFunction(() => window.retroNetplay?.running && retroNetplay.frame > 90, {}, {timeout: 120000});
        assert.equal(await watcher.evaluate(() => retroNetplay.spectator), false);
        assert.equal(await watcher.evaluate(() => retroNetplay.slot), 1);
        console.log('Changed games in the same room; late viewer is now playing.');
        await player.getByRole('button', {name: 'Spectate', exact: true}).click();
        await player.waitForFunction(() => window.retroNetplay?.spectator && retroNetplay.frame > 3, {}, {timeout: 30000});
        await host.locator('#retro-close-game').click();
        for (const page of pages) await page.locator('#retro-lobby').waitFor();
        await watcher.screenshot({path: '.tmp/lobby-returned-mobile.png', fullPage: true});
        assert.equal(await watcher.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        console.log('Second game also accepts late spectators. Browser lifecycle checks passed.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
