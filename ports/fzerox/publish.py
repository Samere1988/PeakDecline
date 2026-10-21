"""Recreate Emscripten artifacts with the destination directory's Windows ACL."""
import os
from pathlib import Path
import uuid


def publish(directory):
    for artifact in Path(directory).iterdir():
        if artifact.is_file() and artifact.suffix in ('.js', '.wasm', '.data'):
            temporary = artifact.with_name(artifact.name + '.' + uuid.uuid4().hex + '.publish')
            try:
                with temporary.open('xb') as stream:
                    stream.write(artifact.read_bytes())
                os.replace(temporary, artifact)
            finally:
                temporary.unlink(missing_ok=True)


def deploy(source, destination):
    source, destination = Path(source), Path(destination)
    payloads = {name: (source / name).read_bytes() for name in ('fzerox.js', 'fzerox.wasm', 'fzerox.data')}
    if not payloads['fzerox.wasm'].startswith(b'\0asm'):
        raise SystemExit('The F-Zero WebAssembly build is invalid.')
    upstream = Path(__file__).resolve().parents[2] / '.tmp/fzerox/G-Diffuser'
    notices = [upstream / 'LICENSE', upstream / 'THIRD_PARTY_NOTICES.md'] + sorted((upstream / 'LICENSES').glob('*'))
    payloads['licenses.txt'] = '\n\n'.join(
        f'===== {path.name} =====\n{path.read_text(encoding="utf-8")}'
        for path in notices if path.is_file()).encode('utf-8')
    destination.mkdir(parents=True, exist_ok=True)
    for name, content in payloads.items():
        target = destination / name
        temporary = target.with_name(name + '.' + uuid.uuid4().hex + '.publish')
        try:
            temporary.write_bytes(content)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    print(f'Published F-Zero runtime and license notices to {destination}')


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 3:
        deploy(sys.argv[1], sys.argv[2])
    else:
        publish(sys.argv[1])
