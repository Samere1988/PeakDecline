"""Build the pinned Ocarina of Time browser runtime without touching services."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
SOURCE = ROOT / '.tmp/oot-source'
BUILD = ROOT / '.tmp/oot-build'
SPEC = json.loads((PORT / 'sources.json').read_text())

def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True, **kwargs)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--jobs', type=int, default=8)
    args = parser.parse_args()
    if not SOURCE.exists():
        run('git', 'clone', '--no-checkout', SPEC['repository'], SOURCE)
        run('git', '-C', SOURCE, 'checkout', SPEC['commit'])
        run('git', '-C', SOURCE, 'submodule', 'update', '--init', '--recursive')
    revision = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != SPEC['commit']:
        raise SystemExit('Source revision does not match sources.json.')
    patch = PORT / 'browser.patch'
    applied = subprocess.run(['git', '-C', str(SOURCE), 'apply', '--reverse', '--check', str(patch)], capture_output=True)
    if applied.returncode:
        run('git', '-C', SOURCE, 'apply', '--check', patch)
        run('git', '-C', SOURCE, 'apply', patch)
    env = dict(os.environ)
    env['PATH'] = str(ROOT / '.venv/bin') + os.pathsep + env['PATH']
    emcmake = ROOT / '.tmp/emsdk/upstream/emscripten/emcmake'
    # Upstream rewrites these identical files on every configure. Preserve their
    # timestamps when unchanged so incremental builds do not rebuild the engine.
    dependencies = {path: (path.read_bytes(), path.stat().st_atime_ns, path.stat().st_mtime_ns)
                    for path in (BUILD / '_deps/stb').glob('*') if path.is_file()}
    run(emcmake, 'cmake', '-S', SOURCE, '-B', BUILD, '-G', 'Ninja',
        '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_CXX_FLAGS=-DFMT_CONSTEVAL=', env=env)
    for path, (content, atime, mtime) in dependencies.items():
        if path.exists() and path.read_bytes() == content:
            os.utime(path, ns=(atime, mtime))
    run('nice', '-n', '15', ROOT / '.venv/bin/cmake', '--build', BUILD, '--target', 'soh', '--parallel', max(1,args.jobs), env=env)
    if args.publish:
        target = ROOT / 'instance/oot/build'
        target.mkdir(parents=True, exist_ok=True)
        for name in ('soh.js', 'soh.wasm', 'soh.data'):
            shutil.copy2(BUILD / 'soh' / name, target / name)
        shutil.copy2(SOURCE / 'soh/soh/web/soh.o2r', target / 'soh.o2r')
        shutil.copy2(PORT / 'sources.json', target / 'sources.json')

if __name__ == '__main__':
    main()
