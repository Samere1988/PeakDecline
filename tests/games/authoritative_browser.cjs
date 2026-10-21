/* Run retro_test.py --serve --authoritative. Uses a test simulation, not MK64. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const installTestAdapter = () => {
                let timer;
                PeakNet.adapters.set('mk64', {
                    present() {}, hostChanged() {}, stop() { cancelAnimationFrame(timer); },
                    async launch({session}) {
                        cancelAnimationFrame(timer);
                        let local = {x: 0}; window.fpsRenders = 0; window.fpsCorrections = 0; window.fpsEvents = [];
                        // Drop one application snapshot after a valid connection.
                        // This exercises checkpoint recovery, not simulated TCP loss.
                        if (session.slot === 1 && session.epoch === 1) {
                            const receive = session.receiveSnapshot.bind(session);
                            session.receiveSnapshot = event => {
                                if (event.tick === 60 && !window.droppedSnapshot) {
                                    window.droppedSnapshot = true; return;
                                }
                                receive(event);
                            };
                        }
                        if (session.isAuthority) {
                            const receive = session.receiveCommand.bind(session);
                            session.receiveCommand = event => setTimeout(() => receive(event), 45);
                        }
                        session.bind({
                            onGameplayEvent(event) { window.fpsEvents.push(event.id); },
                            sampleInput: () => ({buttons: 0, moveX: 60, moveY: 0, lookX: 0, lookY: 0}),
                            captureLocal: () => local, restoreLocal: value => { local = value; },
                            simulateLocal(input, dt) { local.x += input.moveX * dt; },
                            selectLocalState: (state, slot) => state.players[slot],
                            onReconcile(before, after) { if (before.x !== after.x) window.fpsCorrections++; },
                            interpolateState: (a, b, alpha) => ({players: a.players.map((p, i) => ({x: p.x + (b.players[i].x - p.x) * alpha}))}),
                            renderState(state) { window.fpsRenders++; window.fpsRendered = state; },
                            createAuthority() {
                                const state = {players: Array.from({length: session.players}, () => ({x: 0}))};
                                return {step(commands, dt, context) {
                                    if (context.tick % 60 === 0) context.emitEvent('explosion', {x: 1});
                                    commands.forEach((input, slot) => {
                                    state.players[slot].x = Math.min(20, state.players[slot].x + input.moveX * dt);
                                }); }, captureState: () => state};
                            }
                        });
                        function pump() {
                            if (session.failed) return;
                            for (let i = 0; i < 5 && (!session.authority || session.authority.tick < 360); i++)
                                if (!session.advance()) break;
                            session.render(); timer = requestAnimationFrame(pump);
                        }
                        pump();
                    }
                });
};
(async () => {
    const browser = await chromium.launch({headless: true,
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
    const pages = [], errors = [];
    try {
        for (let index = 0; index < 4; index++) {
            const context = await browser.newContext(), page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            await page.goto('http://127.0.0.1:8066/test-login/fps-' + index);
            await page.waitForFunction(() => PeakNet.adapters.has('mk64'));
            await page.evaluate(installTestAdapter);
        }
        const host = pages[0];
        const roomName = 'FPS framework test ' + Date.now();
        await host.locator('#retro-open-create').click();
        await host.locator('#retro-game-select').selectOption('mk64');
        await host.locator('#retro-room-name').fill(roomName);
        await host.locator('#retro-room-create').click();
        for (const page of pages.slice(1,3)) await page.locator('article').filter({hasText:roomName}).getByRole('button', {name: 'Join room', exact: true}).click();
        await pages[1].locator('#retro-choose-player').click();
        for (const page of pages.slice(0, 2)) await page.locator('#retro-ready').click();
        await host.locator('#retro-start-race').click();
        for (let epoch = 0; epoch < 2; epoch++) {
            if (epoch) await host.evaluate(() => retroNetplay.socket.emit('restart_game'));
            await Promise.all(pages.slice(0,epoch ? 4 : 3).map(page => page.waitForFunction(epoch => window.retroNetplay?.failed ||
                (window.retroNetplay?.epoch === epoch && retroNetplay.lastSnapshot === 360), epoch, {timeout: 60000})));
            for (const page of pages.slice(0,epoch ? 4 : 3)) {
                assert.equal(await page.evaluate(() => retroNetplay.failed), false, await page.locator('#retro-runtime-status').textContent());
                assert.deepEqual(await page.evaluate(() => retroNetplay.history.rows.at(-1).state), {players: [{x: 20}, {x: 20}]});
                assert.ok(await page.evaluate(() => fpsRenders > 0));
                assert.deepEqual(await page.evaluate(() => fpsEvents), [1, 2, 3, 4, 5, 6]);
                assert.ok(await page.evaluate(() => retroNetplay.diagnostics().receivedBytes > 0));
            }
            assert.ok(await pages[1].evaluate(() => fpsCorrections > 0));
            assert.equal(await pages[2].evaluate(() => !!retroNetplay.client), false);
            if(epoch) {
                assert.equal(await pages[1].evaluate(()=>droppedSnapshot),true);
                assert.ok(await pages[1].evaluate(()=>retroNetplay.metrics.recoveries)>0);
                console.log('A dropped snapshot and its explosion effect recovered through the real relay.');
            }
            console.log(`FPS real relay: 360 ticks, two predicted players, spectator and corrections passed; epoch ${epoch}.`);
            if(!epoch){
                const late=pages[3];
                await late.locator('article').filter({hasText:roomName}).getByRole('button',{name:'Spectate',exact:true}).click();
                await late.waitForFunction(()=>window.retroNetplay?.failed||window.retroNetplay?.lastSnapshot===360,null,{timeout:60000});
                assert.equal(await late.evaluate(()=>retroNetplay.failed),false);
                assert.deepEqual(await late.evaluate(()=>fpsEvents),[],'Late join must not replay six historical explosions');
                assert.deepEqual(await late.evaluate(()=>retroNetplay.history.rows.at(-1).state),{players:[{x:20},{x:20}]});
                assert.equal(await late.evaluate(()=>!!retroNetplay.client),false);
                assert.equal(await host.evaluate(()=>retroNetplay.epoch),0,'Late join must not restart the host');
                console.log('Late spectator joined tick 360 without restarting players or replaying old effects.');
                for(const page of [pages[1],host]){
                    await page.evaluate(()=>{window.keptSession=retroNetplay;retroNetplay.socket.disconnect();});
                    await page.waitForFunction(()=>retroNetplay.transportSuspended);
                    await page.evaluate(()=>retroNetplay.socket.connect());
                    await page.waitForFunction(()=>retroNetplay.failed||(!retroNetplay.transportSuspended&&retroNetplay.socket.connected),null,{timeout:15000});
                    assert.equal(await page.evaluate(()=>retroNetplay.failed),false);
                    assert.equal(await page.evaluate(()=>retroNetplay===keptSession),true,'Reconnect must preserve the running simulation');
                }
                console.log('Guest and authority transport reconnects preserved their sessions and seats.');
                const guest=pages[1];
                await guest.route('**/mk64_adapter.js*',async route=>{
                    const response=await route.fetch();
                    await route.fulfill({response,body:(await response.text())+'\n('+installTestAdapter.toString()+')();'});
                });
                await guest.reload();
                await guest.waitForFunction(()=>window.retroNetplay?.failed || window.retroNetplay?.lastSnapshot===360,null,{timeout:15000});
                assert.equal(await guest.evaluate(()=>retroNetplay.failed),false);
                assert.equal(await guest.evaluate(()=>retroNetplay.slot),1);
                assert.equal(await guest.evaluate(()=>retroNetplay.spectator),false);
                assert.equal(await guest.evaluate(()=>retroNetplay.resuming),false);
                assert.deepEqual(await guest.evaluate(()=>fpsEvents),[]);
                assert.equal(await host.evaluate(()=>retroNetplay.epoch),0);
                console.log('Guest page reload restored the assigned player seat without restarting the host.');

            }
        }
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
