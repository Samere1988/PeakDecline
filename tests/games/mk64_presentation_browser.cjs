// Run against ports/mk64/dev_server.py serving a freshly built candidate.
// The linker map must belong to the same build as the served WASM.
// MK64_PRESENTATION_ENDURANCE=1 adds a complete race with deterministic CPU
// steering and item-button pulses. This is a runtime test, not a relay test.
const {chromium} = require(process.env.MK64_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const harness = process.env.MK64_HARNESS_URL || 'http://127.0.0.1:8064/';
const output = path.resolve(process.env.MK64_TEST_OUTPUT || path.join(root, '.tmp/mk64'));
const endurance = process.env.MK64_PRESENTATION_ENDURANCE === '1';
const map = fs.readFileSync(process.env.MK64_LINK_MAP || path.join(root, '.tmp/mk64/build/link.map'), 'utf8');
const address = name => {
    const match = map.match(new RegExp(`^([0-9a-f]+)\\s+[^\\n]+\\s${name}$`, 'm'));
    assert(match, `Linker map must contain ${name}`);
    return parseInt(match[1], 16);
};
const symbols = Object.fromEntries(['gCourseTimer', 'gGlobalTimer', 'gPlayerOne'].map(name => [name, address(name)]));

(async () => {
    fs.mkdirSync(output, {recursive: true});
    const browser = await chromium.launch({headless: true,
        ...(process.env.MK64_BROWSER ? {executablePath: process.env.MK64_BROWSER} : {}),
        args: [...(process.env.MK64_TEST_GPU === 'hardware' ? ['--enable-gpu', '--disable-gpu-sandbox', '--use-angle=gl'] : ['--enable-unsafe-swiftshader']), '--autoplay-policy=no-user-gesture-required']});
    const errors = [], result = {endurance, timing: []};
    try {
        const pages = [];
        for (const fps of [30, 60]) {
            const page = await browser.newPage();
            page.on('pageerror', error => errors.push({fps, message: error.message}));
            pages.push(page);
            await page.route(harness, async route => {
                const response = await route.fetch(), html = await response.text();
                const marker = 'module.mk64Input = input;';
                assert(html.includes(marker), 'Use the MK64 development harness');
                await route.fulfill({response, body: html.replace(marker, `${marker}\n` +
                    `module.mk64RenderFps = ${fps};\n` +
                    'if (!module._web_is_stopped()) throw new Error("Module active before main");')});
            });
            await page.addInitScript(({symbols, endurance}) => {
                for (const name of ['instantiate', 'instantiateStreaming']) {
                    const original = WebAssembly[name];
                    WebAssembly[name] = async function (...args) {
                        const result = await original.apply(this, args);
                        window.testMemory = (result.instance || result).exports.memory;
                        return result;
                    };
                }
                window.testReplayStats = {takeoverFrame: null, lastFrame: -1,
                    itemFrames: 0, inventoryClears: 0, zPresses: 0, previousItem: 0};
                window.mk64InputAtFrame = frame => {
                    const stats = window.testReplayStats;
                    if (endurance && frame >= 1040 && stats.lastFrame !== frame) {
                        const view = new DataView(testMemory.buffer);
                        const player = view.getUint32(symbols.gPlayerOne, true);
                        if (stats.takeoverFrame === null) {
                            // Existing asset-tour strategy: CPU steering with the
                            // human flag retained for camera and race completion.
                            view.setUint16(player, view.getUint16(player, true) | 0x1000, true);
                            stats.takeoverFrame = frame;
                        }
                        const item = view.getInt16(player + 0x10, true);
                        if (item > 0) stats.itemFrames++;
                        if (stats.previousItem > 0 && item === 0) stats.inventoryClears++;
                        if (frame % 90 === 0) stats.zPresses++;
                        stats.previousItem = item;
                        stats.lastFrame = frame;
                    }
                    if (frame >= 300 && frame < 305) return {buttons: 0x1000, x: 0, y: 0};
                    for (let step = 1; step <= 8; step++)
                        if (frame >= 300 + step * 60 && frame < 305 + step * 60)
                            return {buttons: 0x8000, x: 0, y: 0};
                    if (endurance && frame >= 1040)
                        return {buttons: 0x8000 | (frame % 90 === 0 ? 0x2000 : 0), x: 0, y: 0};
                    if (frame >= 1040 && frame < 1300)
                        return {buttons: 0x8000, x: frame >= 1240 ? 55 : 0, y: 0};
                    return {buttons: 0, x: 0, y: 0};
                };
            }, {symbols, endurance});
        }
        await Promise.all(pages.map(page => page.goto(harness)));
        await Promise.all(pages.map(page => page.waitForFunction(() => window.mk64?._web_frame() >= 1050,
            null, {timeout: 100000})));
        const sample = page => page.evaluate(symbols => {
            const view = new DataView(testMemory.buffer);
            return {frame: mk64._web_frame(), memoryFrame: view.getInt32(symbols.gGlobalTimer, true),
                render: mk64._web_render_frames(), interpolations: mk64._web_interpolated_matrices(),
                race: mk64._web_race_state(), time: view.getFloat32(symbols.gCourseTimer, true),
                lap: view.getInt16(view.getUint32(symbols.gPlayerOne, true) + 8, true), now: performance.now()};
        }, symbols);
        const before = await Promise.all(pages.map(sample));
        assert(before.every(row => row.frame === row.memoryFrame), 'Linker map must match the served WASM');
        await pages[0].waitForTimeout(6000);
        const after = await Promise.all(pages.map(sample));
        result.timing = after.map((row, index) => {
            const elapsed = (row.now - before[index].now) / 1000;
            return {target: [30, 60][index], simulationFps: (row.frame - before[index].frame) / elapsed,
                presentationFps: (row.render - before[index].render) / elapsed,
                gameSecondsPerSecond: (row.time - before[index].time) / elapsed,
                newInterpolations: row.interpolations - before[index].interpolations, race: row.race};
        });
        await Promise.all(pages.map(page => page.waitForFunction(() => mk64._web_frame() >= 1300,
            null, {timeout: 30000})));
        async function compare(frame, length) {
            const hashes = await Promise.all(pages.map(page => page.evaluate(({frame, length}) =>
                Array.from({length}, (_, index) => mk64._web_hash_for_frame(frame + index) >>> 0), {frame, length})));
            assert(hashes.every(row => row.every(Boolean)), 'Every compared frame must be retained');
            assert.deepEqual(hashes[0], hashes[1], '30 and 60 FPS presentation must simulate identical state');
            result.matchingFrames = (result.matchingFrames || 0) + length;
        }
        await compare(150, 1150);
        for (let index = 0; index < pages.length; index++) {
            await pages[index].screenshot({path: path.join(output, `presentation-${[30, 60][index]}fps.png`)});
            const row = result.timing[index];
            assert(row.simulationFps > 27 && row.simulationFps < 33, JSON.stringify(row));
            assert(row.gameSecondsPerSecond > 0.9 && row.gameSecondsPerSecond < 1.1, JSON.stringify(row));
        }
        assert(result.timing[1].presentationFps > 55 && result.timing[1].presentationFps < 65);
        assert(result.timing[1].newInterpolations > 100, 'Intermediate frames must contain changed transforms');
        if (endurance) {
            let states;
            const deadline = Date.now() + Number(process.env.MK64_ENDURANCE_TIMEOUT_MS || 300000);
            do {
                await pages[0].waitForTimeout(15000);
                states = await Promise.all(pages.map(sample));
                const through = Math.min(...states.map(row => row.frame)) - 2;
                await compare(through - 449, 450);
                console.log('Endurance', states.map(({frame, race, lap, time}) => ({frame, race, lap, time})));
            } while (!states.every(row => row.lap >= 3) && Date.now() < deadline);
            assert(states.every(row => row.lap >= 3), 'Both presentation modes must finish all three laps');
            result.enduranceStates = states;
            result.items = await Promise.all(pages.map(page => page.evaluate(() => testReplayStats)));
            assert(result.items.every(row => row.takeoverFrame === 1040 && row.zPresses > 10));
            assert(result.items.every(row => row.itemFrames > 0 && row.inventoryClears > 0),
                'The full-race test must acquire and clear item inventory, not only pulse Z');
        }
        async function assertStopped(page, requestStop) {
            const beforeStop = await page.evaluate(requestStop);
            await page.waitForFunction(() => mk64._web_is_stopped(), null, {timeout: 2000});
            const stopped = await page.evaluate(() => mk64._web_frame());
            await page.waitForTimeout(1000);
            assert.equal(await page.evaluate(() => mk64._web_frame()), stopped, 'Native loop must remain stopped');
            assert(stopped - beforeStop <= 1, 'Stop must complete at the next suspended frame boundary');
            return {beforeStop, stopped};
        }
        result.stop = await assertStopped(pages[1], () => {mk64._web_stop(); return mk64._web_frame();});
        const failedPage = await browser.newPage();
        failedPage.on('pageerror', error => errors.push({mode: 'failed-network', message: error.message}));
        await failedPage.addInitScript(() => {
            window.mk64Multiplayer = true; window.mk64NativeMenus = true;
            window.mk64InputsAtFrame = () => [{buttons: 0, x: 0, y: 0}, {buttons: 0, x: 0, y: 0}];
        });
        await failedPage.goto(harness);
        await failedPage.waitForFunction(() => window.mk64?._web_frame() >= 40);
        result.networkFailure = await assertStopped(failedPage, () => {
            mk64.mk64Network = {frameReady: () => -1}; return mk64._web_frame();
        });
        await failedPage.reload();
        await failedPage.waitForFunction(() => window.mk64?._web_frame() >= 40);
        await failedPage.evaluate(() => {mk64.mk64Network = {frameReady: () => 0};});
        await failedPage.waitForTimeout(100);
        result.blockedInputStop = await assertStopped(failedPage, () => {mk64._web_stop(); return mk64._web_frame();});
        assert.deepEqual(errors, []);
        result.errors = errors;
        console.log(JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(output, `presentation-regression${endurance ? '-endurance' : ''}.json`), JSON.stringify(result, null, 2));
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
