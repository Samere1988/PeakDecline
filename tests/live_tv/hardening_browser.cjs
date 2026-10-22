/* Start server.py first. Uses only its loopback synthetic media and identities. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const playwright = require(process.env.WATCH_PLAYWRIGHT || 'playwright');
const base = `http://127.0.0.1:${process.env.LIVE_TEST_PORT || 18781}`;
const fixtures = path.resolve(__dirname, '../watch_together/fixtures');
const report = [], browsers = [], errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function record(name, data = {}) {report.push({name, passed: true, ...data}); console.log('PASS', name, JSON.stringify(data));}
(async () => {
    try {
        const pages = [];
        for (const [engine, executablePath] of [['chromium', process.env.WATCH_BROWSER], ['firefox', process.env.WATCH_FIREFOX]]) {
            const browser = await playwright[engine].launch({headless: true, executablePath,
                ...(engine === 'chromium' ? {args: ['--autoplay-policy=no-user-gesture-required']} : {firefoxUserPrefs: {'media.autoplay.default': 0}})});
            browsers.push(browser);
            const context = await browser.newContext();
            await context.route('https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js', route => route.fulfill({path: path.join(fixtures, 'hls.min.js'), contentType: 'application/javascript'}));
            await context.route('https://cdn.socket.io/4.6.0/socket.io.min.js', route => route.fulfill({path: path.join(fixtures, 'socket.io.min.js'), contentType: 'application/javascript'}));
            await context.route('https://fonts.googleapis.com/**', route => route.abort());
            const page = await context.newPage(); page.on('pageerror', error => errors.push(`${engine}: ${error.message}`));
            await page.goto(base + '/test/login/' + pages.length);
            pages.push(page);
            if (engine === 'chromium') await page.evaluate(() => playChannel(1));
            await page.waitForFunction(() => !video.paused && video.readyState >= 3 && Number.isFinite(programOffset()) && Number.isFinite(sharedTarget()), {}, {timeout: 45000});
            await page.waitForFunction(() => Math.abs(sharedTarget() - programOffset() - video.currentTime) < 1, {}, {timeout: 30000});
            record(engine + ' decodes and aligns', await page.evaluate(() => ({height: video.videoHeight, rate: video.playbackRate, frameTracking: !!displayedFrame})));
            for (const direction of [-1, 1]) {
                await page.evaluate(direction => {
                    needsAlignment = false; lastCorrection = -Infinity; behindSince = null;
                    const goal = video.currentTime + direction * 3;
                    video.currentTime = Math.max(video.buffered.start(0) + .5, Math.min(video.buffered.end(video.buffered.length - 1) - .5, goal));
                }, direction);
                await page.waitForFunction(() => !video.seeking && Math.abs(sharedTarget() - programOffset() - video.currentTime) < 1.2, {}, {timeout: 15000});
                record(engine + (direction < 0 ? ' corrects lag' : ' corrects lead'), await page.evaluate(() => ({drift: sharedTarget() - programOffset() - video.currentTime, rate: video.playbackRate})));
            }
        }
        const [chrome, firefox] = pages;
        await firefox.evaluate(() => video.pause());
        const previous = await chrome.evaluate(() => streamSession);
        await chrome.request.post(base + '/test/fail/exit');
        await chrome.waitForFunction(previous => streamSession !== previous && !video.paused && video.readyState >= 3, previous, {timeout: 40000});
        await firefox.waitForFunction(previous => streamSession !== previous, previous, {timeout: 40000});
        assert(await firefox.evaluate(() => video.paused));
        record('encoder death reconnects playing viewers and preserves Firefox pause');
        await firefox.evaluate(() => safePlay());
        await firefox.waitForFunction(() => !video.paused && video.readyState >= 3, {}, {timeout: 30000});
        const cdp = await chrome.context().newCDPSession(chrome);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 150, downloadThroughput: 10000, uploadThroughput: 10000});
        await chrome.waitForFunction(() => document.getElementById('live-quality-select').value === 'auto', {}, {timeout: 60000});
        record('sustained network buffering switches Native to Auto', await chrome.evaluate(() => ({note: document.getElementById('live-quality-note').textContent})));
        await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 10, downloadThroughput: 4000000, uploadThroughput: 4000000});
        await chrome.waitForFunction(() => !video.paused && video.readyState >= 3 && Math.abs(sharedTarget() - programOffset() - video.currentTime) < 1.5, {}, {timeout: 45000});
        record('playback recovers after bandwidth returns');
        assert.deepEqual(errors, []); record('no browser exceptions');
    } catch (error) {
        report.push({name: 'browser completion', passed: false, error: error.stack, pageErrors: errors});
        console.error(error); process.exitCode = 1;
    } finally {
        for (const browser of browsers) await browser.close();
        const output = process.env.LIVE_TEST_RESULTS || path.resolve(__dirname, '../../.tmp/live-tv-results');
        fs.mkdirSync(output, {recursive: true}); fs.writeFileSync(path.join(output, 'hardening-browser.json'), JSON.stringify(report, null, 2));
    }
})();
