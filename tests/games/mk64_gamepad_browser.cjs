const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const markup = `<!doctype html><html><body>
  <section id="mk64-room-browser"></section><section id="mk64-lobby"></section>
  <section id="mk64-play-area" hidden><h1 id="mk64-play-title"></h1>
    <div id="mk64-game" data-build-url="/mk64.js" data-rom-url="/rom">
      <canvas id="mk64-canvas" hidden tabindex="0"></canvas><p id="mk64-message"></p>
    </div><p id="mk64-runtime-status"></p><button id="mk64-restart" hidden>Restart</button>
  </section>
  <button id="mk64-start">Play Solo</button>
  <button id="mk64-fullscreen"></button>
  <button id="mk64-touch-menu"></button><div id="mk64-touch-settings"></div>
  <input id="mk64-touch-visible"><input id="mk64-touch-opacity"><input id="mk64-touch-size">
  <output id="mk64-touch-opacity-value"></output><output id="mk64-touch-size-value"></output><button id="mk64-touch-settings-close"></button>
  <details id="mk64-controller-panel"><summary>Controller setup</summary><div id="mk64-controller-bindings"></div></details>
  <p id="mk64-controller-status"></p><label id="mk64-controller-label"></label><select id="mk64-controller-select"></select>
  <button id="mk64-controller-setup"></button><button id="mk64-controller-back"></button><button id="mk64-controller-cancel"></button>
  <button id="mk64-controller-reset"></button><input id="mk64-controller-deadzone" value="18"><output id="mk64-controller-deadzone-value"></output>
  <p id="mk64-controller-step"></p>
  <p id="mk64-controller-test"></p>
</body></html>`;

(async () => {
    const browser = await chromium.launch({headless: true,
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('http://mk64.test/', route => route.fulfill({body: markup, contentType: 'text/html'}));
        await page.goto('http://mk64.test/');
        await page.evaluate(() => {
            window.testPad = {connected: true, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
                mapping: 'standard', index: 0, buttons: Array.from({length: 17}, () => ({pressed: false, value: 0})), axes: [0, 0, 0, 0]};
            Object.defineProperty(navigator, 'getGamepads', {configurable: true, value: () => [testPad]});
            Object.defineProperty(navigator, 'hid', {configurable: true, get() {throw new Error('WebHID accessed');}});
            window.createMK64 = async () => ({FS: {writeFile() {}}, callMain() {}});
            window.fetch = async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(0xC00000)});
        });
        const root = path.resolve(__dirname, '../../static/js');
        await page.addScriptTag({path: path.join(root, 'game_fullscreen.js')});
        await page.addScriptTag({path: path.join(root, 'mk64_gamepad.js')});
        await page.addScriptTag({path: path.join(root, 'retro_controller.js')});
        await page.addScriptTag({path: path.join(root, 'mario_kart_64.js')});
        await page.waitForFunction(() => document.querySelector('#mk64-controller-status').textContent.includes('Controls ready'));
        await page.locator('#mk64-start').click();
        await page.waitForFunction(() => !!window.mk64?.mk64Input);
        await page.evaluate(() => { testPad.buttons[0].pressed = true; testPad.axes[0] = 0.75; });
        assert.deepEqual(await page.evaluate(() => ({buttons: mk64.mk64Input.buttons, x: mk64.mk64Input.x})),
            {buttons: 0x8000, x: 60});
        await page.evaluate(() => { testPad.connected = false; window.dispatchEvent(new Event('gamepaddisconnected')); });
        assert.equal(await page.evaluate(() => mk64.mk64Input.buttons), 0);
        await page.locator('#mk64-canvas').focus();
        await page.keyboard.down('x');
        assert.equal(await page.evaluate(() => mk64.mk64Input.buttons), 0x8000);
        await page.keyboard.up('x');
        await page.evaluate(() => {
            testPad.connected = true; testPad.id = '8BitDo 64 Bluetooth Controller';
            testPad.mapping = ''; testPad.buttons[0].pressed = false; testPad.axes[0] = 0;
            window.dispatchEvent(new Event('gamepadconnected'));
        });
        await page.waitForFunction(() => document.querySelector('#mk64-controller-status').textContent.includes('Set up its N64 controls'), {}, {timeout: 3000})
            .catch(async error => { console.error('Controller status:', await page.locator('#mk64-controller-status').textContent(), errors); throw error; });
        assert.equal(await page.evaluate(() => mk64.mk64Input.buttons), 0);
        assert.equal(await page.locator('#mk64-controller-setup').isVisible(), true);
        await page.locator('#mk64-controller-setup').click();
        for (let step = 0; step < 14; step++) {
            await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.startsWith('Ready.'), {}, {timeout: 5000});
            await page.evaluate(index => {
                testPad.buttons[index].pressed = true;
                if (index === 0) testPad.axes[3] = 0.8; // A device may report both for one physical press.
            }, step);
            await page.waitForFunction(index => document.querySelector('#mk64-controller-step').textContent.includes(
                `Detected ${['A', 'B', 'Z', 'Start', 'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right', 'L', 'R', 'C Up', 'C Down', 'C Left', 'C Right'][index]}`), step, {timeout: 5000});
            if (step === 0) {
                await page.waitForTimeout(200);
                assert.match(await page.locator('#mk64-controller-step').textContent(), /Release it/);
            }
            await page.evaluate(index => {
                testPad.buttons[index].pressed = false;
                if (index === 0) testPad.axes[3] = 0;
            }, step);
            if (step === 0) {
                await page.locator('#mk64-controller-back').click();
                await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.startsWith('Ready.'), {}, {timeout: 5000});
                await page.evaluate(() => { testPad.buttons[0].pressed = true; });
                await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.includes('Detected A.'), {}, {timeout: 5000});
                await page.evaluate(() => { testPad.buttons[0].pressed = false; });
            }
        }
        for (const [index, value] of [[0, 0.9], [1, -0.8]]) {
            await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.startsWith('Ready.'), {}, {timeout: 5000});
            await page.evaluate(([axis, position]) => { testPad.axes[axis] = position; }, [index, value]);
            await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.includes('Input detected.'), {}, {timeout: 5000});
            await page.evaluate(axis => { testPad.axes[axis] = 0; }, index);
        }
        await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.includes('N64 controls saved'));
        await page.evaluate(() => { testPad.buttons[0].pressed = true; testPad.axes[0] = 0.8; });
        assert.deepEqual(await page.evaluate(() => ({buttons: mk64.mk64Input.buttons, x: mk64.mk64Input.x})),
            {buttons: 0x8000, x: 64});
        await page.evaluate(async () => {
            window.testNetwork = {bind(_module, input) {this.input = input;}};
            await window.mk64RestartOnline({slot: 0, players: 2, network: testNetwork});
        });
        assert.deepEqual(await page.evaluate(() => ({buttons: testNetwork.input.buttons, x: testNetwork.input.x})),
            {buttons: 0x8000, x: 64});
        // Correct one hat direction without walking the full wizard again.
        await page.evaluate(() => { testPad.buttons[0].pressed = false; testPad.axes[0] = 0; testPad.axes[3] = 1; });
        await page.locator('#mk64-controller-panel summary').click();
        assert.equal(await page.locator('[data-control]').count(), 16);
        const before = await page.evaluate(() => JSON.parse(localStorage.getItem('mk64-gamepad-profiles-v1')));
        await page.locator('[data-control="dLeft"]').click();
        await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.startsWith('Ready.'));
        await page.evaluate(() => { testPad.axes[3] = 5/7; });
        await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.includes('Input detected.'));
        await page.evaluate(() => { testPad.axes[3] = 1; });
        await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.includes('D-pad Left saved'));
        await page.evaluate(() => { testPad.axes[3] = 5/7; });
        assert.equal(await page.evaluate(() => testNetwork.input.buttons), 0x0200);
        const after = await page.evaluate(() => JSON.parse(localStorage.getItem('mk64-gamepad-profiles-v1')));
        const key = Object.keys(after).find(key => key.includes('8BitDo'));
        assert.deepEqual({...after[key].bindings, dLeft: before[key].bindings.dLeft}, before[key].bindings);
        await page.evaluate(() => { testPad.axes[3] = 1; });
        await page.locator('[data-control="a"]').click();
        await page.locator('#mk64-controller-panel summary').click();
        await page.waitForFunction(() => document.querySelector('#mk64-controller-step').textContent.includes('cancelled'));
        assert.deepEqual(errors, []);
        console.log('MK64 browser detection, solo/online input, disconnect, keyboard, and full raw setup passed');
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
