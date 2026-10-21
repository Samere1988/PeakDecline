"""Copy a locally verified Smash build into the website's private runtime folder.

Run build.py, extract_assets.mjs and the browser tests first. This does not fetch
game assets, restart the website, or enable a catalog entry by itself.
"""
import hashlib
from pathlib import Path
import runpy
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / '.tmp/battleship-web/build-wasm'
DESTINATION = ROOT / 'instance/smash64/build'


def main():
    runpy.run_path(str(ROOT / 'ports/smash64/stage_fixture.py'))
    game = runpy.run_path(str(ROOT / 'app/netplay/catalog.py'))['SMASH64']
    for name in game.files:
        if not (SOURCE / name).is_file() or (SOURCE / name).stat().st_size == 0:
            raise RuntimeError('Missing Smash artifact: ' + name)
    # Each replacement is atomic; a new game stays unavailable until all its
    # allowlisted files exist. Do not run while existing Smash rooms are active.
    for name in game.files:
        target = DESTINATION / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, suffix='.pending', delete=False) as stream:
            temporary = Path(stream.name)
            with (SOURCE / name).open('rb') as source:
                shutil.copyfileobj(source, stream)
        try:
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    for name in ('BattleShip.js', 'BattleShip.wasm'):
        with (DESTINATION / name).open('rb') as stream:
            print(name, hashlib.file_digest(stream, 'sha256').hexdigest())
    print('Published', len(game.files), 'Smash artifacts to', DESTINATION)


if __name__ == '__main__':
    main()
