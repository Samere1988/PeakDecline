"""Account-save integration fixture. Loopback only, isolated server save database."""
from retro_test import make_app, ROOT
from flask import render_template, send_from_directory
import tempfile

if __name__ == '__main__':
    storage = tempfile.TemporaryDirectory()
    app, sio = make_app(ROOT / 'instance', async_mode='gevent')
    app.config['RETRO_SAVE_DATABASE'] = storage.name + '/saves.sqlite3'
    app.add_url_rule('/test-mk64/<name>', 'test_mk64_build', lambda name: send_from_directory(ROOT / '.tmp/mk64-save-build', name))
    app.add_url_rule('/test-derby', 'test_derby', lambda: render_template('horse_race.html'))
    app.add_url_rule('/test-emulator', 'test_emulator', lambda: render_template('emulator.html', library={'snes':[], 'n64':[], 'psx':[]}))
    sio.run(app, host='127.0.0.1', port=8078, debug=False)
