"""Loopback candidate-build fixture; never opens production databases or saves."""
import json
import tempfile
from pathlib import Path
from retro_test import make_app, ROOT

if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as directory:
        instance = Path(directory)
        game = instance / 'driver2'
        (game / 'data').mkdir(parents=True)
        (game / 'build').symlink_to(ROOT / '.tmp/redriver2/peak-build', target_is_directory=True)
        (game / 'data/fmv').symlink_to(ROOT / '.tmp/redriver2/peak-build/fmv', target_is_directory=True)
        (game / 'data/streamed-assets-v1.json').write_text(json.dumps({'installed': True}))
        app, sio = make_app(instance, async_mode='gevent')
        app.config['RETRO_SAVE_DATABASE'] = str(instance / 'saves.sqlite3')
        sio.run(app, host='127.0.0.1', port=8076, debug=False)
