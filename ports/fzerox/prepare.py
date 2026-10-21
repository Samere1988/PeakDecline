"""Fetch pinned source-port inputs and validate the local US F-Zero X ROM."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
WORK = ROOT / '.tmp/fzerox'


def git(directory, *args):
    return subprocess.check_output(['git', '-c', f'safe.directory={directory.as_posix()}',
                                    '-C', str(directory), *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rom', type=Path, required=True)
    args = parser.parse_args()
    pins = json.loads((PORT / 'sources.json').read_text())
    if hashlib.md5(args.rom.read_bytes()).hexdigest() != pins['rom_md5']:
        raise SystemExit('Expected the US revision 0 big-endian F-Zero X ROM.')
    WORK.mkdir(parents=True, exist_ok=True)
    for name, folder in (('decomp', 'source'), ('G-Diffuser', 'G-Diffuser')):
        pin = pins[name]
        destination = WORK / folder
        if not destination.exists():
            subprocess.run(['git', 'clone', '--no-checkout', '--depth', '1', pin['url'],
                            str(destination)], check=True)
            git(destination, 'fetch', '--depth', '1', 'origin', pin['commit'])
            git(destination, 'checkout', '--detach', pin['commit'])
        if git(destination, 'rev-parse', 'HEAD') != pin['commit']:
            raise SystemExit(f'Unexpected revision in {destination}; existing work was preserved.')
    reference = WORK / 'G-Diffuser'
    for module in ('decomp', 'libultraship', 'torch'):
        if not (reference / module / '.git').exists():
            git(reference, 'submodule', 'update', '--init', '--depth', '1', module)
        expected = git(reference, 'ls-tree', 'HEAD', module).split()[2]
        if git(reference / module, 'rev-parse', 'HEAD') != expected:
            raise SystemExit(f'Unexpected revision for {module}; existing work was preserved.')
    if git(reference / 'decomp', 'rev-parse', 'HEAD') != pins['ported_decomp']['commit']:
        raise SystemExit('Unexpected ported decomp revision.')
    print('Pinned sources and US ROM verified. Browser port work remains in ports/fzerox.')


if __name__ == '__main__':
    main()
