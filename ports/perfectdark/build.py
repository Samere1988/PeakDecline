"""Build a pinned Perfect Dark browser runtime; publishing is explicit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
WORK = ROOT / '.tmp/perfectdark'
SOURCE = ROOT / '.tmp/perfect-dark-web'
SPEC = json.loads((PORT / 'sources.json').read_text())


def executable(name, legacy):
    sibling = Path(sys.executable).parent / (name + ('.exe' if os.name == 'nt' else ''))
    return os.environ.get(name.upper()) or shutil.which(name) or str(sibling if sibling.is_file() else ROOT / legacy)


def run(*args):
    return subprocess.run([str(a) for a in args], cwd=ROOT, check=True)


def replace(path, old, new):
    text = path.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise RuntimeError(f'Unexpected source marker in {path}: {old}')
    path.write_text(text.replace(old, new), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rom', type=Path, default=ROOT / 'static/roms/N64/Perfect Dark (U) [!].z64')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    with args.rom.open('rb') as stream:
        if hashlib.file_digest(stream, 'md5').hexdigest() != SPEC['rom_md5']:
            raise SystemExit('Perfect Dark requires the US Rev 1 ROM recorded in sources.json.')
    if not SOURCE.exists():
        run('git', 'init', SOURCE)
        run('git', '-C', SOURCE, 'remote', 'add', 'origin', SPEC['repository'])
        run('git', '-C', SOURCE, 'fetch', '--depth', '1', 'origin', SPEC['commit'])
        run('git', '-C', SOURCE, 'checkout', '--detach', 'FETCH_HEAD')
    commit = subprocess.check_output(['git', '-c', f'safe.directory={SOURCE.as_posix()}', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != SPEC['commit']:
        raise SystemExit('Perfect Dark source revision differs from sources.json; existing checkout preserved.')
    generated = WORK / 'source'
    shutil.copytree(SOURCE, generated, dirs_exist_ok=True, ignore=shutil.ignore_patterns('.git', 'build*', '__pycache__'))
    replace(generated / 'cmake/AssetUtils.cmake', 'COMMAND ${execcmd}', 'COMMAND "${Python3_EXECUTABLE}" ${execcmd}')
    replace(generated / 'CMakeLists.txt', 'include(AssetUtils)', 'find_package(Python3 REQUIRED COMPONENTS Interpreter)\ninclude(AssetUtils)')
    # Modern Emscripten appends its TABLE_BASE after raw linker flags. Keep
    # callback indices above the native menu's language-ID boundary (0x5a00).
    replace(generated / 'CMakeLists.txt', '-Wl,--table-base=23040', '-sTABLE_BASE=23040\n    --emit-symbol-map')
    shutil.copyfile(PORT / 'runtime/peak_pd.c', generated / 'port/src/peak_pd.c')
    shutil.copyfile(PORT / 'runtime/peak_pd_inventory.inc', generated / 'port/src/peak_pd_inventory.inc')
    for name in ('peak_pd_vitals.inc', 'peak_pd_weapons.inc', 'peak_pd_weapon_fields.inc', 'peak_pd_sway.inc', 'peak_pd_smoke.inc', 'peak_pd_smoke_fields.inc', 'peak_pd_grenade.inc', 'peak_pd_grenade_fields.inc', 'peak_pd_grenade_create.inc'):
        shutil.copyfile(PORT / 'runtime' / name, generated / 'port/src' / name)
    shutil.copyfile(PORT / 'runtime/peak_pd.h', generated / 'port/include/peak_pd.h')
    from prepare_engine import patch
    patch(generated)
    replace(generated / 'CMakeLists.txt', '-sFORCE_FILESYSTEM=1',
        '-sFORCE_FILESYSTEM=1\n    \"-sEXPORTED_RUNTIME_METHODS=[\'FS\',\'addRunDependency\',\'removeRunDependency\']\"')
    # No graphical modifications: original timing and assets, no frame interpolation.
    replace(generated / 'port/src/video.c', 'static s32 vidDecoupledRendering = true;', 'static s32 vidDecoupledRendering = false;')
    # Replay runs the native mixer but discards browser output. Do not schedule
    # minutes of obsolete sounds that would play after joining a live game.
    replace(generated / 'port/src/audio.c', "var frames = size >>> 2;",
        "if (Module['peakReplayAudio']) { audio.nextTime = audio.context.currentTime; audio.started = false; return 0; }\n\tvar frames = size >>> 2;")
    # Route audio through a user-controlled master gain without changing game mix.
    replace(generated / 'port/src/audio.c', "source.connect(audio.context.destination);", "source.connect(Module['peakAudioGain'] || audio.context.destination);")
    cmake = executable('cmake', '.tmp/fzerox/tools/cmake/data/bin/cmake.exe')
    ninja = executable('ninja', '.tmp/fzerox/tools/bin/ninja.exe')
    sdk = Path(os.environ.get('EMSDK', ROOT / ('.tmp/emsdk' if (ROOT / '.tmp/emsdk').is_dir() else '.tmp/mk64/emsdk'))) / 'upstream/emscripten'
    run(cmake, '-S', generated, '-B', WORK / 'build', '-G', 'Ninja',
        '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
        '-DCMAKE_MAKE_PROGRAM=' + str(ninja), '-DPython3_EXECUTABLE=' + Path(sys.executable).as_posix(),
        '-DCMAKE_TOOLCHAIN_FILE=' + (sdk / 'cmake/Modules/Platform/Emscripten.cmake').as_posix())
    run(cmake, '--build', WORK / 'build', '--target', 'pd', '-j', '6')
    (WORK / 'build/LICENSE.txt').write_text('\n\n'.join(
        (SOURCE / name).read_text(encoding='utf-8') for name in ('LICENSE', 'port/fast3d/LICENSE.txt')), encoding='utf-8')
    (WORK / 'build/source.json').write_text(json.dumps(SPEC, indent=2) + '\n')
    if args.publish:
        from publish import publish
        publish()
    print('Perfect Dark browser build complete. Multiplayer adapter is not connected yet.')


if __name__ == '__main__':
    main()
