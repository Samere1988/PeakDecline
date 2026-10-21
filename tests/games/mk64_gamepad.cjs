const assert = require('node:assert/strict');
const gamepad = require('../../static/js/mk64_gamepad.js');

function pad(id = 'Xbox Wireless Controller', mapping = 'standard') {
    return {id, mapping, connected: true, index: 0,
        buttons: Array.from({length: 17}, () => ({pressed: false, value: 0})),
        axes: [0, 0, 0, 0]};
}

const xbox = pad();
const standard = gamepad.standardProfile();
assert.equal(gamepad.isStandard(xbox), true);
assert.equal(gamepad.read(xbox, standard).buttons, 0);
xbox.buttons[0].pressed = true;
xbox.buttons[6].pressed = true;
xbox.buttons[7].pressed = true;
xbox.buttons[12].pressed = true;
xbox.axes[0] = 0.75;
xbox.axes[1] = -0.5;
xbox.axes[2] = -0.9;
assert.deepEqual(gamepad.read(xbox, standard), {
    buttons: 0x8000 | 0x2000 | 0x0010 | 0x0800 | 0x0002,
    x: 60, y: 40
});
xbox.axes[0] = 0.1;
assert.equal(gamepad.read(xbox, standard).x, 0);
xbox.connected = false;
assert.deepEqual(gamepad.read(xbox, standard), {buttons: 0, x: 0, y: 0});

const n64 = pad('8BitDo 64 Bluetooth Controller', '');
assert.equal(gamepad.isN64(n64), true);
assert.equal(gamepad.isStandard(n64), false);
const custom = gamepad.emptyProfile();
custom.bindings.a = {type: 'button', indices: [10]};
custom.bindings.dUp = {type: 'axis', index: 2, direction: 1, neutral: 0, target: 0.71};
custom.stickX = {index: 0, direction: -1, neutral: 0};
custom.stickY = {index: 1, direction: 1, neutral: 0};
n64.buttons[10].pressed = true;
n64.axes = [-0.5, 0.75, 0.71, 0];
assert.deepEqual(gamepad.read(n64, custom), {buttons: 0x8800, x: 40, y: 60});
assert.equal(gamepad.restoreProfile(custom, n64), null, 'incomplete mapping is not ready');
for (const [key] of gamepad.actions) custom.bindings[key] ||= {type: 'button', indices: [0]};
assert.equal(gamepad.complete(custom), true);
assert.deepEqual(gamepad.read(n64, gamepad.restoreProfile(custom, n64)), {buttons: 0x8800, x: 40, y: 60});
assert.deepEqual(gamepad.candidates(n64, {buttons: Array(17).fill(0), axes: [0, 0, 0, 0]}, 'dUp'), [
    {type: 'button', indices: [10]},
    {type: 'axis', index: 0, direction: -1, neutral: 0, target: -0.5},
    {type: 'axis', index: 1, direction: 1, neutral: 0, target: 0.75},
    {type: 'axis', index: 2, direction: 1, neutral: 0, target: 0.71}
]);
console.log('MK64 Gamepad mapping passed');

// Raw hats may rest outside the analog stick range, or just 2/7 from Left.
for (const neutral of [1, 9/7]) {
    const hat = pad('Raw N64 hat', '');
    hat.axes[3] = neutral;
    const baseline = gamepad.snapshot(hat);
    assert.equal(baseline.axes[3], neutral);
    hat.axes[3] = 5/7;
    const choices = gamepad.candidates(hat, baseline, 'dLeft');
    assert.equal(choices.length, 1);
    const profile = gamepad.emptyProfile();
    profile.bindings.dLeft = choices[0];
    const restored = gamepad.restoreProfile(profile, hat, true);
    assert.equal(gamepad.read(hat, restored).buttons, 0x0200);
    hat.axes[3] = neutral;
    assert.equal(gamepad.read(hat, restored).buttons, 0);
}
console.log('Raw D-pad Left hat detection, partial save and release passed');
