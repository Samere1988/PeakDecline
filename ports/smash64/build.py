"""Build pinned experimental Smash and Torch WASM; never publish automatically."""
import os
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / '.tmp/battleship-web'


def executable(name, legacy):
    sibling = Path(sys.executable).parent / (name + ('.exe' if os.name == 'nt' else ''))
    return os.environ.get(name.upper()) or shutil.which(name) or str(sibling if sibling.is_file() else ROOT / legacy)


CMAKE = executable('cmake', '.tmp/fzerox/tools/cmake/data/bin/cmake.exe')
NINJA = executable('ninja', '.tmp/fzerox/tools/bin/ninja.exe')
SDK = Path(os.environ.get('EMSDK', ROOT / ('.tmp/emsdk' if (ROOT / '.tmp/emsdk').is_dir() else '.tmp/mk64/emsdk')))
TOOLCHAIN = SDK / 'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake'


def run(*args):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-only', action='store_true', help='Reuse existing extracted assets; skip Torch.')
    args = parser.parse_args()
    if os.name == 'nt':
        os.environ['PATH'] = r'C:\Program Files\Git\usr\bin;C:\Program Files\Git\mingw64\bin;' + os.environ['PATH']
    run(sys.executable, ROOT / 'ports/smash64/prepare_rollback.py')
    common = ['-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
              '-DCMAKE_TOOLCHAIN_FILE=' + TOOLCHAIN.as_posix(),
              '-DCMAKE_MAKE_PROGRAM=' + str(NINJA),
              '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', '-DCMAKE_CXX_SCAN_FOR_MODULES=OFF']
    run(CMAKE, '-S', SOURCE, '-B', SOURCE / 'build-wasm', *common,
        '-DUSE_AUTO_VCPKG=OFF', '-DDISABLE_SCRIPTING=ON')
    run(CMAKE, '--build', SOURCE / 'build-wasm', '--target', 'BattleShip.js', '-j', '6')
    if args.runtime_only:
        return
    run(CMAKE, '-S', SOURCE / 'torch', '-B', SOURCE / 'torch/build-wasm', *common,
        '-DUSE_STANDALONE=ON', '-DBUILD_SSB64=ON', '-DBUILD_STORMLIB=OFF',
        '-DBUILD_SM64=OFF', '-DBUILD_MK64=OFF', '-DBUILD_SF64=OFF', '-DBUILD_PM64=OFF',
        '-DBUILD_FZERO=OFF', '-DBUILD_MARIO_ARTIST=OFF', '-DBUILD_NAUDIO=ON',
        '-DTORCH_WEB_EXTRA_SOURCES=' + (SOURCE / 'port/css_icons/stage_assets_derive.cpp').as_posix(),
        '-DTORCH_WEB_EXTRA_INCLUDES=' + (SOURCE / 'port/css_icons').as_posix(),
        '-DTORCH_WEB_EXTRA_DEFINES=TORCH_WEB_STAGE_ASSETS')
    run(CMAKE, '--build', SOURCE / 'torch/build-wasm', '-j', '4')


if __name__ == '__main__':
    main()
