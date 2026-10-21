/* Run against mk64_retro_server.py; never connects to production. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require(process.env.MK64_PLAYWRIGHT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const base = process.env.MK64_TEST_URL || 'http://127.0.0.1:8068';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Integration fixture must be local');
const count = Number(process.env.MK64_TEST_PLAYERS || 2);
assert([1, 2, 3, 4].includes(count));
const output = process.env.MK64_TEST_OUTPUT || path.resolve(__dirname, '../../.tmp/mk64-netplay-20261013');
fs.mkdirSync(output, {recursive: true});

(async () => {
    const launchBrowser = () => chromium.launch({headless: true,
        executablePath: process.env.MK64_BROWSER || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
        args: [...(process.env.MK64_TEST_GPU === 'hardware' ? ['--enable-gpu', '--disable-gpu-sandbox', '--use-angle=gl'] : ['--enable-unsafe-swiftshader']), '--autoplay-policy=no-user-gesture-required']});
    const browsers = [await launchBrowser()];
    const sharedBrowser = process.env.MK64_TEST_SHARED_BROWSER === '1';
    const pages = [], errors = [], report = {players: count, sharedBrowser, checks: []};
    let delayedMessages = 0;
    const delay = Number(process.env.MK64_TEST_NETWORK_DELAY || 0);
    const jitter = Number(process.env.MK64_TEST_JITTER || 0);
    async function state() {
        return Promise.all(pages.map(p => p.evaluate(() => ({frame: mk64._web_frame(),
            menu: mk64._web_menu(), stage: mk64._web_main_menu_selection(), race: mk64._web_race_state(), game: mk64._web_state(),
            players: mk64._web_selected_players(), selected: Array.from({length: 4}, (_, i) => mk64._web_character_selected(i)),
            rendered: mk64._web_render_frames(), interpolated: mk64._web_interpolated_matrices(),
            width: document.querySelector('#mk64-canvas').width, height: document.querySelector('#mk64-canvas').height, hd: mk64.mk64HD?.stats, aa: mk64._web_aa_frames?.(),
            failed: retroNetplay.failed, lead: retroNetplay.lead, status: document.querySelector('#retro-runtime-status').textContent}))));
    }
    async function tap(slot, key, after = 650) {
        const p = pages[slot];
        await p.locator('#mk64-canvas').focus();
        await p.keyboard.down(key); await p.waitForTimeout(200); await p.keyboard.up(key);
        await p.waitForTimeout(after);
    }
    async function compareHashes(length = 100) {
        const through = Math.min(...(await state()).map(s => s.frame)) - 3;
        const rows = await Promise.all(pages.map(p => p.evaluate(({through, length}) =>
            Array.from({length}, (_, i) => mk64._web_hash_for_frame(through - i) >>> 0), {through, length})));
        assert(rows.every(row => row.every(Boolean)), 'Completed hashes must exist');
        for (const row of rows.slice(1)) assert.deepEqual(row, rows[0], 'Peers must have identical simulation hashes');
        return {through, length};
    }
    try {
        for (let slot = 0; slot < count; slot++) {
            // Separate browser processes model separate players' graphics devices;
            // sharing one SwiftShader GPU process serializes all split-screen views.
            if (slot && !sharedBrowser) browsers.push(await launchBrowser());
            const context = await browsers[sharedBrowser ? 0 : slot].newContext();
            const p = await context.newPage(); pages.push(p);
            p.on('pageerror', e => errors.push({slot, message: e.message}));
            if ((delay || jitter) && slot === count - 1) await p.routeWebSocket('**/socket.io/**', socket => {
                const server = socket.connectToServer();
                function forward(destination) {
                    let previous = 0;
                    return message => {
                        const at = Date.now();
                        const requested = at + delay + (++delayedMessages % 60 === 0 ? jitter : 0);
                        previous = Math.max(previous, requested);
                        setTimeout(() => { try { destination.send(message); } catch {} }, previous - at);
                    };
                }
                socket.onMessage(forward(server)); server.onMessage(forward(socket));
            });
            await p.addInitScript(() => {
                window.testAudioBuffers = 0;
                const original = AudioBufferSourceNode.prototype.start;
                AudioBufferSourceNode.prototype.start = function(...args) {
                    if (this.buffer?.getChannelData(0).some(x => Math.abs(x) > .005)) window.testAudioBuffers++;
                    return original.apply(this, args);
                };
            });
            await p.goto(base + '/test-login/mk64-integration-' + slot);
        }
        const host = pages[0];
        await host.locator('#retro-open-create').click();
        await host.locator('#retro-game-select').selectOption('mk64');
        await host.locator('#retro-room-name').fill('MK64 integration ' + count);
        await host.locator('#retro-room-create').click();
        for (const p of pages.slice(1)) await p.getByRole('button', {name: 'Join room', exact: true}).click();
        for (const p of pages) {
            await p.locator('#retro-choose-player').click();
            await p.locator('#retro-ready').click();
        }
        await host.locator('#retro-start-race').click();
        await Promise.all(pages.map(p => p.waitForFunction(() => window.mk64?._web_frame() >= 250, null, {timeout: 90000})));
        report.boot = await state();
        assert(report.boot.every(s => !s.failed));
        report.checks.push('boot');
        for (let attempt = 0; attempt < 10; attempt++) {
            const current = (await state())[0];
            if (current.menu === 11 && current.stage === 3) break;
            await tap(0, current.menu === 10 ? 'Enter' : 'c');
        }
        assert.equal((await state())[0].stage, 3, 'Must reach player-count selection');
        for (let attempt = 0; attempt < 6; attempt++) {
            const selected = (await state())[0].players;
            if (selected === count) break;
            await tap(0, selected < count ? 'ArrowRight' : 'ArrowLeft');
        }
        assert((await state()).every(s => s.players === count));
        for (let attempt = 0; attempt < 8 && (await state())[0].menu !== 12; attempt++) await tap(0, 'x');
        assert.equal((await state())[0].menu, 12, 'Character selection must open');
        for (let slot = 0; slot < count; slot++) {
            for (let attempt = 0; attempt < 8 && !(await state())[0].selected[slot]; attempt++) {
                if (attempt) await tap(slot, 'ArrowRight');
                await tap(slot, 'x');
            }
            assert((await state())[0].selected[slot], `Player ${slot + 1} must choose a character`);
        }
        for (let attempt = 0; attempt < 12 && (await state())[0].game !== 4; attempt++) await tap(0, 'x');
        await Promise.all(pages.map(p => p.waitForFunction(() => mk64._web_race_state() === 3, null, {timeout: 60000})));
        assert((await state()).every(s => s.players === count), 'Native player count must match room');
        const before = await state();
        const positions = await host.evaluate(n => Array.from({length: n}, (_, i) => mk64._web_player_position(i, 2)), count);
        const begin = Date.now();
        for (const p of pages) { await p.locator('#mk64-canvas').focus(); await p.keyboard.down('x'); }
        await host.waitForTimeout(Number(process.env.MK64_TEST_RACE_MS || 12000));
        const elapsed = Date.now() - begin;
        const after = await state();
        report.fps = after.map((s, i) => (s.frame - before[i].frame) * 1000 / elapsed);
        report.renderFps = after.map((s, i) => (s.rendered - before[i].rendered) * 1000 / elapsed);
        assert(report.fps.every(fps => fps > 25 && fps < 34), 'Simulation must retain original speed');
        assert(report.renderFps.every(fps => fps > 50 && fps < 68), 'Race must present at 60 FPS');
        assert(after.every((s, i) => s.interpolated > before[i].interpolated), 'Intermediate views must contain interpolated geometry');
        const moved = await host.evaluate(n => Array.from({length: n}, (_, i) => mk64._web_player_position(i, 2)), count);
        assert(moved.every((value, i) => Number.isFinite(value) && Math.abs(value - positions[i]) > 1));
        for (const p of pages) await p.keyboard.up('x');
        report.hashes = await compareHashes(200);
        if (process.env.MK64_TEST_HD === '1') {
            assert(after.every(s => s.width === 1920 && s.height === 1080 && s.aa > 100 && s.hd.applied > 100 && s.hd.failed === 0));
            report.graphics = after.map(s => ({width: s.width, height: s.height, aa: s.aa, hd: s.hd}));
        }
        report.audio = await Promise.all(pages.map(p => p.evaluate(() => testAudioBuffers)));
        assert(report.audio.every(n => n > 100), 'Every client must produce audio');
        await host.locator('#mk64-canvas').screenshot({path: path.join(output, `retro-${count}p-race.png`)});
        report.checks.push('race speed, controls, audio, synchronization');

        // A retained page must survive a brief transport outage with its exact pending inputs.
        if (count > 1 && !delay && !jitter) {
            const guest = pages[count - 1];
            await guest.evaluate(() => { window.beforeReconnectModule = mk64; retroNetplay.socket.io.engine.close(); });
            await guest.waitForFunction(() => retroNetplay.socket.connected && !retroNetplay.transportSuspended, null, {timeout: 20000});
            await Promise.all(pages.map(p => p.waitForFunction(f => mk64._web_frame() >= f + 120, after[0].frame, {timeout: 20000})));
            assert(await guest.evaluate(() => beforeReconnectModule === mk64));
            await compareHashes(); report.checks.push('retained reconnect');
        }
        // Hold references to old modules: the old test only checked the new instance.
        for (let restart = 0; restart < 2; restart++) {
            await Promise.all(pages.map(p => p.evaluate(() => { window.oldModule = mk64; })));
            await host.locator('#mk64-restart').click();
            await Promise.all(pages.map(p => p.waitForFunction(() => mk64 !== oldModule && mk64._web_frame() >= 100, null, {timeout: 90000})));
            const stopped = await Promise.all(pages.map(p => p.evaluate(() => oldModule._web_frame())));
            await host.waitForTimeout(1500);
            const later = await Promise.all(pages.map(p => p.evaluate(() => oldModule._web_frame())));
            assert.deepEqual(later, stopped, 'Retired simulations must stop advancing');
            await compareHashes(50);
        }
        report.checks.push('two restarts dispose old simulations');
        if (count > 1) {
            await host.evaluate(() => { window.departureModule = mk64; });
            await pages[count - 1].locator('#retro-return').click();
            // The shared lobby disposes and clears retroNetplay on failure.
            // Observe its message and the retained module, not that cleared global.
            await host.waitForFunction(() => document.querySelector('#retro-runtime-status').textContent.includes('A player left'), null, {timeout: 10000});
            // Failure reaches JavaScript before the suspended native loop has
            // returned. Cooperative shutdown may finish its current frame.
            await host.waitForFunction(() => departureModule._web_is_stopped(), null, {timeout: 2000});
            const stopped = await host.evaluate(() => departureModule._web_frame());
            await host.waitForTimeout(1200);
            assert.equal(await host.evaluate(() => departureModule._web_frame()), stopped);
            report.checks.push('departure stops native loop');
        }
        assert.deepEqual(errors, []);
        report.delayedMessages = delayedMessages;
        if (delay || jitter) assert(delayedMessages > 100);
        report.result = 'passed';
        console.log(JSON.stringify(report, null, 2));
    } catch (error) {
        report.result = 'failed'; report.error = error.stack; report.errors = errors;
        report.state = await state().catch(() => null);
        throw error;
    } finally {
        fs.writeFileSync(path.join(output, `retro-${count}p-report.json`), JSON.stringify(report, null, 2) + '\n');
        await Promise.all(browsers.map(browser => browser.close()));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
