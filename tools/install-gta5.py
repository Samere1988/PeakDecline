"""Install already-downloaded PlayGTA5 release ZIPs using its SHA-256 inventory.

Usage: python3 tools/install-gta5.py .tmp/gta5-download
Only game files are extracted; upstream executables and launchers are not run.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'mirror/playgta5.com/'


def install(downloads):
    destination = ROOT / 'instance/gta5'
    destination.mkdir(parents=True, exist_ok=True)
    stage = destination / 'game-staging'
    stage.mkdir(exist_ok=True)
    records = json.loads((downloads / 'file-inventory.json').read_text())['files']
    records = [r for r in records if r['path'].startswith(PREFIX)]
    if not records:
        raise ValueError('Empty game inventory')
    sums = dict((line.split()[1], line.split()[0]) for line in (downloads / 'SHA256SUMS.txt').read_text().splitlines())
    for name in sorted({r['part'] for r in records}):
        archive = downloads / name
        if archive.parent != downloads or name not in sums:
            raise ValueError('Invalid archive name')
        with archive.open('rb') as f:
            if hashlib.file_digest(f, 'sha256').hexdigest() != sums[name]:
                raise ValueError('Archive checksum mismatch: ' + name)
        with zipfile.ZipFile(archive) as z:
            for record in (r for r in records if r['part'] == name):
                relative = record['path'][len(PREFIX):]
                target = (stage / relative).resolve()
                if not target.is_relative_to(stage.resolve()):
                    raise ValueError('Unsafe inventory path')
                target.parent.mkdir(parents=True, exist_ok=True)
                digest, count = hashlib.sha256(), 0
                with z.open(record['path']) as source, target.open('wb') as output:
                    while chunk := source.read(1024 * 1024):
                        count += len(chunk)
                        digest.update(chunk)
                        output.write(chunk)
                if count != record['bytes'] or digest.hexdigest() != record['sha256']:
                    raise ValueError('Game checksum mismatch: ' + relative)
        print('Extracted and verified ' + name, flush=True)
    if not (stage / 'index.html').is_file() or not list((stage / 'b').glob('*/game.wasm')):
        raise ValueError('Missing runtime')
    # Never replace a running installation in place.
    if (destination / 'game').exists():
        raise ValueError('Game already installed; staged copy left for review')
    stage.rename(destination / 'game')
    (destination / 'verified.json').write_text(json.dumps({
        'source': 'alihammoud21/playgta5', 'release': 'full-game-v1',
        'files': len(records), 'bytes': sum(r['bytes'] for r in records),
        'inventory_sha256': hashlib.sha256((downloads / 'file-inventory.json').read_bytes()).hexdigest(),
    }, indent=2) + '\n')
    print('Installed %d verified game files.' % len(records), flush=True)


if __name__ == '__main__':
    install(Path(sys.argv[1]).resolve())
