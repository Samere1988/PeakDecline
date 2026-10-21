"""Pinned single-player browser builds. Run with the Emscripten environment active.

Assets stay in instance/<game>/data. Missing Sonic/Driver data keeps games disabled.
No service restart is performed. Driver input is an installed REDRIVER2 data tree.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {'sm64': 'sm64ex', 'zelda3': 'zelda3', 'sonic': 'sonic-web', 'driver2': 'redriver2'}
COMMON = ['-O2', '-sALLOW_MEMORY_GROWTH=1', '-sFORCE_FILESYSTEM=1',
          '-sEXPORTED_RUNTIME_METHODS=FS,IDBFS,callMain', '-lidbfs.js',
          '-sINCOMING_MODULE_JS_API=arguments,canvas,locateFile,preRun,onRuntimeInitialized,onAbort,print,printErr,noInitialRun']
ENV = os.environ.copy()
ENV['PATH'] = str(ROOT / '.tmp/native-tools/bin') + os.pathsep + ENV['PATH']


def run(args, cwd=ROOT):
    subprocess.run([str(a) for a in args], cwd=cwd, env=ENV, check=True)


def apply(source, patch):
    if subprocess.run(['git', 'apply', '--reverse', '--check', str(patch)], cwd=source, capture_output=True).returncode:
        run(['git', 'apply', '--check', patch], source)
        run(['git', 'apply', patch], source)


def prepare(game):
    port = ROOT / 'ports' / game
    spec = json.loads((port / 'sources.json').read_text())
    source = ROOT / '.tmp' / SOURCES[game]
    if not source.exists():
        run(['git', 'clone', spec['repository'], source])
        run(['git', 'checkout', '--detach', spec['commit']], source)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != spec['commit']:
        raise SystemExit('Unexpected source revision: ' + str(source))
    if game == 'driver2':
        run(['git', 'submodule', 'update', '--init', '--recursive'], source)
        apply(source / 'src_rebuild/PsyCross', port / 'psycross.patch')
    apply(source, port / 'browser.patch')
    return source, port


def publish(game, folder, stem, port):
    destination = ROOT / 'instance' / game / 'build'
    destination.mkdir(parents=True, exist_ok=True)
    for suffix in ('js', 'wasm', 'data'):
        source = folder / (stem + '.' + suffix)
        if not source.exists():
            if suffix == 'data':
                continue
            raise SystemExit('Missing build output: ' + str(source))
        name = ('sm64' if game == 'sm64' else stem) + '.' + suffix
        pending = destination / (name + '.pending')
        shutil.copyfile(source, pending)
        pending.replace(destination / name)
    shutil.copyfile(port / 'sources.json', destination / 'sources.json')


def sonic_asset(path, game):
    if not path:
        return
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            matches = [n for n in archive.namelist() if n.rsplit('/', 1)[-1].lower() in ('data.rsdk', 'data.rsdk.xmf')]
            if len(matches) != 1:
                raise SystemExit('The APK must contain exactly one Data.rsdk.')
            data = archive.read(matches[0])
    else:
        data = path.read_bytes()
    if not data.startswith(b'RSDKvB'):
        raise SystemExit('Expected a 2013 Sonic RSDKvB data pack, not a Mega Drive ROM.')
    target = ROOT / 'instance' / game / 'data/Data.rsdk'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('game', choices=['sm64', 'sonic', 'zelda3', 'driver2', 'all'])
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--sonic1-data', type=Path)
    parser.add_argument('--sonic2-data', type=Path)
    parser.add_argument('--driver-data', type=Path, help='Installed REDRIVER2 folder with complete game data')
    args = parser.parse_args()
    sonic_asset(args.sonic1_data, 'sonic1'); sonic_asset(args.sonic2_data, 'sonic2')
    for game in SOURCES if args.game == 'all' else [args.game]:
        source, port = prepare(game)
        data_dir = ROOT / 'instance' / game / 'data'
        data_dir.mkdir(parents=True, exist_ok=True)
        if game == 'sm64':
            rom = ROOT / 'static/roms/N64/Super Mario 64 (U) [!].z64'
            if hashlib.sha1(rom.read_bytes()).hexdigest() != '9bef1128717f958171a4afac3ed78ee2bb4e86ce':
                raise SystemExit('Super Mario 64 requires the original US ROM.')
            shutil.copyfile(rom, source / 'baserom.us.z64')
            run(['nice', '-n15', 'make', 'TARGET_WEB=1', 'VERSION=us', '-j8'], source)
            if args.publish:
                publish(game, source / 'build/us_web', 'sm64.us.f3dex2e', port)
                (data_dir / 'source.sha256').write_text(hashlib.sha256(rom.read_bytes()).hexdigest())
        elif game == 'zelda3':
            with zipfile.ZipFile(ROOT / 'static/roms/SNES/Super Nintendo/Legend of Zelda - A Link to the Past, The.zip') as archive:
                rom = archive.read(next(n for n in archive.namelist() if n.lower().endswith(('.smc', '.sfc'))))
            if len(rom) % 1024 == 512:
                rom = rom[512:]
            if hashlib.sha256(rom).hexdigest() != '66871d66be19ad2c34c927d6b14cd8eb6fc3181965b6e517cb361f7316009cfb':
                raise SystemExit('Zelda requires the original US ROM.')
            (source / 'zelda3.sfc').write_bytes(rom)
            if not (source / 'zelda3_assets.dat').exists():
                run([sys.executable, 'assets/restool.py', '--extract-from-rom'], source)
            files = [*source.glob('src/*.c'), *source.glob('snes/*.c'), source / 'third_party/gl_core/gl_core_3_1.c', source / 'third_party/opus-1.3.1-stripped/opus_decoder_amalgam.c']
            run(['nice', '-n15', 'emcc', *COMMON, '-I.', '-sUSE_SDL=2', '-DSYSTEM_VOLUME_MIXER_AVAILABLE=0', '-sASYNCIFY', '-sASYNCIFY_STACK_SIZE=131072', *files, '-o', 'zelda3.js'], source)
            if args.publish:
                publish(game, source, game, port)
                shutil.copyfile(source / 'zelda3_assets.dat', data_dir / 'zelda3_assets.dat')
        elif game == 'sonic':
            run(['nice', '-n15', 'em++', *COMMON, '-std=c++17', *source.glob('RSDKv4/*.cpp'), '-lm', '--bind', '-sUSE_SDL=2', '-sUSE_SDL_IMAGE=2', '-sSDL2_IMAGE_FORMATS=png', '-sUSE_OGG=1', '-sUSE_VORBIS=1', '-o', 'sonic.js'], source)
            if args.publish:
                for target in ('sonic1', 'sonic2'):
                    publish(target, source, 'sonic', port)
        else:
            shutil.copyfile(port / 'CMakeLists.txt', source / 'src_rebuild/CMakeLists.txt')
            build = source / 'peak-build'
            sdk = Path(ENV.get('EMSDK', ROOT / '.tmp/emsdk'))
            asset_root = args.driver_data.resolve() if args.driver_data else None
            if asset_root:
                levels = asset_root / 'DRIVER2/LEVELS'
                if not all((levels / (city+'.LEV')).is_file() for city in ('CHICAGO', 'HAVANA', 'VEGAS', 'RIO')):
                    raise SystemExit('Driver 2 needs an extracted, installed data tree containing all four cities.')
                # Keep movies out of the startup preload; the native AVI reader
                # downloads one movie through Asyncify and releases it afterwards.
                staged = build / 'assets'
                if staged.exists():
                    shutil.rmtree(staged)
                staged.mkdir(parents=True)
                movies = build / 'fmv'
                if movies.exists():
                    shutil.rmtree(movies)
                movies.mkdir(parents=True)
                for path in (asset_root / 'DRIVER2').rglob('*'):
                    if not path.is_file():
                        continue
                    relative = path.relative_to(asset_root)
                    if 'FMV' in relative.parts and path.suffix.lower() in ('.avi', '.wav'):
                        match = re.fullmatch(r'RENDER(\d+)\.STR\[0\]\.avi', path.name)
                        if match:
                            shutil.copyfile(path, movies / (match[1] + '.avi'))
                        continue
                    target = staged / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, target)
                required_movies = [*range(29), 96, 97, 98, 99]
                if not all((movies / (str(movie)+'.avi')).is_file() for movie in required_movies):
                    raise SystemExit('Driver 2 needs the complete extracted AVI cutscenes (0–28 and 96–99).')
                (staged / 'config.ini').write_text('[render]\nwindowWidth=640\nwindowHeight=480\nfullscreen=0\n[game]\nfastLoadingScreens=1\n')
                asset_root = staged.resolve()
            run([ROOT / '.venv/bin/cmake', '-S', source / 'src_rebuild', '-B', build, '-G', 'Ninja', '-DCMAKE_MAKE_PROGRAM='+str(ROOT / '.venv/bin/ninja'), '-DCMAKE_TOOLCHAIN_FILE='+str(sdk / 'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake'), '-DPEAK_DRIVER_DATA='+str(asset_root or '')])
            run(['nice', '-n15', ROOT / '.venv/bin/cmake', '--build', build, '-j8'])
            if args.publish:
                publish(game, build, game, port)
                if asset_root:
                    shutil.copytree(build / 'fmv', data_dir / 'fmv', dirs_exist_ok=True)
                    (data_dir / 'streamed-assets-v1.json').write_text(json.dumps({'installed': True}))
        print(game, 'built; data availability is checked by the game catalog')


if __name__ == '__main__':
    main()
