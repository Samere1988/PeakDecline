"""Stage loader metadata beside the isolated Smash build for browser testing."""
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / '.tmp/battleship-web/build-wasm'
recipe = re.search(r'SSB64_ASSET_RECIPE_HASH=\\"([a-f0-9]+)', (BUILD / 'build.ninja').read_text())
if not recipe:
    raise RuntimeError('Missing asset recipe hash; build Smash first.')
(BUILD / 'BattleShip.o2r.recipe').write_text(recipe[1], encoding='ascii')
shutil.copyfile(ROOT / 'ports/smash64/rollback_adapter.js', BUILD / 'rollback_adapter.js')
source = BUILD.parent
credits = ['Super Smash Bros. browser integration for Peak Decline\n'
           'Browser port: https://github.com/turtlesoupy/BattleShip\n'
           'Rollback source: https://github.com/robin994/ssb-decomp-re-vita\n'
           'See ports/smash64/sources.json for pinned revisions.\n',
           (ROOT / 'ports/smash64/vendor/vita/NOTICE.txt').read_text(encoding='utf-8')]
for name in ('LICENSE', 'libultraship/LICENSE', 'libultraship/src/fast/LICENSE.txt',
             'third_party/meshoptimizer/LICENSE.md', 'assets/custom/fonts/Inconsolata-OFL.txt',
             'assets/custom/fonts/Montserrat-OFL.txt', 'build-wasm/_deps/threadpool-src/LICENSE.txt',
             'build-wasm/_deps/tinyxml2-src/LICENSE.txt', 'build-wasm/_deps/prism-src/LICENSE',
             'build-wasm/_deps/libzip-src/LICENSE', 'build-wasm/_deps/imgui-src/LICENSE.txt',
             'build-wasm/_deps/spdlog-src/LICENSE', 'build-wasm/_deps/sdl2-src/LICENSE.txt',
             'build-wasm/_deps/nlohmann_json-src/LICENSE.MIT'):
    credits.append('\n--- ' + name + ' ---\n' + (source / name).read_text(encoding='utf-8'))
(BUILD / 'credits.txt').write_text('\n'.join(credits), encoding='utf-8')
