"""Generate narrowly adapted platform sources without editing the pinned checkout."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.tmp/fzerox'
SOURCE = WORK / 'G-Diffuser/port'
OUTPUT = WORK / 'browser-source/port'


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    graphics = (SOURCE / 'n64_gfx_bridge.cpp').read_text(encoding='utf-8')
    graphics = '#include <emscripten/heap.h>\nextern "C" unsigned char __global_base, __data_end;\n' + graphics
    # The native cache emits fixed 16-byte packets; WASM32 uses 8-byte packets.
    graphics = graphics.replace('if (!gG2ConvertEnabled || source == nullptr) {',
        'if (sizeof(uintptr_t) == 4 || !gG2ConvertEnabled || source == nullptr) {')
    graphics = graphics.replace('const bool sourceIsWide = (stride == kHostBuiltGfxStride);',
        'const bool sourceIsWide = (stride == kHostBuiltGfxStride) && (kHostBuiltGfxStride > kN64GfxStride);')
    # This build loads game textures from the cartridge, not a texture O2R pack.
    # Emitting a filepath command for an absent pack leaves the previous texture bound.
    graphics = graphics.replace('? gdx_lookup_asset_segment_o2r_key(in.w1)', '? nullptr /* ROM-backed textures */')
    # Keep the original platform code behind an unreachable branch so the
    # generated patch remains small. Optimized WASM uses linear-memory bounds.
    additions = {
        'bool ResolveRegisteredHostPointer(uint32_t raw, ResolvedAddress& out, size_t requiredBytes = 1) {':
            'if (ReadableByteLimit(raw) >= requiredBytes) {\n'
            'out.full = raw; out.segmented = false; return true;\n}\n',
        'void GetMainModuleRange(uintptr_t& moduleBegin, uintptr_t& moduleEnd) {':
            'moduleBegin = reinterpret_cast<uintptr_t>(&__global_base);\n'
            'moduleEnd = reinterpret_cast<uintptr_t>(&__data_end);\nreturn;\n',
        'size_t ReadableByteLimit(uintptr_t address) {':
            'const size_t webSize = emscripten_get_heap_size();\n'
            'return address >= 0x10000000u && address < webSize ? webSize - address : 0;\n',
        'size_t ReadableCommandLimit(const void* source, size_t stride = kN64GfxStride) {':
            'return stride ? ReadableByteLimit(reinterpret_cast<uintptr_t>(source)) / stride : 0;\n',
        'bool IsReadableAddress(uintptr_t address) {':
            'return ReadableByteLimit(address) > 0;\n',
    }
    for before, body in additions.items():
        if graphics.count(before) != 1:
            raise SystemExit('Graphics source changed: ' + before)
        graphics = graphics.replace(before, before + '\n' + body)
    (OUTPUT / 'n64_gfx_bridge.cpp').write_text(graphics, encoding='utf-8')
    scheduler = (SOURCE / 'n64_sched.c').read_text(encoding='utf-8')
    scheduler = scheduler.replace('gdx_audio_lle_run', 'gdx_audio_hle_run')
    (OUTPUT / 'n64_sched.c').write_text(scheduler, encoding='utf-8')
    # Preserve linker address markers and generated asset storage, but never
    # import the native bring-up file's no-op function bodies into the browser.
    symbols = (SOURCE / 'gen/LinkStubs.c').read_text(encoding='utf-8')
    symbols = re.sub(r'^long \w+\(\) \{ return 0; \}\s*$', '', symbols, flags=re.M)
    (OUTPUT / 'link_markers.c').write_text(symbols, encoding='utf-8')
    shims = (SOURCE / 'shims.c').read_text(encoding='utf-8')
    # Native C's loose prototypes become trapping signature mismatches in WASM.
    signatures = {
        'osPfsInitPak(void)': 'osPfsInitPak(void* mq, void* pfs, int channel)',
        'osPfsAllocateFile(void)': 'osPfsAllocateFile(void* pfs, unsigned short company, unsigned int game, unsigned char* name, unsigned char* ext, int size, int* file)',
        'osPfsReadWriteFile(void)': 'osPfsReadWriteFile(void* pfs, int file, unsigned char flag, int offset, int size, unsigned char* data)',
        'osPfsFindFile(void)': 'osPfsFindFile(void* pfs, unsigned short company, unsigned int game, unsigned char* name, unsigned char* ext, int* file)',
        'osEPiReadIo(void)        { return -1; }': 'osEPiReadIo(void* handle, unsigned int address, unsigned int* value) { if (value) *value = 0xFFFFFFFFu; return -1; }',
        'osEPiWriteIo(void)': 'osEPiWriteIo(void* handle, unsigned int address, unsigned int value)',
        'osEPiLinkHandle(void)': 'osEPiLinkHandle(void* handle)',
        'osAiSetFrequency(void) { return 0; }': 'osAiSetFrequency(unsigned int frequency) { return (int)frequency; }',
        'LeoBootGame(void)': 'LeoBootGame(void* entry)',
    }
    for before, after in signatures.items():
        if shims.count(before) != 1:
            raise SystemExit('Shim signature changed: ' + before)
        shims = shims.replace(before, after)
    (OUTPUT / 'shims.c').write_text(shims, encoding='utf-8')
    print('Browser graphics and scheduler sources generated.')


if __name__ == '__main__':
    main()
