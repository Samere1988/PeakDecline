"""Build the pinned OpenCMR2 browser candidate. Does not restart the service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
WORK = ROOT / '.tmp/opencmr2'
SPEC = json.loads((PORT / 'sources.json').read_text())


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def checkout(name, spec):
    path = WORK / name
    if not path.exists():
        run(['git', 'clone', spec['repository'], path])
        run(['git', '-C', path, 'checkout', '--detach', spec['commit']])
    actual = subprocess.check_output(['git', '-C', path, 'rev-parse', 'HEAD'], text=True).strip()
    if actual != spec['commit']:
        raise SystemExit('Unexpected source revision: ' + str(path))
    return path


def tool(name, fallback):
    found = os.environ.get('CMR2_' + name.upper()) or shutil.which(name)
    path = Path(found) if found else fallback
    if not path or not path.is_file():
        raise SystemExit('Missing ' + name + '. Set CMR2_' + name.upper() + ' to its executable.')
    return path.resolve()


def shaders(source, generated):
    glslang = tool('glslangValidator', WORK / 'tools/root/usr/bin/glslangValidator')
    tint = tool('tint', next((WORK / 'tools/dawn').glob('*/bin/tint'), None))
    directory = source / 'src/render/shaders'
    stage = WORK / 'shaders'
    stage.mkdir(exist_ok=True)
    generated.mkdir(parents=True, exist_ok=True)
    header = '#pragma once\n'
    for path in sorted(directory.iterdir()):
        if path.suffix not in ('.vert', '.frag'):
            continue
        # SDL WebGPU has separate texture/sampler bindings, paired at 2N/2N+1.
        text = re.sub(r'(set = 2, binding = )(\d+)', lambda match: match[1] + str(int(match[2])*2), path.read_text())
        output = stage / path.name
        output.write_text(text)
        spirv = Path(str(output) + '.spv')
        wgsl = Path(str(output) + '.wgsl')
        run([glslang, '-V', '--target-env', 'vulkan1.0', '-I'+str(directory), '-o', spirv, output])
        run([tint, '--format', 'wgsl', '--allow-non-uniform-derivatives', 'true',
             '--sampler-mapping', '2,0:2,1 2,2:2,3 2,4:2,5 2,6:2,7', '-o', wgsl, spirv])
        name = path.name.replace('.', '_')
        header += 'static const unsigned char g_' + name + '[] = {' + ','.join(str(byte) for byte in wgsl.read_bytes()) + '};\n'
    (generated / 'shaders_spirv.h').write_text(header)


def assets(data, output):
    files = []
    required = ('Game/Bigfiles/common.bfl', 'FrontEnd/common.bfl', 'Sounds/surface.bfl')
    if not all((data / name).is_file() for name in required):
        raise SystemExit('An extracted PC installation is required.')
    for directory in ('Game', 'FrontEnd', 'Sounds', 'CountrySpecific', 'SetupRep'):
        for path in sorted((data / directory).rglob('*')):
            if path.is_file():
                files.append(dict(path=path.relative_to(data).as_posix(), size=path.stat().st_size,
                                  sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    (output / 'assets.json').write_text(json.dumps(dict(version=1, files=files), separators=(',', ':')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=WORK / 'data')
    parser.add_argument('--output-dir', type=Path, default=WORK / 'browser-build')
    parser.add_argument('--emsdk', type=Path, default=ROOT / '.tmp/emsdk')
    args = parser.parse_args()
    source = checkout('upstream', SPEC)
    sdl = checkout('sdl-webgpu', SPEC['sdl'])
    for checkout_path, name in ((source, 'browser.patch'), (sdl, 'sdl-browser.patch')):
        patch = PORT / name
        if subprocess.run(['git', '-C', str(checkout_path), 'apply', '--reverse', '--check', str(patch)], capture_output=True).returncode:
            run(['git', '-C', checkout_path, 'apply', '--check', patch])
            run(['git', '-C', checkout_path, 'apply', patch])
    generated = WORK / 'generated'
    shaders(source, generated)
    output = args.output_dir.resolve()
    cmake = ROOT / '.venv/bin/cmake'
    run([cmake, '-S', PORT, '-B', output, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
         '-DCMAKE_MAKE_PROGRAM='+str(ROOT / '.venv/bin/ninja'),
         '-DCMAKE_TOOLCHAIN_FILE='+str(args.emsdk.resolve() / 'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake'),
         '-DPEAK_EMDAWN_PORT='+str(WORK / 'tools/emdawnwebgpu.remoteport.py'), '-DPEAK_CMR_SOURCE='+str(source), '-DPEAK_SDL_SOURCE='+str(sdl), '-DPEAK_CMR_GENERATED='+str(generated)])
    run([cmake, '--build', output, '-j8'])
    assets(args.data.resolve(), output / 'game')
    shutil.copyfile(PORT / 'sources.json', output / 'game/sources.json')
    shutil.copyfile(source / 'LICENSE', output / 'game/LICENSE')
    print('Candidate ready:', output / 'game')


if __name__ == '__main__':
    main()
