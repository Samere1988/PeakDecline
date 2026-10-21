"""Build the independent browser netplay core without touching the MK64 build."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'instance/netplay/build')
    args = parser.parse_args()
    vendor = PORT / 'vendor/recomp-net'
    manifest = json.loads((PORT / 'sources.json').read_text())
    for name, expected in manifest['sha256'].items():
        if hashlib.sha256((vendor / name).read_bytes()).hexdigest() != expected:
            raise SystemExit(f'Upstream integrity check failed: {name}')
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    emcc = ROOT / '.tmp/mk64/emsdk/upstream/emscripten/emcc.py'
    command = [sys.executable, str(emcc), str(PORT / 'src/browser_core.c'),
               str(vendor / 'src/input/rnet_rings.c'), '-I' + str(vendor / 'include'),
               '-I' + str(vendor / 'src'), '-O2', '-sMODULARIZE=1',
               '-sEXPORT_NAME=createPeakNetCore', '-sENVIRONMENT=web,node',
               '-sFILESYSTEM=0', '-sINITIAL_MEMORY=16777216',
               '-o', str(out / 'netplay.js')]
    subprocess.run(command, check=True)
    if os.name == 'nt':
        # Emscripten moves outputs from its private temporary directory, keeping
        # that directory's ACL. Publish fresh files with the destination ACL so
        # the website's account can read them (as in the MK64 build).
        for name in ('netplay.js', 'netplay.wasm'):
            artifact = out / name
            published = out / (name + '.' + uuid.uuid4().hex + '.publish')
            try:
                with published.open('xb') as stream:
                    stream.write(artifact.read_bytes())
                os.replace(published, artifact)
            finally:
                published.unlink(missing_ok=True)
    print(f'Built {out}')


if __name__ == '__main__':
    main()
