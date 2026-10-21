const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require(process.env.WATCH_PLAYWRIGHT || 'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.join(__dirname, '../..');
(async () => {
    const browser = await chromium.launch({headless: true, executablePath: process.env.WATCH_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    try {
        const page = await browser.newPage();
        const template = fs.readFileSync(path.join(root, 'templates/live_tv.html'), 'utf8');
        await page.setContent(template.match(/{% block content %}([\s\S]*?){% endblock %}/)[1].replace(/{{[\s\S]*?}}/g, ''));
        await page.evaluate(() => {
            window.io = () => ({on() {}, emit() {}});
            window.channels = [{id: 1, name: 'Alpha', play_count: 1, Favorites: false}, {id: 2, name: 'Beta', play_count: 3, Favorites: true}];
            window.failFavorite = false;
            window.fetch = async (url, options) => {
                if (url.endsWith('/favorite')) {
                    if (window.failFavorite) return {ok: false};
                    const ch = channels.find(c => c.id === Number(url.split('/')[3]));
                    ch.Favorites = JSON.parse(options.body).favorite;
                    return {ok: true, json: async () => ({...ch})};
                }
                return {ok: true, json: async () => channels.map(c => ({...c}))};
            };
        });
        await page.addScriptTag({path: path.join(root, 'static/js/tv_player.js')});
        await page.addScriptTag({path: path.join(root, 'static/js/live_quality.js')});
        await page.evaluate(async () => {
            currentChannelId = 1;
            document.getElementById('live-favorite-toggle').addEventListener('click', toggleCurrentFavorite);
            await loadChannels();
        });
        assert.deepEqual(await page.locator('#channel-list .channel-item span').allTextContents(), ['Beta', 'Alpha']);
        await page.locator('#live-favorite-toggle').click();
        await page.waitForFunction(() => document.querySelectorAll('#favorites-list .fav-card').length === 2);
        assert.equal(await page.locator('#live-favorite-toggle').getAttribute('aria-pressed'), 'true');
        await page.evaluate(() => {document.getElementById('search-box').value = 'Alpha'; renderChannels();});
        assert.equal(await page.locator('#channel-list .channel-item').count(), 1);
        assert.equal(await page.locator('#favorites-list .fav-card').count(), 2);
        await page.locator('#live-favorite-toggle').click();
        await page.waitForFunction(() => document.querySelectorAll('#favorites-list .fav-card').length === 1);
        await page.evaluate(() => {window.failFavorite = true;});
        await page.locator('#live-favorite-toggle').click();
        await page.waitForFunction(() => document.getElementById('live-favorite-feedback').textContent.includes('Could not save'));
        assert.equal(await page.locator('#live-favorite-toggle').getAttribute('aria-pressed'), 'false');
        await page.locator('#live-quality-cog').click();
        await page.locator('#live-quality-select').selectOption('720');
        assert.equal(await page.locator('#live-quality-status').textContent(), 'Quality: 720p');
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('live-quality-levels', {detail: {levels: [], supported: false}})));
        assert.equal(await page.locator('#live-quality-status').textContent(), 'Quality: Auto (adaptive)');
        await page.evaluate(() => {currentChannelId = null; renderChannels();});
        assert.equal(await page.locator('#live-favorite-toggle').isDisabled(), true);
        console.log('PASS browser ranking, favorites add/remove/failure, search, quality status and idle controls');
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
