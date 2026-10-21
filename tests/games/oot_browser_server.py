"""Isolated loopback-only browser fixture; never opens production databases."""
from retro_test import make_app, ROOT
if __name__ == '__main__':
    app, sio = make_app(ROOT / 'instance', async_mode='gevent')
    import tempfile
    storage = tempfile.TemporaryDirectory()
    app.config['RETRO_SAVE_DATABASE'] = storage.name + '/saves.sqlite3'
    sio.run(app, host='127.0.0.1', port=8076, debug=False)
