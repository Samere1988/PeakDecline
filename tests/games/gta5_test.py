"""Isolated transport/security checks; no production app or databases."""
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from flask import Blueprint, Flask
from flask_login import LoginManager, UserMixin, login_user

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gta5_fixture', ROOT / 'app/gta5.py')
gta5 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gta5)


def make_app(instance):
    app = Flask(__name__, instance_path=str(instance), template_folder=str(ROOT / 'templates'),
                static_folder=str(ROOT / 'static'))
    app.config.update(TESTING=True, SECRET_KEY='isolated-gta5-tests')
    login = LoginManager(app)
    class User(UserMixin):
        def __init__(self, id):
            self.id = id
            self.username = 'Test player'
            self.avatar_url = '/static/img/avatar-default.svg'
    login.user_loader(User)
    bp = Blueprint('main', __name__)
    for name in ('index', 'games', 'retro_games', 'peakdecline_derby', 'catan_room'):
        bp.add_url_rule('/fixture/' + name, name, lambda: 'Fixture')
    gta5.register_routes(bp)
    app.register_blueprint(bp)
    auth = Blueprint('auth', __name__)
    for name in ('profile', 'login', 'logout'):
        auth.add_url_rule('/fixture/' + name, name, lambda: 'Account')
    app.register_blueprint(auth)
    @app.route('/test-login/<user>')
    def fixture_login(user):
        login_user(User(user))
        return 'OK'
    return app


class HostingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.instance = Path(self.tmp.name)
        self.root = self.instance / 'gta5/game'
        (self.root / 'b/test').mkdir(parents=True)
        (self.root / 'data').mkdir()
        (self.root.parent / 'verified.json').write_text('{}')
        (self.root / 'index.html').write_text('<body><script src="/b/test/loader.js"></script><img src="/b/test/title/logo.png">')
        (self.root / 'b/test/loader.js').write_text("fetch('/data/manifest.json'); indexedDB.open('gta5-userdata',1)")
        (self.root / 'b/test/game.wasm').write_bytes(b'\0asm123456')
        (self.root / 'data/test.bin').write_bytes(b'0123456789')
        self.app = make_app(self.instance)
        self.client = self.app.test_client()
        self.client.get('/test-login/one')

    def test_all_assets_require_login(self):
        guest = self.app.test_client()
        for path in ('', '/play', '/b/test/game.wasm', '/data/test.bin'):
            self.assertEqual(guest.get('/games/gta5' + path).status_code, 401)
        self.assertEqual(guest.post('/games/gta5/data/batch', json=[]).status_code, 401)

    def test_isolation_paths_and_account_storage(self):
        page = self.client.get('/games/gta5/play')
        self.assertIn(b'/games/gta5/b/test/loader.js', page.data)
        self.assertIn(b'/games/gta5/b/test/title/logo.png', page.data)
        self.assertEqual(page.headers['Cross-Origin-Embedder-Policy'], 'require-corp')
        first = self.client.get('/games/gta5/b/test/loader.js').data
        self.assertIn(b'/games/gta5/data/', first)
        self.client.get('/test-login/two')
        self.assertNotEqual(first, self.client.get('/games/gta5/b/test/loader.js').data)

    def test_ranges_and_wasm_mime(self):
        response = self.client.get('/games/gta5/b/test/game.wasm', headers={'Range': 'bytes=0-3'})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, b'\0asm')
        self.assertEqual(response.mimetype, 'application/wasm')
        self.assertEqual(response.headers['Content-Range'], 'bytes 0-3/10')
        self.assertEqual(self.client.get('/games/gta5/data/test.bin', headers={'Range': 'bytes=20-30'}).status_code, 416)

    def test_batch_both_formats_and_eof(self):
        runs = [['test.bin', 2, 5], ['test.bin', 8, 99], ['test.bin', 20, 30]]
        for suffix in ('', '?gz=1'):
            response = self.client.post('/games/gta5/data/batch' + suffix, data=json.dumps(runs))
            self.assertEqual(response.status_code, 200)
            data = gzip.decompress(response.data) if suffix else response.data
            self.assertEqual(data, b'234589')
            self.assertEqual(response.headers['X-Run-Lengths'], '4,2,0')

    def test_invalid_batches_and_traversal(self):
        for runs in ({}, [], [['test.bin', -1, 3]], [['test.bin', True, 3]], [['test.bin', 2]], [['test.bin', 4, 2]]):
            self.assertEqual(self.client.post('/games/gta5/data/batch', json=runs).status_code, 400)
        (self.root / 'data/leak').symlink_to(self.root.parent / 'verified.json')
        for name in ('../../verified.json', 'leak'):
            self.assertEqual(self.client.get('/games/gta5/data/' + name).status_code, 404)
            self.assertEqual(self.client.post('/games/gta5/data/batch', json=[[name, 0, 2]]).status_code, 404)
        self.assertEqual(self.client.post('/games/gta5/data/batch', data=b' ' * (1024 * 1024 + 1)).status_code, 413)
        with (self.root / 'data/big').open('wb') as f:
            f.truncate(65 * 1024 * 1024)
        self.assertEqual(self.client.post('/games/gta5/data/batch', json=[['big', 0, 65 * 1024 * 1024]]).status_code, 413)

    def test_incomplete_install_is_unavailable(self):
        (self.root.parent / 'verified.json').unlink()
        self.assertEqual(self.client.get('/games/gta5/play').status_code, 503)
        self.assertEqual(self.client.get('/games/gta5/data/test.bin').status_code, 503)


if __name__ == '__main__':
    unittest.main()
