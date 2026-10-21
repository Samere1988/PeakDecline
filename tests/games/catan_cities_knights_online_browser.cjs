const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../..');

(async () => {
    const server = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(__dirname, 'catan_online_fixture.py')], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let serverErrors = '', browser;
    server.stderr.on('data', data => { serverErrors = (serverErrors + data.toString()).slice(-4000); });
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Fixture did not start: ' + serverErrors)), 15000);
            server.stdout.on('data', data => { const match = data.toString().match(/CATAN_TEST_PORT=(\d+)/); if (match) {clearTimeout(timer); resolve(Number(match[1]));} });
            server.on('exit', code => {clearTimeout(timer); reject(new Error('Fixture exited ' + code + ': ' + serverErrors));});
        });
        const origin = `http://127.0.0.1:${port}`;
        browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
        const pages = [], errors = [];
        for (let i = 0; i < 3; i++) {
            const context = await browser.newContext({viewport: {width: 1366, height: 1000}});
            await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({body: ''}));
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); pages.push(page);
            await page.goto(`${origin}/test-login/${i}`);
            await page.locator('#online-notice').filter({hasText:'Connected'}).waitFor();
        }
        await pages[0].locator('#open-create-room').click();
        await pages[0].locator('input[name="game-mode"][value="cities-knights"]').check();
        await pages[0].locator('#room-name').fill('Knights room');
        await pages[0].locator('#create-room').click();
        await pages[0].locator('#online-room').waitFor();
        assert.equal(await pages[0].locator('#room-mode-label').innerText(), 'Cities & Knights');
        for (const page of pages.slice(1)) {
            await page.locator('[data-room-card]').filter({hasText: 'Knights room'}).locator('[data-role="play"]').click();
            await page.locator('#online-room').waitFor();
        }
        for (const page of pages) {
            await page.waitForFunction(() => CatanClient.room?.members.filter(m => m.seat !== null).length === 3);
            await page.locator('#ready-room').click();
            await page.waitForFunction(() => CatanClient.room.members.find(m => m.id === CatanClient.room.me).ready);
        }
        await pages[0].locator('#start-room').click();
        for (const page of pages) await page.waitForFunction(() => CatanClient.room?.game?.mode === 'cities-knights');
        for (const owner of [0,1,2,2,1,0]) {
            const page = pages[owner];
            await page.waitForFunction(seat => CatanClient.room?.game?.current === seat && ['setup-settlement','setup-city'].includes(CatanClient.room.game.phase), owner);
            const phase = await page.evaluate(() => CatanClient.room.game.phase);
            if ([2,2,1,0].includes(owner) && phase === 'setup-city') assert.ok(await page.locator('.placement-target:not(.road-target)').count() > 0);
            await page.locator('.placement-target:not(.road-target)').first().click();
            await page.locator('.road-target').first().click();
        }
        await pages[0].waitForFunction(() => CatanClient.room.game.phase === 'roll');
        assert.equal(await pages[0].locator('.board-piece').count(), 6);
        assert.equal(await pages[0].locator('#bank-resources .ck-bank-progress img').count(), 3);
        const hidden = await pages[1].evaluate(async () => (await fetch('/api/catan/rooms/' + CatanClient.room.id).then(r => r.json())).game.players.map(p => [p.resources, p.commodities, p.progress]));
        assert.ok(hidden[1][0] && hidden[1][1] && hidden[1][2]);
        assert.equal(hidden[0][0], null); assert.equal(hidden[0][1], null); assert.equal(hidden[0][2], null);
        await pages[0].reload();
        await pages[0].waitForFunction(() => CatanClient.room?.game?.phase === 'roll');
        assert.equal(await pages[0].locator('.board-piece').count(), 6);
        await pages[0].locator('#roll-dice').click();
        await pages[0].waitForFunction(() => !!CatanClient.room.game.eventDie);
        assert.equal(await pages[0].locator('#dice-display img').count(), 3);
        assert.deepEqual(await pages[0].locator('#dice-display img').evaluateAll(images => images.map(image => Math.round(image.getBoundingClientRect().width))), [30,30,30]);
        const roomId = await pages[0].evaluate(() => CatanClient.room.id);
        await pages[0].request.post(`${origin}/test-seed-ck/${roomId}`);
        await pages[0].waitForFunction(() => CatanClient.room.game.phase === 'build' && CatanClient.room.game.players[0].commodities.paper === 3);
        assert.equal(await pages[0].locator('#game-message').innerText(), '');
        assert.equal(await pages[0].locator('#bank-resources .ck-bank-card').count(), 11);
        assert.equal(await pages[0].locator('#ck-barbarian-track .ck-track-step').count(), 8);
        assert.equal(await pages[0].locator('#players .ck-seat').count(), 3);
        await pages[0].setViewportSize({width:390,height:844});
        assert.deepEqual(await pages[0].locator('#dice-display img').evaluateAll(images => images.map(image => Math.round(image.getBoundingClientRect().width))), [22,22,22]);
        await pages[0].setViewportSize({width:1366,height:1000});
        await pages[0].locator('#ck-progress-dock button').first().click();
        assert.equal(await pages[0].locator('#ck-hand .ck-progress-card').first().getAttribute('open'), '');
        await pages[0].locator('#ck-hand form[data-ck-action="play-progress"] select[name="discipline"]').selectOption('science');
        await pages[0].locator('#ck-hand form[data-ck-action="play-progress"] button[type="submit"]').click();
        await pages[0].waitForFunction(() => CatanClient.room.game.players[0].improvements.science === 1);
        await pages[0].locator('#open-trade').click();
        assert.equal(await pages[0].locator('#trade-hub [data-pick="give"]').count(), 8, 'Cities & Knights uses the shared trade menu with eight card types');
        await pages[0].locator('#trade-hub [data-mode="bank"]').click();
        await pages[0].locator('#trade-hub [data-pick="give"][data-resource="wood"]').click();
        await pages[0].locator('#trade-hub [data-pick="want"][data-resource="wheat"]').click();
        await pages[0].locator('#submit-negotiated-trade').click();
        await pages[0].waitForFunction(() => CatanClient.room.game.players[0].resources.wheat === 1);
        await pages[0].locator('#trade-hub [data-mode="players"]').click();
        await pages[0].locator('#trade-hub [data-pick="give"][data-resource="paper"]').click();
        await pages[0].locator('#trade-hub [data-pick="want"][data-resource="cloth"]').click();
        await pages[0].locator('#submit-negotiated-trade').click();
        await pages[1].waitForFunction(() => CatanClient.room.game.offers?.length === 1);
        await pages[2].waitForFunction(() => CatanClient.room.game.offers?.length === 1);
        await pages[2].evaluate(() => document.querySelector('.catan-app').classList.remove('trading'));
        await pages[1].locator('#open-trade').click();
        await pages[1].locator('#trade-hub [data-respond="accept-trade"]').click();
        await pages[0].waitForFunction(() => CatanClient.room.game.offers?.[0]?.responses?.['1'] === 'accepted');
        await pages[2].waitForFunction(() => CatanClient.room.game.offers?.[0]?.responses?.['1'] === 'accepted');
        assert.equal(await pages[2].locator('.catan-app').evaluate(el => el.classList.contains('trading')), false, 'A trade response does not reopen the panel for others');
        await pages[0].locator('#trade-hub [data-confirm][data-target="1"]').click();
        await pages[0].waitForFunction(() => !CatanClient.room.game.offers.length && CatanClient.room.game.players[0].commodities.cloth === 1);
        await pages[0].locator('.card-receipt.visible img[src*="card_cloth"]').waitFor();
        await pages[0].request.post(`${origin}/test-finish/${roomId}`);
        await pages[0].waitForFunction(() => CatanClient.room.status === 'finished');
        await pages[0].locator('#game-summary-overlay:visible').waitFor();
        assert.match(await pages[0].locator('#game-summary-title').innerText(), /wins/);
        await pages[0].locator('#close-game-summary').click();
        await pages[0].locator('#rematch-room').click();
        await pages[0].waitForFunction(() => CatanClient.room.status === 'lobby');
        assert.equal(await pages[0].evaluate(() => CatanClient.room.mode), 'cities-knights');
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('Cities & Knights online browser checks passed: 3 players, setup, privacy, reconnect, dice, progress, trades, summary and rematch.');
    } finally {
        await browser?.close();
        server.kill();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
