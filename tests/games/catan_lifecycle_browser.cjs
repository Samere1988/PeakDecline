const assert = require('node:assert/strict'), path = require('node:path'), os = require('node:os');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(__dirname, '../..');
(async () => {
    const server = spawn(path.join(root, '.venv/bin/python'), [path.join(__dirname, 'catan_online_fixture.py')], {cwd: root});
    let browser, diagnostics = '';
    server.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-3000); });
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error(diagnostics || 'Fixture did not start')), 15000);
            server.stdout.on('data', data => { const found = String(data).match(/CATAN_TEST_PORT=(\d+)/); if (found) { clearTimeout(timer); resolve(found[1]); } });
            server.on('exit', code => { clearTimeout(timer); reject(Error('Fixture exited: ' + code)); });
        });
        const origin = 'http://127.0.0.1:' + port;
        browser = await chromium.launch({headless: true, executablePath: process.env.BROWSER_PATH || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
        const pages = [], errors = [];
        for (let i = 0; i < 4; i++) {
            const context = await browser.newContext({viewport: {width: i === 0 ? 390 : 1280, height: 900}});
            await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({body: ''}));
            const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
            await page.goto(origin + '/test-login/' + i);
            try { await page.locator('#online-notice').filter({hasText: 'Connected'}).waitFor(); }
            catch (error) { console.error({errors, diagnostics, body: (await page.locator('body').innerText()).slice(0, 1500)}); throw error; }
            pages.push(page);
        }
        const [host, second, third, watcher] = pages;
        async function rejoinSpectator(page) {
            const id = await page.evaluate(() => CatanClient.room.id);
            for (let round = 0; round < 2; round++) {
                await page.locator('#room-management').evaluate(element => { element.open = true; });
                page.once('dialog', dialog => dialog.accept());
                await page.locator('#leave-room').click();
                await page.waitForFunction(() => !CatanClient.room);
                await page.locator(`[data-room-card="${id}"]`).getByRole('button', {name:'Spectate', exact:true}).click();
                await page.waitForFunction(id => CatanClient.room?.id === id && CatanClient.room.status === 'playing' && CatanClient.room.seat === null, id);
                assert.equal(await page.evaluate(() => CatanClient.room.gameRevision), await host.evaluate(() => CatanClient.room.gameRevision));
                assert.ok(await page.locator('#board svg').count() || await page.locator('svg#board').count(), 'The rejoined spectator sees the board');
            }
        }
        console.log('Catan browser accounts connected.');
        await host.locator('#open-create-room').click();
        await host.locator('#room-name').fill('Keep the table');
        await host.locator('#create-room').click();
        await host.waitForFunction(() => CatanClient.room?.status === 'lobby');
        await host.locator('#toggle-sidebar').click();
        try { await host.locator('#online-room').waitFor(); }
        catch (error) { console.error({errors, diagnostics, body: (await host.locator('body').innerText()).slice(0, 2500)}); throw error; }
        console.log('Catan host lobby visible.');
        for (const page of [second, third]) await page.getByRole('button', {name: 'Join to play', exact: true}).click();
        for (const page of [host, second, third]) await page.locator('#ready-room').click();
        await host.locator('#start-room').click();
        await host.waitForFunction(() => CatanClient.room.status === 'playing');
        console.log('Catan first round started.');
        await watcher.getByRole('button', {name: 'Spectate', exact: true}).click();
        await watcher.waitForFunction(() => CatanClient.room?.status === 'playing' && CatanClient.room.seat === null);
        await rejoinSpectator(watcher);
        await host.locator('#room-management summary').click();
        await host.locator('#return-room-lobby').click();
        for (const page of pages) await page.waitForFunction(() => CatanClient.room.status === 'lobby');
        console.log('Catan room returned to lobby.');
        assert.equal(await watcher.evaluate(() => CatanClient.room.seat), null);
        assert.equal(await host.evaluate(() => CatanClient.room.seat), 0);
        await second.locator('[data-seat="spectator"]').click();
        await watcher.locator('[data-seat="1"]').click();
        await host.locator('#catan-next-mode').selectOption('cities-knights');
        await host.locator('#catan-change-game button').click();
        await watcher.waitForFunction(() => CatanClient.room.mode === 'cities-knights');
        for (const page of [host, third, watcher]) await page.locator('#ready-room').click();
        await host.locator('#start-room').click();
        for (const page of pages) await page.waitForFunction(() => CatanClient.room.status === 'playing');
        assert.equal(await watcher.evaluate(() => CatanClient.room.seat), 1);
        assert.equal(await second.evaluate(() => CatanClient.room.seat), null);
        await rejoinSpectator(second);
        await host.locator('#room-management summary').click();
        await host.locator('#return-room-lobby').click();
        await host.waitForFunction(() => CatanClient.room.status === 'lobby');
        await host.screenshot({path: '.tmp/catan-returned-mobile.png', fullPage: true});
        assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        console.log('Catan live listing, late join, host return, role changes and next mode passed.');
    } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
