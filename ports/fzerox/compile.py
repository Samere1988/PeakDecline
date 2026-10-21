"""Compile the cartridge game source to WASM objects; this is not a playable build.

The link/runtime stage is intentionally separate: no missing-function stubs or
placeholder assets are published as a game. Upstream sources remain untouched.
"""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.tmp/fzerox'
REFERENCE = WORK / 'G-Diffuser'
DECOMP = REFERENCE / 'decomp'
BUILD = WORK / 'build'
EMCC = ROOT / '.tmp/mk64/emsdk/upstream/emscripten/emcc.py'


def main():
    include = BUILD / 'include'
    shutil.copytree(DECOMP / 'include', include, dirs_exist_ok=True)
    replacements = {
        'PR/gbi.h': [('typedef unsigned long long GfxW1;', 'typedef unsigned int GfxW1;')],
        'libc/stdint.h': [('typedef s64 intptr_t;', 'typedef __INTPTR_TYPE__ intptr_t;'),
                          ('typedef u64 uintptr_t;', 'typedef __UINTPTR_TYPE__ uintptr_t;')],
        'global.h': [('extern void *memset(void *, int, unsigned long long);',
                      'extern void *memset(void *, int, __SIZE_TYPE__);')],
    }
    for name, changes in replacements.items():
        path = include / name
        source = path.read_text()
        for before, after in changes:
            if source.count(before) != 1:
                raise SystemExit(f'Upstream header changed: {name}: {before}')
            source = source.replace(before, after)
        path.write_text(source)
    flags = ['-O1', '-ffp-contract=off', '-fno-strict-aliasing', '-fwrapv', '-w',
             '-Wno-error=int-conversion', '-Wno-error=incompatible-pointer-types',
             '-Wno-error=implicit-function-declaration']
    # Do not copy the native build's -fcommon: this Emscripten backend crashes
    # emitting common symbols. Duplicate tentative definitions need resolving
    # explicitly before linking, not hiding with --allow-multiple-definition.
    flags += ['-I' + str(p) for p in (include, DECOMP, DECOMP / 'src', REFERENCE / 'include')]
    flags += ['-D' + s for s in ('PORT=1', 'GDIFFUSER_PORT=1', 'NON_MATCHING=1',
              'NON_EQUIVALENT=1', 'AVOID_UB=1', 'F3DEX_GBI_2=1', '_LANGUAGE_C=1',
              'VERSION_US=1', 'ASSET_VERSION=us', 'ASSET_REVISION=rev0')]
    sources = []
    for folder in ('game', 'sys', 'overlays', 'audio', 'framebuffers', 'libultra/gu', 'libultra/os'):
        sources.extend((DECOMP / 'src' / folder).rglob('*.c'))
    excluded = {'gettime.c', 'settime.c', 'settimer.c', 'timerintr.c', 'createthread.c',
                'initialize.c', 'getmemsize.c', 'virtualtophysical.c', 'physicaltovirtual.c'}
    excluded_paths = ('/sys/disk/', '/audio/disk/', '/overlays/expansion_kit/',
                      '/overlays/course_edit/', '/overlays/machine_create/', '/overlays/ead_demo/')
    def selected(p):
        rel = p.relative_to(DECOMP).as_posix()
        return not (any(part in '/' + rel for part in excluded_paths) or
                    ('/libultra/os/' in '/' + rel and p.name in excluded) or
                    rel in ('src/sys/segment.c', 'src/sys/cartridge_offsets.c',
                            'src/overlays/ovl_i2/dd_save.c', 'src/overlays/ovl_i2/ovl_i2_data2.c',
                            'src/overlays/ovl_i10/187510.c', 'src/audio/rom/lib/aisetnextbuf.c'))
    sources = sorted(p for p in sources if selected(p))
    # Compile the portable host pieces too. The native LinkStubs.c contains
    # function/data symbol mismatches and must not be used to mask missing
    # browser implementations at link time.
    sources += [REFERENCE / 'port' / name for name in (
        'decomp_port.c', 'n64_sched.c', 'n64_vi.c', 'gen/AssetBindings.c',
        'shims.c', 'gdx_dev_gates.c', 'gdx_segment_source.c', 'n64_audio_hle.c')]
    flags += ['-I' + str(REFERENCE / 'port')]
    def compile_one(path):
        relative = path.relative_to(REFERENCE)
        obj = BUILD / 'objects' / relative.with_suffix('.o')
        obj.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run([sys.executable, str(EMCC), '-c', str(path), '-o', str(obj), *flags],
                                capture_output=True, text=True)
        obj.with_suffix('.log').write_text(result.stdout + result.stderr)
        return {'source': relative.as_posix(), 'compiled': result.returncode == 0,
                'diagnostic': str(obj.with_suffix('.log').relative_to(ROOT))}
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(compile_one, sources))
    (BUILD / 'compile-results.json').write_text(json.dumps(results, indent=2))
    failures = [item for item in results if not item['compiled']]
    print(f'{len(results) - len(failures)}/{len(results)} source files compiled to WASM objects.')
    for item in failures:
        print(item['source'], '->', item['diagnostic'])
    raise SystemExit(bool(failures))


if __name__ == '__main__':
    main()
