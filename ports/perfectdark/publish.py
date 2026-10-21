"""Install an already-built, pinned Perfect Dark runtime without recompiling."""
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
BUILD = ROOT / '.tmp/perfectdark/build'


def publish():
    expected = json.loads((PORT / 'sources.json').read_text())
    if json.loads((BUILD / 'source.json').read_text()) != expected:
        raise SystemExit('Build provenance does not match the pinned Perfect Dark source.')
    if (BUILD / 'pd.wasm').read_bytes()[:4] != b'\x00asm':
        raise SystemExit('Perfect Dark WASM artifact is invalid.')
    dest = ROOT / 'instance/perfectdark/build'
    dest.mkdir(parents=True, exist_ok=True)
    for name in ('pd.js', 'pd.wasm', 'LICENSE.txt', 'source.json'):
        shutil.copyfile(BUILD / name, dest / name)
    print('Installed Perfect Dark native browser runtime. Restart the service to activate server changes.')


if __name__ == '__main__':
    publish()
