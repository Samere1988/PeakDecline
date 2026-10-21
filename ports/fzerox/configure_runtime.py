"""Configure the browser graphics runtime in an isolated generated source tree."""
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.tmp/fzerox'
source = WORK / 'G-Diffuser/libultraship'
dest = WORK / 'browser-source/libultraship'
shutil.copytree(source, dest, dirs_exist_ok=True, ignore=shutil.ignore_patterns('.git'))
cmake_file = dest / 'src/CMakeLists.txt'
text = cmake_file.read_text()
for package in ('libzip', 'nlohmann_json', 'tinyxml2', 'spdlog'):
    text = text.replace(f'find_package({package} REQUIRED)', f'# {package} supplied by browser parent')
text = text.replace('target_link_libraries(libultraship PRIVATE GLESv2)',
                    'target_link_options(libultraship PUBLIC -sFULL_ES3=1 -sUSE_WEBGL2=1)')
cmake_file.write_text(text)
gl = dest / 'src/fast/backends/gfx_opengl.cpp'
text = gl.read_text(encoding='utf-8')
text = text.replace('glewInit();', '/* WebGL entry points are supplied by Emscripten. */')
text = text.replace('return GL_CLAMP_TO_BORDER;', 'return GL_CLAMP_TO_EDGE; /* WebGL has no border clamp. */')
gl.write_text(text, encoding='utf-8')
sdl = dest / 'src/fast/backends/gfx_sdl2.cpp'
text = sdl.read_text(encoding='utf-8')
marker = '#if defined(__APPLE__)\n    SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS'
if text.count(marker) != 1:
    raise SystemExit('SDL context initialization changed upstream')
text = text.replace(marker, '#ifdef __EMSCRIPTEN__\n'
    '    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);\n'
    '    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);\n'
    '    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);\n'
    '#elif defined(__APPLE__)\n    SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS', 1)
sdl.write_text(text, encoding='utf-8')
resources = dest / 'src/ship/resource/ResourceManager.cpp'
text = resources.read_text(encoding='utf-8')
text = text.replace('size_t threadCount = std::max(1, (int32_t)(std::thread::hardware_concurrency() - reservedThreadCount - 1));',
                    'size_t threadCount = 1; // Browser has a bounded pre-created worker pool.')
resources.write_text(text, encoding='utf-8')
env = os.environ.copy()
env['PATH'] = str(WORK / 'tools/ninja/data/bin') + os.pathsep + env['PATH']
cmake = WORK / 'tools/cmake/data/bin/cmake.exe'
ninja = next((WORK / 'tools').rglob('ninja.exe'))
sdk = ROOT / '.tmp/mk64/emsdk/upstream/emscripten'
subprocess.run([str(cmake), '-S', str(ROOT / 'ports/fzerox/runtime'),
               '-B', str(WORK / 'runtime-build'), '-G', 'Ninja',
               '-DCMAKE_MAKE_PROGRAM=' + ninja.as_posix(),
               '-DCMAKE_TOOLCHAIN_FILE=' + (sdk / 'cmake/Modules/Platform/Emscripten.cmake').as_posix(),
               '-DBROWSER_LUS=' + dest.as_posix(), '-DCMAKE_BUILD_TYPE=Release',
               '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'], check=True, env=env)
