"""Isolated CMR2 candidate fixture; no production accounts, saves or restart."""
from dataclasses import replace
from pathlib import Path
import tempfile
from retro_test import make_app, ROOT, GAMES

if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as directory:
        instance=Path(directory)
        game=instance/'cmr2'
        game.mkdir()
        (game/'build').symlink_to(ROOT/'.tmp/opencmr2/browser-build/game',target_is_directory=True)
        (game/'data').symlink_to(ROOT/'.tmp/opencmr2/data',target_is_directory=True)
        GAMES['cmr2']=replace(GAMES['cmr2'],files=tuple(name for name in GAMES['cmr2'].files if name!='verified.json'))
        app,sio=make_app(instance,async_mode='gevent')
        app.config['RETRO_SAVE_DATABASE']=str(instance/'saves.sqlite3')
        sio.run(app,host='127.0.0.1',port=8088,debug=False)
