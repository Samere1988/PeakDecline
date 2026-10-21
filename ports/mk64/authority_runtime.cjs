/* Experimental native adapter. No service or production catalogue integration. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function createSimulation({build, rom, players = 2, save, nativeMenus = false}) {
    if(!Number.isInteger(players)||players<1||players>4)throw new Error('Invalid player count');
    const manifest = JSON.parse(fs.readFileSync(path.join(build, 'state-manifest.json')));
    const wasm = fs.readFileSync(path.join(build, 'mk64.wasm'));
    if (crypto.createHash('sha256').update(wasm).digest('hex') !== manifest.wasm)
        throw new Error('Snapshot layout does not match candidate Wasm');
    const create = require(path.resolve(build, 'mk64.js'));
    const module = await create({wasmBinary: wasm, noInitialRun:true,
        mk64Headless:true, mk64Multiplayer:true, mk64PlayerCount:players, mk64NativeMenus:nativeMenus,
        mk64LocalSlot:0, print:()=>{}, printErr:line=>process.stderr.write(line+'\n')});
    module.FS.writeFile('/baserom.us.z64', fs.readFileSync(rom));
    if (save) module.FS.writeFile('/eeprom.bin', save);
    module.callMain([]);
    return require('./native_state.js').attach(module,manifest,players);
}
module.exports = {createSimulation};
