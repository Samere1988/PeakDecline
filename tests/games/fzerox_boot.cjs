const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
    const browser = await chromium.launch({headless: true,
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        args: ['--enable-unsafe-swiftshader']});
    const page = await browser.newPage();
    const messages = [];
    fs.writeFileSync('.tmp/fzerox/boot-browser-live.log', '');
    const record = message => { messages.push(message); fs.appendFileSync('.tmp/fzerox/boot-browser-live.log', message + '\n'); };
    page.on('console', item => record(item.type() + ': ' + item.text()));
    page.on('pageerror', error => record('pageerror: ' + error.stack));
    try {
        await page.goto(process.env.FZERO_TEST_URL || 'http://127.0.0.1:8067/game');
        await page.waitForFunction(() => window.fzeroState?.tick >= 600, null, {timeout: 60000});
        await page.screenshot({path: path.resolve('.tmp/fzerox/game.png')});
        const state = await page.evaluate(() => window.fzeroState);
        console.log('Game:', state);
        if (state.frame < 1) throw new Error('The browser loop runs, but the game simulation has not started.');
    } catch (error) {
        console.error(messages.slice(-35).join('\n'));
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        fs.writeFileSync('.tmp/fzerox/boot-browser.log', messages.join('\n'));
        await browser.close();
    }
})();
