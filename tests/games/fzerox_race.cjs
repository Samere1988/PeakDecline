const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
(async () => {
    const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args:['--enable-unsafe-swiftshader']});
    const page = await browser.newPage();
    const messages = [];
    page.on('console', item => messages.push(item.type() + ': ' + item.text()));
    page.on('pageerror', error => messages.push('pageerror: ' + error.stack));
    async function advance(count, buttons=0, x=0, y=0) {
        const target = await page.evaluate(({count,buttons,x,y}) => {
            window.fzeroPads = [{buttons,x,y}];
            return window.fzeroState.tick + count;
        }, {count,buttons,x,y});
        await page.waitForFunction(target => window.fzeroState.tick >= target, target, {timeout:60000});
    }
    try {
        await page.goto('http://127.0.0.1:8067/game');
        await page.waitForFunction(() => window.fzeroState?.tick >= 500, null, {timeout:60000});
        await advance(8, 0x1000); await advance(90);
        for (let i=0; i<16; i++) {
            console.log(i, await page.evaluate(() => window.fzeroState));
            await page.screenshot({path:`.tmp/fzerox/race-${i}.png`});
            if ((await page.evaluate(() => window.fzeroState.mode & 31)) === 1) {
                await advance(600, 0x8000);
                await page.screenshot({path:'.tmp/fzerox/race-running.png'});
                console.log('Racing:', await page.evaluate(() => window.fzeroState));
                return;
            }
            await advance(8, 0x8000); await advance(100);
        }
        throw new Error('The input sequence did not reach a GP race.');
    } finally {
        fs.writeFileSync('.tmp/fzerox/race-browser.log', messages.join('\n'));
        await browser.close();
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
