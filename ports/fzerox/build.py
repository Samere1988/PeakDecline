"""Build the F-Zero X browser runtime in isolation from MK64."""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
WORK = ROOT / '.tmp/fzerox'


def run(*args):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rom', type=Path, default=ROOT / 'static/roms/N64/F-ZERO X (U) [!].z64')
    parser.add_argument('--configure', action='store_true')
    parser.add_argument('--publish', action='store_true', help='Install the game build under instance/fzerox/build')
    parser.add_argument('--target', choices=('fzerox', 'renderer_probe'), default='fzerox')
    args = parser.parse_args()
    run(sys.executable, PORT / 'prepare.py', '--rom', args.rom)
    if not (WORK / 'build/compile-results.json').is_file():
        run(sys.executable, PORT / 'compile.py')
    cmake = WORK / 'tools/cmake/data/bin/cmake.exe'
    if not cmake.is_file():
        run(sys.executable, '-m', 'pip', 'install', '--target', WORK / 'tools', 'cmake==4.4.3', 'ninja==1.13.0')
    run(sys.executable, PORT / 'prepare_browser_sources.py')
    run(sys.executable, PORT / 'prepare_audio_sources.py')
    archive = WORK / 'runtime-build/gdiffuser.o2r'
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.is_file():
        run(sys.executable, WORK / 'G-Diffuser/tools/gen_f3d_o2r.py', archive)
    if args.configure or not (WORK / 'runtime-build/build.ninja').is_file():
        run(sys.executable, PORT / 'configure_runtime.py')
    run(cmake, '--build', WORK / 'runtime-build', '--target', args.target, '-j', '8')
    if args.target == 'fzerox':
        run(sys.executable, PORT / 'publish.py', WORK / 'runtime-build', WORK / 'runtime-build')
    else:
        run(sys.executable, PORT / 'publish.py', WORK / 'runtime-build')
    if args.publish:
        if args.target != 'fzerox':
            raise SystemExit('Only the complete fzerox target can be published.')
        run(sys.executable, PORT / 'publish.py', WORK / 'runtime-build', ROOT / 'instance/fzerox/build')
    print('Built isolated browser runtime. Gameplay verification is required before deployment.')


if __name__ == '__main__':
    main()
