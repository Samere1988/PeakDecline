const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../..');

(async () => {
    const fixture = spawn(path.join(root, '.venv/Scripts/python.exe'), [path.join(__dirname, 'catan_online_fixture.py')], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let errors = '';
    fixture.stderr.on('data', data => { errors += data.toString(); });
    let browser;
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Fixture did not start: ' + errors)), 15000);
            fixture.stdout.on('data', data => { const match = data.toString().match(/CATAN_TEST_PORT=(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
            fixture.on('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited ' + code + ': ' + errors)); });
        });
        const script = `import json,random\nfrom app import catan_cities_knights as CK\ng=CK.create(['Red','Blue','Orange','Green'],random.Random(8))\ng['phase']='build'\ng['turn']=2\ng['players'][0]['resources'].update({'wood':4,'brick':2,'sheep':1,'ore':1,'wheat':1})\ng['players'][0]['commodities']['paper']=4\ng['players'][0]['progress']=['science_crane','trade_resource_monopoly']\ng['players'][0]['improvements']={'science':2,'trade':1,'politics':3}\ng['buildings']={'0':{'owner':0,'kind':'city','wall':True}}\ng['knightPieces']={'3':{'owner':0,'level':1,'active':True,'placedTurn':0}}\nCK.awards(g)\nprint(json.dumps(CK.view(g,0)))`;
        const state = JSON.parse(execFileSync(path.join(root, '.venv/Scripts/python.exe'), ['-c', script], {cwd: root}).toString());
        browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/static/js/catan-online.js') return route.fulfill({contentType: 'application/javascript', body: `window.__actions=[];window.__subscriptions=[];window.CatanClient={subscribe(fn){window.__subscriptions.push(fn)},action(value){window.__actions.push(value);return Promise.resolve(true)},get room(){return window.__room}};window.__sendRoom=value=>{window.__room=value;window.__subscriptions.forEach(fn=>fn(value))};`});
            if (url.hostname === 'cdn.socket.io') return route.fulfill({body: ''});
            return route.continue();
        });
        await page.goto(`http://127.0.0.1:${port}/test-login/0`);
        await page.evaluate(game => {document.querySelector('#online-panel').hidden = true; document.querySelector('.catan-layout').hidden = false; window.__sendRoom({id:'ck-ui', name:'CK UI test', mode:'cities-knights', seat:0, me:'tester', members:[], status:'playing', version:1, gameRevision:1, tradeVersion:2, game, chat:[]});}, state);
        const checkNumberTiles = async label => {
            const tiles = await page.locator('.hex .number').evaluateAll(elements => elements.map(element => {
                const hex = element.closest('.hex').getBoundingClientRect();
                const tile = element.getBoundingClientRect();
                return {ratio:tile.width / hex.width, fontRatio:parseFloat(getComputedStyle(element).fontSize) / hex.width,
                    verticalOffset:(tile.top + tile.height / 2 - hex.top - hex.height / 2) / hex.width,
                    fits:element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1,
                    radius:getComputedStyle(element).borderRadius};
            }));
            assert.equal(tiles.length, 18, `${label}: one number tile per producing hex`);
            assert.ok(tiles.every(tile => Math.abs(tile.ratio - .36) < .01 && Math.abs(tile.fontRatio - .233) < .01 &&
                tile.verticalOffset > .13 && tile.verticalOffset < .17 && tile.fits && tile.radius !== '50%'),
                `${label}: square and numerals must scale with the hex without clipping`);
        };
        await checkNumberTiles('Cities & Knights desktop');
        await page.evaluate(() => { const next = structuredClone(window.__room); next.game.dice = [3,4]; next.game.eventDie = 'barbarian'; window.__sendRoom(next); });
        if (process.env.CK_VISUAL_PATH) {
            await page.setViewportSize({width:Number(process.env.CK_VISUAL_WIDTH || 1592),height:Number(process.env.CK_VISUAL_HEIGHT || 910)});
            await page.screenshot({path:process.env.CK_VISUAL_PATH});
            if (process.env.CK_METRICS) console.log('CK_METRICS=' + JSON.stringify(await page.evaluate(() => Object.fromEntries(['.board-panel','.catan-sidebar','.bottom-controls','#resources .resource','.action-tray .action-tile','.ck-seat','.ck-seat-card','.ck-bank-card','.hex','.hex .number','.hex .number-pips'].map(selector => {const element = document.querySelector(selector), rect = element.getBoundingClientRect(); return [selector,{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height),font:getComputedStyle(element).fontSize,container:getComputedStyle(element).containerType}]})))));
        }
        assert.equal(await page.locator('.cities-knights-mode #ck-hand').count(), 1);
        assert.equal(await page.locator('#ck-hand .ck-deck img').count(), 0);
        assert.equal(await page.locator('#bank-resources .ck-bank-stock .ck-bank-card').count(), 8);
        assert.equal(await page.locator('#bank-resources .ck-bank-progress .ck-bank-card').count(), 3);
        assert.equal(await page.locator('#players .ck-seat').count(), 4);
        assert.equal(await page.locator('#players .ck-seat .seat-identity .seat-avatar').count(), 4);
        assert.equal(await page.locator('#players .ck-seat .seat-stats').count(), 4);
        assert.equal(await page.locator('#bank-resources .bank-stock .card-stat').count(), 8);
        assert.equal(await page.locator('#players .ck-seat').first().locator('.ck-improvement-cell.filled').count(), 6);
        assert.equal(await page.locator('#players .ck-seat').first().locator('.ck-seat-card').count(), 2);
        assert.equal(await page.locator('#players .ck-seat').first().locator('.ck-seat-strength > span').count(), 2);
        assert.equal(await page.locator('#ck-barbarian-track .ck-track-step').count(), 8);
        assert.equal(await page.locator('#ck-barbarian-track .ck-track-step.current').count(), 1);
        assert.equal(await page.locator('#ck-barbarian-track img[src*="barbarian_tracker_hex_step.png"]').count(), 7);
        const trackLayout = await page.locator('#ck-barbarian-track .ck-track-step.current').evaluate(step => {
            const hex = step.querySelector('.ck-track-hex').getBoundingClientRect();
            const ship = step.querySelector('.ck-force-ship').getBoundingClientRect();
            const knights = step.querySelector('.ck-force-knights').getBoundingClientRect();
            const track = step.closest('#ck-barbarian-track').getBoundingClientRect();
            return {hex:hex.toJSON(),ship:ship.toJSON(),knights:knights.toJSON(),trackRight:track.right};
        });
        assert.ok(trackLayout.hex.width >= 55 && trackLayout.hex.height >= 63, 'Barbarian hexes match the enlarged Colonist proportions');
        assert.ok(trackLayout.ship.left <= trackLayout.hex.left + 1 && trackLayout.ship.right >= trackLayout.hex.right && trackLayout.knights.left >= trackLayout.ship.right,
            'Ship fills the current hex and swords sit beside it');
        assert.ok(trackLayout.knights.right <= trackLayout.trackRight + 1, 'Barbarian markers stay within the track');
        await page.locator('.ck-force-ship').hover();
        assert.match(await page.locator('.ck-force-ship .ck-force-tooltip').innerText(), /one point for each city/i);
        assert.equal(await page.locator('.ck-force-ship .ck-force-tooltip').isVisible(), true);
        await page.locator('.ck-force-knights').hover();
        assert.match(await page.locator('.ck-force-knights .ck-force-tooltip').innerText(), /total levels of all active knights/i);
        assert.equal(await page.locator('.ck-force-knights .ck-force-tooltip').isVisible(), true);
        assert.equal(await page.locator('#players .ck-seat-card img').count(), 8);
        assert.equal(await page.locator('#players .ck-improvement-grid').first().evaluate(element => getComputedStyle(element).backgroundImage.includes('pageck_city_improvement_tracker.png')), true);
        assert.equal(await page.locator('#ck-hand .ck-progress-card').count(), 2);
        assert.equal(await page.locator('.ck-board-knight').count(), 1);
        assert.equal(await page.locator('.ck-board-wall').count(), 1);
        assert.equal(await page.locator('#ck-wall-action').isVisible(), true);
        assert.equal(await page.locator('#ck-quick-actions .ck-quick-tile').count(), 2);
        assert.equal(await page.locator('.action-tray [data-build="road"] img').getAttribute('src'), '/static/assets/catan/colonist/road-red.svg');
        assert.equal(await page.locator('#turn-label').isVisible(), true);
        assert.match(await page.locator('#turn-label').innerText(), /Build & Trade/);
        assert.equal(await page.locator('#dice-display').evaluate(element => element.parentElement.classList.contains('toolbar-actions')), true);
        assert.equal(await page.locator('#roll-dice').isVisible(), true);
        assert.equal(await page.locator('#ck-phase-banner').count(), 0);
        await page.evaluate(() => {const next = structuredClone(window.__room); next.gameRevision = 2; next.game.phase = 'roll'; next.game.dice = null; window.__sendRoom(next);});
        assert.match(await page.locator('#turn-label').innerText(), /Your turn/);
        await page.locator('#roll-dice').click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'roll'});
        await page.evaluate(() => {const next = structuredClone(window.__room); next.gameRevision = 3; next.game.phase = 'build'; next.game.dice = [3,4]; window.__sendRoom(next);});
        assert.equal(await page.locator('#ck-tool-launcher').count(), 0);
        assert.equal(await page.locator('#ck-workspace').evaluate(element => element.parentElement.classList.contains('board-panel')), true);
        assert.equal(await page.locator('#ck-progress-dock button').count(), 2);
        assert.equal(await page.locator('#ck-workspace').isVisible(), false);
        await page.locator('#ck-knight-actions').click();
        assert.equal(await page.locator('#ck-action-options [data-ck-option]').count(), 4);
        assert.equal(await page.locator('#ck-action-options').isVisible(), true);
        assert.equal(await page.locator('#ck-workspace').isVisible(), false);
        if (process.env.CK_VISUAL_OPTIONS) await page.screenshot({path:process.env.CK_VISUAL_OPTIONS});
        await page.locator('#ck-knight-actions').click();
        assert.equal(await page.locator('#ck-action-options').isVisible(), false);
        assert.equal(await page.locator('#chat-panel .chat-toggle').evaluate(element => element.open), true, 'Chat opens in the game sidebar');
        assert.equal(await page.locator('#chat-message').isVisible(), true);
        await page.locator('#ck-rule-tools [data-ck-settings]').click();
        assert.equal(await page.locator('#ck-settings-menu').isVisible(), true);
        const soundBefore = await page.locator('#sound-toggle').getAttribute('aria-pressed');
        await page.locator('#ck-settings-menu [data-ck-sound]').click();
        assert.notEqual(await page.locator('#sound-toggle').getAttribute('aria-pressed'), soundBefore);
        await page.locator('#ck-settings-menu [data-ck-sound]').click();
        await page.locator('#ck-rule-tools [data-ck-settings]').click();
        assert.equal(await page.locator('#ck-settings-menu').isVisible(), false);
        assert.equal(await page.locator('.action-tray [data-build="road"]').isEnabled(), true);
        await page.locator('.action-tray [data-build="road"]').click();
        await page.locator('.ck-board-knight').waitFor();
        assert.equal(await page.locator('.ck-board-knight').count(), 1, 'Build selection keeps expansion pieces visible');
        await page.locator('.ck-board-knight').click();
        assert.equal(await page.locator('#ck-knight-context').isVisible(), true);
        assert.equal(await page.locator('#ck-knight-context .ck-quick-tile').count(), 4);
        assert.equal(await page.locator('.ck-board-knight').getAttribute('aria-pressed'), 'true');
        await page.locator('#ck-knight-context [data-ck-knight-action="upgrade"]').click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'upgrade-knight', target:3});
        const destination = await page.evaluate(() => {
            const next = structuredClone(window.__room), start = 3;
            const edge = CatanEngine.vertices[start].edges.find(id => CatanEngine.edges[id].ends.some(vertex => vertex !== start && !next.game.buildings[String(vertex)]));
            next.game.roads[edge] = 0;
            window.__sendRoom(next);
            return CatanEngine.edges[edge].ends.find(vertex => vertex !== start);
        });
        await page.locator('#ck-knight-context [data-ck-knight-action="move"]').click();
        assert.equal(await page.locator('#ck-workspace').isVisible(), false, 'Move knight uses board selection');
        assert.equal(await page.locator('.ck-build-target').count(), 1);
        await page.locator(`.ck-build-target[data-ck-build-target="${destination}"]`).click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'move-knight', target:3, destination});
        assert.equal(await page.locator('#ck-build-prompt').isVisible(), false);
        await page.locator('#ck-knight-actions').click();
        await page.locator('#ck-action-options [data-ck-option="move-knight"]').click();
        assert.equal(await page.locator('#ck-workspace').isVisible(), false, 'Knight tray move also uses board selection');
        await page.locator('.ck-build-target[data-ck-build-target="3"]').click();
        await page.locator(`.ck-build-target[data-ck-build-target="${destination}"]`).click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'move-knight', target:3, destination});
        await page.locator('.ck-board-knight').click();
        await page.locator('.ck-board-knight').click();
        assert.equal(await page.locator('#ck-knight-context').isVisible(), false);
        assert.match(await page.locator('#ck-barbarian-track').innerText(), /Barbarians 0\/7/);
        const missingImages = await page.locator('.ck-panel img, .bank-card img, .game-players img, .action-tray img').evaluateAll(async images => (await Promise.all([...new Set(images.map(image => image.src))].map(async source => ({source, ok:(await fetch(source)).ok})))).filter(result => !result.ok).map(result => result.source));
        assert.deepEqual(missingImages, [], 'Expansion artwork loads');
        await page.locator('#ck-rule-tools [data-ck-rules="quick"]').click();
        assert.equal(await page.locator('#ck-rules-dialog').isVisible(), true);
        assert.match(await page.locator('.ck-rules-quick').innerText(), /Barbarian strength/);
        await page.locator('#ck-rules-dialog [data-ck-rules-view="full"]').click();
        assert.equal(await page.locator('#ck-rules-dialog [data-ck-rules-view="full"]').getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('#ck-rules-dialog .ck-rules-full > section').count(), 12);
        assert.equal(await page.locator('#ck-rules-dialog .ck-rules-tabs a').getAttribute('href'), 'https://colonist.io/catan-rules/cities-and-knights');
        assert.equal(await page.locator('#ck-rules-dialog .ck-rules-source a').getAttribute('href'), 'https://colonist.io/catan-rules/cities-and-knights');
        await page.locator('#ck-rules-dialog [data-ck-rules-close]').click();
        await page.setViewportSize({width:2219, height:1174});
        const largeLayout = await page.evaluate(() => {
            const width = selector => document.querySelector(selector).getBoundingClientRect().width;
            return {sidebar:width('.catan-sidebar') / innerWidth, card:width('#resources .resource'), action:width('.action-tray .action-tile'), seatCard:width('.ck-seat-card')};
        });
        assert.ok(Math.abs(largeLayout.sidebar - .21) < .01, 'Status column matches the reference width');
        assert.ok(largeLayout.card >= 55 && largeLayout.action >= 100 && largeLayout.seatCard >= 50, 'Cards and actions match the reference scale');
        const activityHeights = await page.evaluate(() => [document.querySelector('#chat-panel').getBoundingClientRect().height, document.querySelector('.move-summary').getBoundingClientRect().height]);
        assert.ok(Math.abs(activityHeights[0] - activityHeights[1]) < 3, 'Chat and moves share the activity space evenly');
        const palette = async selectors => page.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, getComputedStyle(document.querySelector(selector)).backgroundColor])), selectors);
        const expansionPalette = await palette({board:'.board-panel', moves:'.move-summary', chat:'#chat-panel', chatLog:'#room-chat', chatInput:'#chat-message', chatButton:'#chat-form button', bank:'.bank-card', players:'.game-players', active:'.ck-seat.active', idle:'.ck-seat:not(.active)', dock:'.bottom-controls', hand:'.bottom-hand', phase:'#turn-label'});
        const expansionActionBackground = await page.locator('.action-tray [data-build="road"]').evaluate(element => getComputedStyle(element).backgroundImage);
        assert.equal(await page.locator('#ck-knight-actions').evaluate(element => getComputedStyle(element).backgroundImage), expansionActionBackground, 'Expansion quick actions use the base action artwork');
        assert.equal(await page.locator('#players .ck-seat').last().evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('.catan-sidebar').getBoundingClientRect().bottom + 1), true, 'Four enlarged player seats remain visible');
        for (const width of [390, 1366]) {
            await page.setViewportSize({width, height: 1000});
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Interface fits ${width}px`);
            const topControls = await page.evaluate(() => {
                const rect = selector => document.querySelector(selector).getBoundingClientRect();
                return {board:rect('.board-panel').toJSON(),label:rect('#turn-label').toJSON(),dice:rect('#dice-display').toJSON(),roll:rect('#roll-dice').toJSON(),rules:rect('#ck-rule-tools').toJSON()};
            });
            assert.ok(topControls.label.left >= topControls.rules.right && topControls.label.right <= topControls.dice.left + 1,
                `Turn notice sits beside the dice and clear of rules at ${width}px`);
            assert.ok(topControls.label.top < topControls.board.top + 55 && topControls.dice.top < topControls.board.top + 55 && topControls.roll.top < topControls.board.top + 55,
                `Turn, dice, and roll controls stay at the top right at ${width}px`);
        }
        assert.ok(await page.locator('.board-panel').evaluate(element => element.getBoundingClientRect().width) > 900, 'Bank does not reduce desktop board width');
        assert.equal(await page.locator('.bank-card').evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('.game-players').getBoundingClientRect().top), true, 'Bank stays above player rows');
        for (const height of [650,720,910]) {
            await page.setViewportSize({width:1366,height});
            assert.equal(await page.locator('#ck-quick-actions').evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('.board-panel').getBoundingClientRect().bottom + 1), true, `Board actions fit ${height}px height`);
            assert.equal(await page.locator('#ck-barbarian-track').evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('.bottom-controls').getBoundingClientRect().top + 1), true, `Barbarian track clears the hand at ${height}px height`);
        }
        await page.setViewportSize({width:390, height:844});
        if (process.env.CK_VISUAL_MOBILE) await page.screenshot({path:process.env.CK_VISUAL_MOBILE});
        await page.locator('#ck-rule-tools [data-ck-rules="full"]').click();
        assert.ok(await page.locator('#ck-rules-dialog').evaluate(element => element.getBoundingClientRect().width <= innerWidth));
        await page.locator('#ck-rules-dialog [data-ck-rules-close]').click();
        await page.locator('#ck-open-actions').click();
        assert.equal(await page.locator('#ck-action-options [data-ck-option="improve-city"]').count(), 3, 'Grid reveals three city improvements');
        assert.equal(await page.locator('#ck-workspace').isVisible(), false, 'First click keeps details closed');
        await page.locator('#ck-action-options [data-ck-discipline="science"]').hover();
        assert.equal(await page.locator('.ck-build-cost-tooltip .catan-cost-card.available').count(), 1, 'Science hover shows the paper cost');
        await page.locator('#ck-action-options [data-ck-discipline="science"]').click();
        assert.equal(await page.locator('#ck-workspace').isVisible(), false, 'Science uses board selection instead of a text form');
        assert.equal(await page.locator('.ck-build-target').count(), 1, 'Own city is highlighted for improvement');
        await page.locator('.ck-build-target').click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'improve-city', target:0, discipline:'science'});
        assert.equal(await page.locator('#ck-build-prompt').isVisible(), false);
        assert.equal(await page.locator('#players .ck-seat').count(), 4);
        assert.equal(await page.locator('#ck-wall-action').isDisabled(), true, 'An existing wall cannot be built again');
        await page.evaluate(() => {const next = structuredClone(window.__room); next.game.buildings['0'].wall = false; window.__sendRoom(next);});
        await page.locator('#ck-wall-action').click();
        assert.equal(await page.locator('#ck-workspace').isVisible(), false, 'City wall uses board selection');
        await page.locator('.ck-build-target[data-ck-build-target="0"]').click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'build-wall', target:0});
        await page.locator('#ck-progress-dock button').first().click();
        if (process.env.CK_PROGRESS_VISUAL_PATH) await page.screenshot({path:process.env.CK_PROGRESS_VISUAL_PATH});
        assert.equal(await page.locator('#ck-workspace .ck-tabs').count(), 0, 'Legacy tabs are gone');
        assert.equal(await page.locator('#bank-resources .ck-bank-progress img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
        assert.equal(await page.locator('#ck-hand .ck-progress-card summary img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
        await page.locator('[data-ck-close-tools]').click();
        assert.equal(await page.locator('#ck-workspace').isVisible(), false);
        await page.evaluate(() => {const next = structuredClone(window.__room); next.game.players[0].improvements.trade = 3; next.game.harborTargets = [1]; window.__sendRoom(next);});
        await page.locator('#ck-open-actions').click();
        await page.locator('#ck-action-options [data-ck-option="tradehouse-exchange"]').click();
        assert.equal(await page.locator('#ck-actions form[data-ck-action="tradehouse-exchange"]').isVisible(), true);
        assert.equal(await page.locator('#ck-workspace .ck-tabs').count(), 0);
        await page.locator('#ck-actions form[data-ck-action="tradehouse-exchange"] button[type="submit"]').click();
        assert.equal(await page.evaluate(() => window.__actions.at(-1).type), 'tradehouse-exchange');
        await page.locator('[data-ck-close-tools]').click();
        await page.locator('#ck-open-actions').click();
        await page.locator('#ck-action-options [data-ck-option="harbor-offer"]').click();
        assert.equal(await page.locator('#ck-actions form[data-ck-action="harbor-offer"]').isVisible(), true);
        await page.locator('#ck-actions form[data-ck-action="harbor-offer"] button[type="submit"]').click();
        assert.equal(await page.evaluate(() => window.__actions.at(-1).type), 'harbor-offer');
        await page.locator('[data-ck-close-tools]').click();
        await page.setViewportSize({width:1366, height:1000});
        await page.locator('#ck-open-actions').click();
        await page.locator('#ck-action-options [data-ck-discipline="science"]').click();
        assert.equal(await page.locator('.ck-build-target').count(), 1);
        await page.locator('.ck-build-target').click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'improve-city', discipline:'science', target:0});
        await page.evaluate(() => {
            const next = structuredClone(window.__room);
            const edge = CatanEngine.edges.find(item => item.ends.some(id => !next.game.buildings[id] && !next.game.knightPieces[id]));
            next.game.roads[edge.id] = 0; next.gameRevision += 1; window.__sendRoom(next);
        });
        await page.locator('#ck-knight-actions').hover();
        assert.equal(await page.locator('.ck-build-cost-tooltip .catan-cost-card.available').count(), 2, 'Knight hover shows sheep and ore');
        await page.locator('#ck-knight-actions').click();
        await page.locator('#ck-action-options [data-ck-option="build-knight"]').click();
        assert.ok(await page.locator('.ck-build-target').count() > 0, 'Eligible knight corners appear on the board');
        await page.locator('.ck-build-target').first().click();
        assert.equal(await page.evaluate(() => window.__actions.at(-1).type), 'build-knight');
        await page.evaluate(() => {
            const next = structuredClone(window.__room);
            next.game.players[0].resources.sheep = 0; next.game.players[0].commodities.paper = 0;
            next.gameRevision += 1; window.__sendRoom(next);
        });
        await page.locator('#ck-knight-actions').click();
        const knightOption = page.locator('#ck-action-options [data-ck-option="build-knight"]');
        assert.equal(await knightOption.getAttribute('aria-disabled'), 'true');
        await knightOption.hover();
        assert.equal(await page.locator('.ck-build-cost-tooltip .catan-cost-card.missing').count(), 1, 'Unavailable sheep is greyed out');
        await page.locator('#ck-open-actions').click();
        const scienceOption = page.locator('#ck-action-options [data-ck-discipline="science"]');
        assert.equal(await scienceOption.getAttribute('aria-disabled'), 'true');
        await scienceOption.hover();
        assert.equal(await page.locator('.ck-build-cost-tooltip .catan-cost-card.missing').count(), 1, 'Unavailable paper is greyed out');
        await page.evaluate(() => {
            const next = structuredClone(window.__room);
            next.game.players[0].resources.sheep = 1; next.game.players[0].commodities.paper = 4;
            next.gameRevision += 1; window.__sendRoom(next);
        });
        await page.locator('#open-trade').click();
        assert.equal(await page.locator('#trade-hub [data-pick="give"]').count(), 8);
        if (process.env.CK_TRADE_VISUAL_PATH) await page.screenshot({path:process.env.CK_TRADE_VISUAL_PATH});
        await page.locator('#trade-hub [data-pick="give"][data-resource="paper"]').click();
        await page.locator('#trade-hub [data-pick="want"][data-resource="ore"]').click();
        await page.locator('#submit-negotiated-trade').click();
        const offer = await page.evaluate(() => window.__actions.at(-1));
        assert.equal(offer.give.paper, 1);
        assert.equal(offer.want.ore, 1);
        await page.locator('#close-trade').click();
        await page.locator('#ck-progress-dock button').last().click();
        await page.locator('#ck-hand form[data-ck-action="play-progress"]').last().locator('button[type="submit"]').click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'play-progress', card:'trade_resource_monopoly', resource:'wood'});
        await page.setViewportSize({width:390,height:844});
        await checkNumberTiles('Cities & Knights mobile');
        await page.evaluate(() => {const next = structuredClone(window.__room); next.gameRevision = 2; next.game.phase = 'barbarian-loss'; next.game.barbarianPosition = 4; next.game.barbarianLosses = [0]; next.game.bank.wood = 7; next.game.commodityBank.paper = 6; next.game.progressDeckCounts.science = 11; window.__sendRoom(next);});
        assert.equal(await page.locator('#ck-workspace').isVisible(), false, 'Pillage city uses board selection');
        assert.equal(await page.locator('#ck-build-prompt').isVisible(), true);
        assert.equal(await page.locator('.ck-build-target').count(), 1);
        assert.equal(await page.evaluate(() => document.querySelector('#ck-build-prompt').getBoundingClientRect().bottom <= document.querySelector('#ck-quick-actions').getBoundingClientRect().top), true, 'Pillage prompt clears the action tiles on mobile');
        if (process.env.CK_PILLAGE_VISUAL_PATH) await page.screenshot({path:process.env.CK_PILLAGE_VISUAL_PATH});
        assert.equal(await page.locator('.catan-app').evaluate(element => element.classList.contains('sidebar-open')), false, 'Required choice leaves player sidebar closed');
        assert.equal(await page.locator('#ck-barbarian-track .ck-track-step.current').evaluate(element => [...element.parentElement.children].indexOf(element)), 4);
        assert.equal(await page.locator('#bank-resources .ck-bank-stock .ck-bank-card').first().locator('span').innerText(), '7');
        assert.equal(await page.locator('#bank-resources .ck-bank-stock .ck-bank-card').nth(5).locator('span').innerText(), '6');
        assert.equal(await page.locator('#bank-resources .ck-bank-progress .ck-bank-card').first().locator('span').innerText(), '11');
        await page.locator('.ck-build-target[data-ck-build-target="0"]').click();
        assert.deepEqual(await page.evaluate(() => window.__actions.at(-1)), {type:'barbarian-loss', target:0});
        for (const phase of ['defender-reward','aqueduct','progress-discard','discard','progress-forced-discard','wedding-gift','spy-take','merchant-take','harbor-response']) {
            await page.evaluate(({phase, initial}) => {
                const next = structuredClone(window.__room);
                next.game = structuredClone(initial); next.game.phase = phase; next.gameRevision += 1;
                if (phase === 'defender-reward') next.game.defenderRewards = [0];
                if (phase === 'aqueduct') next.game.aqueductChoices = [0];
                if (phase === 'progress-discard') next.game.progressOverflow = 0;
                if (phase === 'discard') next.game.discard = [{owner:0,left:1}];
                if (phase === 'progress-forced-discard') next.game.progressPending = {discards:[{owner:0,left:1}]};
                if (phase === 'wedding-gift') next.game.progressPending = {gifts:[{owner:0,left:1}]};
                if (phase === 'spy-take') {next.game.progressPending = {owner:0,target:1}; next.game.privatePreview = {progress:['science_crane']};}
                if (phase === 'merchant-take') {next.game.progressPending = {owner:0,target:1}; next.game.privatePreview = {cards:{wood:1}};}
                if (phase === 'harbor-response') next.game.progressPending = {target:0};
                window.__sendRoom(next);
            }, {phase, initial:state});
            assert.equal(await page.locator('#ck-workspace').isVisible(), false, `${phase} keeps the old panel closed`);
            assert.ok(await page.locator('#ck-required-choice .ck-required-cards button').count() > 0, `${phase} has visual card choices`);
            assert.equal(await page.evaluate(() => document.querySelector('#ck-required-choice').getBoundingClientRect().bottom <= document.querySelector('#ck-quick-actions').getBoundingClientRect().top), true, `${phase} choices clear the action tiles on mobile`);
            assert.equal(await page.locator('#ck-required-choice .ck-required-cards img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true, `${phase} card art loads`);
            await page.locator('#ck-required-choice .ck-required-cards button').first().click();
            assert.equal(await page.evaluate(() => window.__actions.at(-1).type), phase === 'progress-discard' ? 'discard-progress' : phase);
        }
        for (const phase of ['deserter-pick','deserter-place','relocate-knight']) {
            await page.evaluate(({phase, initial}) => {
                const next = structuredClone(window.__room);
                next.game = structuredClone(initial); next.game.phase = phase; next.gameRevision += 1;
                const edge = CatanEngine.vertices[3].edges.find(id => CatanEngine.edges[id].ends.some(vertex => vertex !== 3 && !next.game.buildings[String(vertex)]));
                next.game.roads[edge] = 0;
                if (phase === 'deserter-pick') next.game.progressPending = {target:0};
                if (phase === 'deserter-place') next.game.progressPending = {owner:0,piece:{level:1,active:true}};
                if (phase === 'relocate-knight') {delete next.game.knightPieces['3']; next.game.displacedKnight = {owner:0,origin:3,piece:{level:1,active:false}};}
                window.__sendRoom(next);
            }, {phase, initial:state});
            assert.equal(await page.locator('#ck-workspace').isVisible(), false, `${phase} keeps the old panel closed`);
            assert.ok(await page.locator('.ck-build-target').count() > 0, `${phase} highlights board choices`);
            await page.locator('.ck-build-target').first().click();
            assert.equal(await page.evaluate(() => window.__actions.at(-1).type), phase);
        }
        const soundResults = await page.evaluate(initial => {
            const calls = [];
            window.CatanAudio.play = name => calls.push(name);
            const cases = [
                ['sfx_city_destroy', () => {}, game => {game.buildings['0'].kind = 'settlement';}],
                ['sfx_city_wall_place', game => {game.buildings['0'].wall = false;}, game => {game.buildings['0'].wall = true;}],
                ['sfx_city_improvement', () => {}, game => {game.players[0].improvements.science++;}],
                ['sfx_metropolis_place', () => {}, game => {game.players[0].improvements.politics++; game.metropolises.politics = {owner:0,vertex:0}; game.buildings['0'].metropolis = 'politics';}],
                ['sfx_knight_upgrade', () => {}, game => {game.knightPieces['3'].level++;}],
                ['sfx_knight_place', () => {}, game => {game.knightPieces['4'] = {owner:0,level:1,active:false,placedTurn:2};}],
                ['sfx_knight_equip', game => {game.knightPieces['3'].active = false;}, game => {game.knightPieces['3'].active = true;}],
                ['sfx_achievement_ck_progress', () => {}, game => {game.players[0].progressVP.push('science_printer');}],
                ['sfx_ship_move', () => {}, game => {game.barbarianPosition++;}],
                ['sfx_dice_roll_1', () => {}, game => {game.rolls.push({player:0,dice:[2,3],event:'science'});}],
                ['sfx_offer_rejected', () => {}, game => {game.audioEvent = {id:1,cue:'sfx_offer_rejected'};}],
                ['sfx_devcard_used', () => {}, game => {game.audioEvent = {id:2,cue:'sfx_devcard_used'};}]
            ];
            return cases.map(([expected, setup, change], index) => {
                const start = structuredClone(initial);
                setup(start);
                window.__sendRoom({...window.__room, id:`ck-sound-${index}`, mode:'cities-knights', version:1, gameRevision:1, game:start});
                calls.length = 0;
                const after = structuredClone(start);
                change(after);
                window.__sendRoom({...window.__room, version:2, gameRevision:2, game:after});
                return {expected, played:[...calls]};
            });
        }, state);
        for (const result of soundResults) assert.ok(result.played.includes(result.expected), `${result.expected}: ${result.played.join(', ')}`);
        await page.setViewportSize({width:1366,height:1000});
        await page.evaluate(() => {const next = structuredClone(window.__room); next.gameRevision = 3; next.game.mode = 'base'; next.game.phase = 'build'; window.__sendRoom(next);});
        await checkNumberTiles('Base game desktop');
        await page.setViewportSize({width:390,height:844});
        await checkNumberTiles('Base game mobile');
        await page.setViewportSize({width:1366,height:1000});
        assert.equal(await page.locator('#ck-hand').isVisible(), false);
        assert.equal(await page.locator('#ck-rule-tools').isVisible(), false);
        assert.equal(await page.locator('#buy-development').isVisible(), true);
        assert.equal(await page.locator('#dice-display').evaluate(element => element.parentElement.classList.contains('toolbar-actions')), true);
        assert.equal(await page.locator('#ck-wall-action').isVisible(), false);
        assert.equal(await page.locator('#players .player-row .seat-identity .seat-avatar').count(), 4);
        assert.equal(await page.locator('#players .player-row .seat-stats').count(), 4);
        assert.equal(await page.locator('#bank-resources .bank-stock .card-stat').count(), 6);
        assert.equal(await page.locator('#chat-panel .chat-toggle').evaluate(element => element.open), true, 'Base game chat remains visible');
        const basePalette = await palette({board:'.board-panel', moves:'.move-summary', chat:'#chat-panel', chatLog:'#room-chat', chatInput:'#chat-message', chatButton:'#chat-form button', bank:'.bank-card', players:'.game-players', active:'.player-row.active', idle:'.player-row:not(.active)', dock:'.bottom-controls', hand:'.bottom-hand', phase:'#turn-label'});
        assert.deepEqual(expansionPalette, basePalette, 'Expansion surfaces use the base-game colors exactly');
        assert.equal(expansionActionBackground, await page.locator('.action-tray [data-build="road"]').evaluate(element => getComputedStyle(element).backgroundImage), 'Action tiles use the same artwork in both modes');
        assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
        console.log('Cities & Knights interface browser checks passed');
    } finally {
        await browser?.close();
        fixture.kill();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
