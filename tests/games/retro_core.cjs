const assert = require('node:assert/strict');
const path = require('node:path');
const createCore = require(path.resolve(__dirname, '../../instance/netplay/build/netplay.js'));
(async () => {
    const core = await createCore();
    assert.equal(core._pn_reset(0), 0);
    assert.equal(core._pn_reset(9), 0);
    for (const count of [1, 2, 4, 8]) {
        assert.equal(core._pn_reset(count), 1);
        for (let frame = 1; frame < 300; frame++) {
            assert.equal(core._pn_ready(frame), 0);
            for (let slot = 0; slot < count; slot++) {
                const input = (0xb0500000 | (slot << 4)) >>> 0;
                assert.equal(core._pn_store(slot, frame, input), 1);
                assert.equal(core._pn_store(slot, frame, input ^ 1), 0);
                assert.equal(core._pn_input(slot, frame) >>> 0, input);
                if (slot < count - 1) assert.equal(core._pn_ready(frame), 0);
            }
            assert.equal(core._pn_ready(frame), 1);
        }
        assert.equal(core._pn_ready(1), 0);
        assert.equal(core._pn_store(0, 1, 0), 0);
        assert.equal(core._pn_store(0, 500, 0), 0);
    }
    console.log('Retro WASM core: 1/2/4/8 seats, wraparound, admission, conflicting and stale inputs passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
