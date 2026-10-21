const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path = require('node:path');
(async () => {
    const browser = await chromium.launch({headless: true,
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        args: ['--enable-unsafe-swiftshader']});
    const page = await browser.newPage();
    const messages = [];
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    page.on('response', async response => {
        if (response.url().endsWith('.wasm') || response.url().endsWith('.js')) {
            const name = response.url().split('/').pop();
            const expected = crypto.createHash('sha256').update(fs.readFileSync(path.resolve('.tmp/fzerox/runtime-build', name))).digest('hex');
            let body;
            try { body = await response.body(); } catch { return; }
            const actual = crypto.createHash('sha256').update(body).digest('hex');
            messages.push(`${name} ${expected === actual ? 'matches disk' : 'MISMATCH'}`);
        }
    });
    page.on('console', item => messages.push(item.type() + ': ' + item.text()));
    page.on('pageerror', error => messages.push('pageerror: ' + error.stack));
    try {
        await page.goto('http://127.0.0.1:8067/');
        await page.waitForFunction(() => window.fzeroRendererFrames >= 60, {timeout: 30000});
        await page.screenshot({path: path.resolve('.tmp/fzerox/renderer.png')});
        console.log('Renderer frames:', await page.evaluate(() => window.fzeroRendererFrames));
    } catch (error) {
        console.error(messages.slice(-25).join('\n'));
        console.error(error.message);
        process.exitCode = 1;
    } finally { await browser.close(); }
})();
