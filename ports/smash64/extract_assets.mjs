// Local build helper: run upstream Torch WASM without a native C++ compiler.
// Outputs stay in the experimental checkout until gameplay is verified.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, '.tmp/battleship-web');
const build = path.join(source, 'torch/build-wasm');
// Explicit ESM extension works on Node versions that treat .js as CommonJS.
fs.copyFileSync(path.join(build, 'torch.js'), path.join(build, 'torch.mjs'));
const {default: createTorch} = await import(pathToFileURL(path.join(build, 'torch.mjs')));
const module = await createTorch({
    wasmBinary: fs.readFileSync(path.join(build, 'torch.wasm')),
    print: () => {}, printErr: console.error
});
module.FS.mkdirTree('/src/yamls/us');
module.FS.mkdirTree('/out');
for (const relative of ['config.yml', ...fs.readdirSync(path.join(source, 'yamls/us')).filter(n => n.endsWith('.yml')).map(n => 'yamls/us/' + n)]) {
    module.FS.writeFile('/src/' + relative, fs.readFileSync(path.join(source, relative)));
}
const rom = fs.readFileSync(path.join(root, 'static/roms/N64/Super Smash Bros. (U) [!].z64'));
const ptr = module._malloc(rom.length);
try {
    module.HEAPU8.set(rom, ptr);
    const rc = module.ccall('torch_extract_o2r', 'number', ['number', 'number', 'string', 'string'], [ptr, rom.length, '/src', '/out']);
    if (rc !== 0) throw new Error('Torch extraction failed: ' + rc);
    const archive = module.FS.readFile('/out/BattleShip.o2r');
    fs.writeFileSync(path.join(source, 'build-wasm/BattleShip.o2r'), archive);
    console.log('Extracted Smash archive:', archive.length, 'bytes');
} finally { module._free(ptr); }
