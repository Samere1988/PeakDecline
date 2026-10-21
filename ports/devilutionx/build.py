"""Build the pinned DevilutionX room runtime. Requires the existing Emscripten SDK."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
SOURCE = ROOT / '.tmp/devilutionx-source'
WORK = ROOT / '.tmp/devilutionx'
SPEC = json.loads((PORT / 'sources.json').read_text())

def run(*args):
    subprocess.run([str(x) for x in args], cwd=ROOT, check=True)

def patch(path, old, new):
    value = path.read_text()
    if value.count(old) != 1:
        raise RuntimeError(f'Unexpected source marker: {path}: {old[:80]}')
    path.write_text(value.replace(old, new))

def prepare():
    if not SOURCE.exists():
        run('git', 'init', SOURCE)
        run('git', '-C', SOURCE, 'remote', 'add', 'origin', SPEC['repository'])
        run('git', '-C', SOURCE, 'fetch', '--depth', '1', 'origin', SPEC['commit'])
        run('git', '-C', SOURCE, 'checkout', '--detach', 'FETCH_HEAD')
    revision = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != SPEC['commit']:
        raise SystemExit('DevilutionX source revision differs from sources.json.')
    source = WORK / 'source'
    shutil.copytree(SOURCE, source, dirs_exist_ok=True, ignore=shutil.ignore_patterns('.git', 'build*'))
    for name in ('peak_net.h', 'peak_net.cpp'):
        shutil.copyfile(PORT / 'runtime' / name, source / 'Source/dvlnet' / name)
    patch(source / 'Source/CMakeLists.txt', '  dvlnet/base.cpp', '  dvlnet/peak_net.cpp\n  dvlnet/base.cpp')
    patch(source / 'Source/dvlnet/abstract_net.cpp', '#include "dvlnet/loopback.h"', '#include "dvlnet/loopback.h"\n#include "dvlnet/peak_net.h"')
    patch(source / 'Source/dvlnet/abstract_net.cpp', '\tswitch (provider) {', '''\tswitch (provider) {
#ifdef __EMSCRIPTEN__
 case SELCONN_TCP:
  return std::make_unique<cdwrap>([]() { return std::make_unique<peak_net>(); });
#endif''')
    patch(source / 'Source/DiabloUI/multi/selconn.cpp', 'bool UiSelectProvider(GameData *gameData)\n{', '''bool UiSelectProvider(GameData *gameData)
{
#ifdef __EMSCRIPTEN__
 provider = SELCONN_TCP;
 return SNetInitializeProvider(provider, gameData);
#endif''')
    game = source / 'Source/DiabloUI/multi/selgame.cpp'
    patch(game, '#include <cstddef>', '#include <emscripten.h>\n#include <cstddef>')
    patch(game, 'bool UiSelectGame(GameData *gameData, int *playerId)\n{', '''bool UiSelectGame(GameData *gameData, int *playerId)
{
#ifdef __EMSCRIPTEN__
 DvlNet_ClearPassword();
 if (EM_ASM_INT({ return Module['peakBridge'].slot; }) != 0)
  return SNetJoinGame("Peak Decline", nullptr, playerId);
 gameData->nDifficulty = static_cast<_difficulty>(EM_ASM_INT({ return Module['peakBridge'].difficulty || 0; }));
 gameData->nTickRate = 20;
 gameData->bRunInTown = 0;
 GameData info = *gameData;
 SwapGameDataLE(info);
 return SNetCreateGame(nullptr, nullptr, reinterpret_cast<char *>(&info), sizeof(info), playerId);
#endif''')
    patch(source / 'Source/DiabloUI/mainmenu.cpp', '\tvecMenuItems.push_back(std::make_unique<UiListItem>(_("Single Player"), MAINMENU_SINGLE_PLAYER));', '')
    patch(source / 'Source/DiabloUI/mainmenu.cpp', '_("Multi Player")', '_("Start Game")')
    # The single-threaded browser pumps turns from the main loop. Upstream's
    # Emscripten SdlThread runs handlers inline, so its network thread would hang.
    patch(source / 'Source/nthread.cpp', '\t\tThread = SdlThread { NthreadHandler };', '#ifndef __EMSCRIPTEN__\n\t\tThread = SdlThread { NthreadHandler };\n#endif')
    patch(source / 'Source/diablo.cpp', '#include "diablo.h"', '#include "diablo.h"\nextern "C" void peakDiabloTick();')
    patch(source / 'Source/diablo.cpp', 'void GameLogic()\n{', 'void GameLogic()\n{\n peakDiabloTick();')
    # Our page owns preload, persistent saves and error reporting.
    (source / 'Packaging/emscripten/emscripten_pre.js').write_text('')
    patch(source / 'CMakeLists.txt', '    -sASYNCIFY', '''    -sASYNCIFY
    -sASYNCIFY_STACK_SIZE=131072
    "-sEXPORTED_RUNTIME_METHODS=['FS','IDBFS','callMain','addRunDependency','removeRunDependency']"
    "-sINCOMING_MODULE_JS_API=['arguments','canvas','locateFile','preRun','postRun','onRuntimeInitialized','onAbort','print','printErr','noInitialRun','setStatus']"''')
    return source

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    source = prepare()
    binary = Path(sys.executable).parent
    cmake = shutil.which('cmake') or str(binary / 'cmake')
    ninja = shutil.which('ninja') or str(binary / 'ninja')
    sdk = Path(os.environ.get('EMSDK', ROOT / '.tmp/emsdk')) / 'upstream/emscripten'
    build = WORK / 'room-build'
    run(cmake, '-S', source, '-B', build, '-G', 'Ninja', '-DCMAKE_MAKE_PROGRAM=' + ninja,
        '-DCMAKE_TOOLCHAIN_FILE=' + str(sdk / 'cmake/Modules/Platform/Emscripten.cmake'),
        '-DCMAKE_BUILD_TYPE=Release', '-DPACKET_ENCRYPTION=OFF')
    run(cmake, '--build', build, '-j', str(min(8, os.cpu_count() or 2)))
    if args.publish:
        destination = ROOT / 'instance/devilutionx/build'
        destination.mkdir(parents=True, exist_ok=True)
        for name in ('devilutionx.js', 'devilutionx.wasm', 'devilutionx.data'):
            shutil.copyfile(build / name, destination / name)
        shutil.copyfile(source / 'LICENSE.md', destination / 'LICENSE.md')
        shutil.copyfile(PORT / 'sources.json', destination / 'sources.json')
        print('Published DevilutionX runtime:', destination)

if __name__ == '__main__':
    main()
