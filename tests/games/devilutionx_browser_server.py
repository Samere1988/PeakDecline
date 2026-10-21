"""Local browser fixture with production's gevent transport; no production DBs."""
from retro_test import make_app, ROOT

if __name__ == '__main__':
    app, sio = make_app(ROOT / 'instance', async_mode='gevent')
    import os
    if os.environ.get('DIABLO_TEST_BUILD'):
        from dataclasses import replace
        from retro_package.catalog import GAMES
        GAMES['devilutionx'] = replace(GAMES['devilutionx'], build_dir=os.environ['DIABLO_TEST_BUILD'])
    import tempfile
    storage = tempfile.TemporaryDirectory()
    app.config['RETRO_SAVE_DATABASE'] = storage.name + '/saves.sqlite3'
    sio.run(app, host='127.0.0.1', port=8075, debug=False)
