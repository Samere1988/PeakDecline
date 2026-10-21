const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../..');
(async () => {
    const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    try {
        const page = await browser.newPage();
        await page.addInitScript(() => { Math.random = () => 0; });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin !== 'http://games.test') return route.fulfill({body: ''});
            if (url.pathname.startsWith('/static/')) return route.fulfill({path: path.join(root, url.pathname)});
            return route.fulfill({path: path.join(__dirname, 'catan.html'), contentType: 'text/html'});
        });
        await page.goto('http://games.test/catan');
        assert.equal(await page.locator('.hex').count(), 19);
        assert.equal(await page.locator('.hex .number').count(), 18);
        assert.equal(await page.locator('.number').allTextContents().then(v => v.some(n => n.includes('null'))), false);
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'static/assets/catan/colonist/sources.json'), 'utf8').replace(/^\uFEFF/, ''));
        await page.evaluate(async assets => {
            for (const asset of assets) {
                const image = new Image();
                image.src = '/static/assets/catan/colonist/' + asset.file;
                await image.decode();
                if (!image.naturalWidth) throw new Error('Empty asset: ' + asset.file);
            }
        }, manifest.assets);
        const sounds = JSON.parse(fs.readFileSync(path.join(root, 'static/assets/catan/colonist/sounds/sources.json'), 'utf8'));
        await page.evaluate(async assets => {
            const decoder = new OfflineAudioContext(1, 1, 44100);
            for (const asset of assets) {
                const response = await fetch('/static/assets/catan/colonist/sounds/' + asset.file);
                const decoded = await decoder.decodeAudioData(await response.arrayBuffer());
                if (decoded.duration <= 0) throw new Error('Empty sound: ' + asset.file);
            }
            window.playedSounds = [];
            const original = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function () { window.playedSounds.push(this.src); return original.call(this); };
        }, sounds.assets);
        await page.locator('#sound-toggle').click();
        assert.equal(await page.locator('#sound-toggle').getAttribute('aria-pressed'), 'false');
        await page.evaluate(() => CatanAudio.play('sfx_click'));
        assert.equal(await page.evaluate(() => playedSounds.length), 0, 'Muted sound must not play');
        await page.reload();
        assert.equal(await page.locator('#sound-toggle').innerText(), 'Sound off', 'Mute preference persists');
        await page.locator('#sound-toggle').click();
        for (const width of [320, 390, 768, 1366]) {
            await page.setViewportSize({width, height: 1000});
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Page fits at ${width}`);
            assert.equal(await page.locator('.hex-board').evaluate(board => {
                const outer = board.parentElement.getBoundingClientRect();
                return [...board.querySelectorAll('.hex, .board-piece')].every(el => {
                    const box = el.getBoundingClientRect();
                    return box.left >= outer.left && box.right <= outer.right && box.top >= outer.top && box.bottom <= outer.bottom;
                });
            }), true, `Tiles and settlements fit at ${width}`);
            assert.equal(await page.locator('.hex .number').evaluateAll(numbers => numbers.every(number => {
                const hexWidth = number.closest('.hex').getBoundingClientRect().width;
                const hex = number.closest('.hex').getBoundingClientRect();
                const tile = number.getBoundingClientRect();
                const offset = (tile.top + tile.height / 2 - hex.top - hex.height / 2) / hexWidth;
                return Math.abs(tile.width / hexWidth - .36) < .01 &&
                    Math.abs(parseFloat(getComputedStyle(number).fontSize) / hexWidth - .233) < .01 &&
                    offset > .13 && offset < .17 &&
                    number.scrollWidth <= number.clientWidth + 1 && number.scrollHeight <= number.clientHeight + 1;
            })), true, `Number squares and pips fit at ${width}`);
            if ([390, 1366].includes(width)) await page.screenshot({path: path.join(__dirname, `catan-${width}.png`), fullPage: true});
        }
        assert.equal(await page.locator('#roll-dice').isDisabled(), true);
        assert.equal(await page.locator('.coastal-port').count(), 9);
        assert.equal(await page.locator('.coastal-port img').count(), 9, 'One ship per port');
        assert.equal(await page.locator('.port-pier').count(), 18, 'Two original dock sprites per port');
        assert.equal(await page.locator('.port-boat, line.port-dock').count(), 0, 'No duplicate ships or placeholder docks');
        assert.equal(await page.locator('#bank-resources .card-stat').count(), 6);
        assert.equal(await page.locator('.bottom-controls [data-build]').count(), 3);
        await page.locator('#open-trade').click();
        assert.equal(await page.locator('#trade-from').evaluate(el=>el===document.activeElement), true);
        for (let i = 0; i < 8; i++) {
            await page.locator('.placement-target').first().click();
            assert.match(await page.locator('#game-message').innerText(), /connected/);
            await page.locator('.road-target').first().click();
        }
        assert.equal(await page.locator('.board-piece').count(), 8);
        assert.equal(await page.locator('.placed-road').count(), 8);
        assert.equal(await page.locator('.placed-road').first().getAttribute('href'), '/static/assets/catan/colonist/road-red.svg');
        await page.evaluate(() => { Math.random = () => 0.2; });
        await page.locator('#roll-dice').click();
        assert.equal(await page.locator('.die').count(), 2);
        assert.equal(await page.locator('#dice-display strong').innerText(), '4');
        assert.equal(await page.locator('#roll-dice').isDisabled(), true);
        await page.screenshot({path: path.join(__dirname, 'catan-playing-1366.png'), fullPage: true});
        await page.locator('#end-turn').click();
        assert.ok((await page.locator('#turn-label').innerText()).includes((await page.locator('#players .player-name').nth(1).innerText()).trim()));
        assert.ok((await page.locator('.build-piece-image').first().getAttribute('src')).endsWith('road-blue.svg'));
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#new-game').click();
        assert.match(await page.locator('#turn-label').innerText(), /Starting placement/);
        assert.deepEqual(errors, []);
        console.log('PASS: graphics and all 48 sounds decode, mute/persistence, responsive board at 320–1366px, eight settlement/road pairs, nine ports, dice, turns, reset, no browser errors.');
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
