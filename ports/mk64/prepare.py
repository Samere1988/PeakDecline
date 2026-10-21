"""Fetch pinned build tools and generate assets from a supplied US ROM."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
WORK = ROOT / '.tmp/mk64'
US_ROM_SHA1 = '579c48e211ae952530ffc8738709f078d5dd215e'


def run(*args):
    subprocess.run(list(map(str, args)), check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rom', type=Path, required=True)
    args = parser.parse_args()
    rom = args.rom.resolve(strict=True)
    if hashlib.sha1(rom.read_bytes()).hexdigest() != US_ROM_SHA1:
        raise SystemExit('Expected the original 12 MiB US .z64 ROM; checksum did not match.')
    pins = json.loads((PORT / 'sources.json').read_text())
    WORK.mkdir(parents=True, exist_ok=True)
    for name in ('MKart360', 'emsdk'):
        pin = pins[name]
        directory = WORK / name
        if not directory.exists():
            run('git', 'clone', '--no-checkout', '--depth', '1', pin['url'], directory)
            run('git', '-C', directory, 'fetch', '--depth', '1', 'origin', pin['commit'])
            run('git', '-C', directory, 'checkout', '--detach', pin['commit'])
        revision = subprocess.check_output(['git', '-C', str(directory), 'rev-parse', 'HEAD'], text=True).strip()
        if revision != pin['commit']:
            raise SystemExit(f'{directory} is at a different revision. Preserve its changes and use the pinned commit in sources.json.')
    sdk = WORK / 'emsdk/emsdk.py'
    run(sys.executable, sdk, 'install', pins['emscripten_version'])
    run(sys.executable, sdk, 'activate', pins['emscripten_version'])
    run(sys.executable, WORK / 'MKart360/mk64-master/PUBLIC_PREPARE_MK64_ASSETS.py', '--rom', rom)
    print('Ready. Run: python ports/mk64/build.py')


if __name__ == '__main__':
    main()
