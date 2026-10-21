"""Isolated Retro Games fixture: never opens production databases."""
import importlib.util
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from flask import Blueprint, Flask, redirect, session
from flask_login import LoginManager, UserMixin
from flask_socketio import SocketIO

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('retro_package', ROOT / 'app/netplay/__init__.py',
                                            submodule_search_locations=[str(ROOT / 'app/netplay')])
netplay = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = netplay
spec.loader.exec_module(netplay)
from retro_package.catalog import Game, GAMES


def make_app(instance, async_mode='threading'):
    app = Flask(__name__, template_folder=str(ROOT / 'templates'), static_folder=str(ROOT / 'static'), instance_path=str(instance))
    app.config.update(TESTING=True, TEMPLATES_AUTO_RELOAD=True, SECRET_KEY='retro-fixture-only')
    # The serving fixture uses installed assets from the real instance folder,
    # but disposable account saves must never share the production database.
    save_dir = tempfile.TemporaryDirectory(prefix='retro-fixture-saves-')
    app.extensions['retro_fixture_saves'] = save_dir
    app.config['RETRO_SAVE_DATABASE'] = str(Path(save_dir.name) / 'saves.sqlite3')
    login = LoginManager(app)
    class User(UserMixin):
        avatar_url = '/static/img/avatar-default.svg'
        def __init__(self, id):
            self.id = id
            self.username = 'Player ' + id
    login.user_loader(User)
    bp = Blueprint('main', __name__)
    bp.add_url_rule('/', 'index', lambda: 'Home')
    bp.add_url_rule('/games', 'games', lambda: 'Games')
    netplay.register_routes(bp)
    gta_spec = importlib.util.spec_from_file_location('retro_fixture_gta5', ROOT / 'app/gta5.py')
    gta = importlib.util.module_from_spec(gta_spec)
    gta_spec.loader.exec_module(gta)
    gta.register_routes(bp)
    app.register_blueprint(bp)
    auth = Blueprint('auth', __name__)
    for name in ('profile', 'login', 'logout'):
        auth.add_url_rule('/' + name, name, lambda: 'Account')
    app.register_blueprint(auth)
    @app.get('/test-login/<user>')
    def fixture_login(user):
        session['_user_id'] = user
        session['_fresh'] = True
        return redirect('/games/retro')
    sio = SocketIO(app, async_mode=async_mode)
    netplay.register(app, sio)
    return app, sio


class FakeKartWorker:
    """Room lifecycle fixture; native process coverage lives in authority_room_test."""
    def __init__(self, app, socketio, game, players, epoch, initial, callback):
        self.callback, self.epoch = callback, epoch
    def launch(self):
        self.callback(dict(type='baseline', epoch=self.epoch, sequence=0, frame=1), b'fixture')
        self.callback(dict(type='state', epoch=self.epoch, sequence=1, frame=1), b'fixture')
    def send(self, message): return True
    def close(self): pass


class RetroTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        worker = patch('retro_package.rooms.KartWorker', FakeKartWorker)
        worker.start(); self.addCleanup(worker.stop)
        self.app, self.sio = make_app(Path(self.tmp.name))
        self.descriptor = dict(id='mk64', title='Mario Kart 64', maxPlayers=4, tickRate=30,
            inputSchema='n64-pad-v1', backend='recomp-ring-lockstep-v1', adapter='mk64',
            protocol=1, build='test-build', available=True)
        mock = patch.object(Game, 'descriptor', lambda game, app: dict(self.descriptor, id=game.id, title=game.title))
        mock.start()
        self.addCleanup(mock.stop)
        self.clients = []
        self.addCleanup(self.close_clients)

    def close_clients(self):
        for client in self.clients:
            if client.is_connected('/retro'):
                client.disconnect(namespace='/retro')

    def connect(self, id='one', origin=None):
        http = self.app.test_client()
        if id:
            http.get('/test-login/' + id)
        client = self.sio.test_client(self.app, namespace='/retro', flask_test_client=http,
                                     headers={'Origin': origin} if origin else {})
        self.clients.append(client)
        return client

    def emit(self, client, event, data=None):
        client.emit(event, data, namespace='/retro')

    def events(self, client, name):
        return [e['args'][0] for e in client.get_received('/retro') if e['name'] == name]

    def room(self, count=2):
        clients = [self.connect(str(i)) for i in range(count)]
        self.emit(clients[0], 'create', dict(name='Test', gameId='mk64', compatibility=self.descriptor))
        code = self.events(clients[0], 'room')[0]['code']
        for client in clients[1:]:
            self.emit(client, 'join', dict(code=code, compatibility=self.descriptor))
        for client in clients:
            self.emit(client, 'role', {'role': 'player'})
            self.emit(client, 'ready', {'ready': True})
        return clients, code

    def start(self, clients):
        self.emit(clients[0], 'start_game')
        self.assertEqual(len(self.events(clients[0], 'prepare')), 1)
        for client in clients:
            self.emit(client, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        events = self.events(clients[0], 'start')
        deadline = time.monotonic()+2
        while not events and time.monotonic()<deadline:
            time.sleep(.01); events = self.events(clients[0], 'start')
        self.assertEqual(len(events), 1)

    def test_solo_with_optional_spectator(self):
        clients, code = self.room(count=1)
        watcher = self.connect('solo-watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.start(clients + [watcher])
        pad = dict(buttons=0x8000, x=25, y=0)
        self.emit(clients[0], 'input', dict(epoch=0, frame=1, pad=pad))
        self.assertEqual(self.events(clients[0], 'frameset')[0]['pads'], [pad])
        self.assertEqual(self.events(watcher, 'frameset')[0]['pads'], [pad])
        self.emit(watcher, 'leave')
        self.emit(clients[0], 'input', dict(epoch=0, frame=2, pad=pad))
        self.assertEqual(self.events(clients[0], 'frameset')[0]['frame'], 2)

    def test_nested_runtime_assets_remain_allowlisted(self):
        from dataclasses import replace
        nested = 'assets/custom/fonts/test.ttf'
        build = Path(self.app.instance_path) / GAMES['mk64'].build_dir
        (build / nested).parent.mkdir(parents=True)
        (build / nested).write_bytes(b'font fixture')
        (build / 'private.txt').write_text('not a game asset')
        client = self.app.test_client()
        client.get('/test-login/asset-test')
        with patch.dict(GAMES, mk64=replace(GAMES['mk64'], files=(nested,))):
            response = client.get('/games/retro/build/mk64/' + nested)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, b'font fixture')
            response.close()
            for name in ('private.txt', 'assets/../../private.txt', '../private.txt'):
                self.assertEqual(client.get('/games/retro/build/mk64/' + name).status_code, 404)

    def test_checkpoint_worker_requires_login_and_isolation_headers(self):
        client = self.app.test_client()
        url = '/games/retro/worker/mk64_checkpoint_worker.js'
        self.assertIn(client.get(url).status_code, (401, 302))
        client.get('/test-login/worker-test')
        response = client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cross-Origin-Embedder-Policy'], 'credentialless')
        self.assertEqual(response.headers['Cross-Origin-Resource-Policy'], 'same-origin')
        response.close()
        self.assertEqual(client.get('/games/retro/worker/session.js').status_code, 404)

    def test_match_settings_are_validated_and_shared(self):
        from dataclasses import replace
        configurable = replace(GAMES['mk64'], settings=(
            ('stage', 'Stage', 4, ((4, 'Default'), (6, 'Alternative'))),
            ('stocks', 'Stocks', 5, ((1, 'One'), (5, 'Five'))),
            ('fighter0', 'Fighter', 0, ((0, 'Default'), (5, 'Alternative')))))
        with patch.dict(GAMES, mk64=configurable):
            host = self.connect('settings-host')
            payload = dict(name='Settings', gameId='mk64', compatibility=self.descriptor)
            for settings in ({'stage': 99}, {'stocks': True}, {'unknown': 1}, []):
                self.emit(host, 'create', dict(payload, settings=settings))
                self.assertTrue(self.events(host, 'room_error'))
            chosen = configurable.validate_settings({'stage': 6, 'stocks': 1, 'fighter0': 5})
            self.emit(host, 'create', dict(payload, settings=chosen))
            room = self.events(host, 'room')[0]
            self.assertEqual(room['settings'], chosen)
            watcher = self.connect('settings-watcher')
            self.emit(watcher, 'join', dict(code=room['code'], compatibility=self.descriptor))
            self.assertEqual(self.events(watcher, 'room')[0]['settings'], chosen)
            self.emit(host, 'ready', {'ready': True})
            self.emit(host, 'start_game')
            self.assertEqual(self.events(watcher, 'prepare')[0]['settings'], chosen)

    def test_rollback_immediate_input_relay(self):
        self.descriptor.update(backend='rollback-v1', rollback=dict(maxPrediction=6, inputDelay=2))
        clients, code = self.room()
        watcher = self.connect('rollback-watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.start(clients + [watcher])
        for client in clients + [watcher]:
            client.get_received('/retro')
        pad = dict(buttons=0x8000, x=80, y=0)
        self.emit(clients[0], 'input', dict(epoch=0, frame=1, slot=3, pad=pad))
        received = clients[1].get_received('/retro')
        immediate = [e['args'][0] for e in received if e['name'] == 'frame_input']
        self.assertEqual(immediate, [dict(epoch=0, frame=1, slot=0, pad=pad)])
        self.assertFalse(any(e['name'] == 'frameset' for e in received))
        self.emit(clients[0], 'input', dict(epoch=0, frame=1, pad=pad))
        self.assertFalse(self.events(clients[1], 'frame_input'))
        self.emit(watcher, 'input', dict(epoch=0, frame=1, pad=pad))
        self.assertFalse(self.events(clients[1], 'frame_input'))
        self.emit(clients[1], 'input', dict(epoch=0, frame=1, pad=pad))
        self.assertEqual(self.events(clients[0], 'frameset')[0]['pads'], [pad, pad])
        clients[1].get_received('/retro')
        self.emit(clients[0], 'input', dict(epoch=0, frame=12, pad=pad))
        self.assertFalse(self.events(clients[1], 'frame_input'))
        self.emit(clients[0], 'input', dict(epoch=0, frame=2, pad=pad))
        self.emit(clients[0], 'input', dict(epoch=0, frame=2, pad=dict(pad, x=0)))
        self.assertTrue(self.events(clients[1], 'stopped'))

    def test_rollback_settings_must_match(self):
        self.descriptor.update(backend='rollback-v1', rollback=dict(maxPrediction=6, inputDelay=2))
        clients, code = self.room(count=1)
        other = self.connect('wrong-delay')
        wrong = dict(self.descriptor, rollback=dict(maxPrediction=6, inputDelay=3))
        self.emit(other, 'join', dict(code=code, compatibility=wrong))
        self.assertTrue(self.events(other, 'room_error'))

    def test_solo_without_spectator_and_empty_room_rejected(self):
        clients, _ = self.room(count=1)
        self.emit(clients[0], 'role', dict(role='spectator'))
        self.emit(clients[0], 'start_game')
        self.assertTrue(self.events(clients[0], 'room_error'))
        self.emit(clients[0], 'role', dict(role='player'))
        self.emit(clients[0], 'start_game')
        self.assertTrue(self.events(clients[0], 'room_error'))
        self.emit(clients[0], 'ready', dict(ready=True))
        self.start(clients)

    def test_auth_routes_and_origin(self):
        self.assertFalse(self.connect(None).is_connected('/retro'))
        self.assertFalse(self.connect('x', 'https://evil.invalid').is_connected('/retro'))
        http = self.app.test_client()
        self.assertEqual(http.get('/games/retro').status_code, 401)
        self.assertEqual(http.get('/games/retro/netplay/netplay.wasm').status_code, 401)
        http.get('/test-login/x')
        page = http.get('/games/retro')
        self.assertEqual(page.status_code, 200)
        self.assertIn('retro-game-select', page.text)
        self.assertNotIn('mario_kart_64_online.js', page.text)
        self.assertEqual(page.text.count('js/mk64_gamepad.js'), 1)
        self.assertEqual(page.text.count('js/retro_controller.js'), 1)
        for game_id, game in GAMES.items():
            if 'js/retro_controller.js' not in game.scripts:
                continue
            self.assertEqual(page.text.count(f'id="{game_id}-controller-panel"'), 1)
        self.assertEqual(page.headers['Cross-Origin-Embedder-Policy'], 'credentialless')
        runtime = http.get('/games/retro/runtime/fzerox')
        self.assertEqual(runtime.status_code, 200)
        self.assertEqual(runtime.headers['Cross-Origin-Embedder-Policy'], 'credentialless')
        self.assertEqual(http.get('/games/retro/runtime/mk64').status_code, 404)
        build = Path(self.app.instance_path) / 'fzerox/build'
        build.mkdir(parents=True)
        (build / 'fzerox.js').write_text('// fixture worker')
        asset = http.get('/games/retro/build/fzerox/fzerox.js')
        self.assertEqual(asset.status_code, 200)
        self.assertEqual(asset.headers['Cross-Origin-Embedder-Policy'], 'credentialless')
        asset.close()
        self.assertEqual(http.get('/games/retro/build/fzerox/private.txt').status_code, 404)
        self.assertEqual(http.get('/games/retro/netplay/private.txt').status_code, 404)
        self.assertEqual(http.get('/games/mario-kart-64').status_code, 404)
        self.assertIn('/games/retro/build/mk64/mk64.js', page.text)

    def test_compatibility_and_game_registry(self):
        a = self.connect()
        self.emit(a, 'create', dict(name='Bad', gameId='unknown', compatibility=self.descriptor))
        self.assertTrue(self.events(a, 'room_error'))
        self.emit(a, 'create', dict(name='Bad', gameId='mk64', compatibility=dict(self.descriptor, build='old')))
        self.assertTrue(self.events(a, 'room_error'))
        other = Game('fixture-racer', 'Fixture racer', '', (), '', 'fixture', '', ())
        with patch.dict(GAMES, {'fixture-racer': other}):
            descriptor = other.descriptor(self.app)
            self.emit(a, 'create', dict(name='Other', gameId=other.id, compatibility=descriptor))
            room = self.events(a, 'room')[0]
            self.assertEqual(room['game']['id'], other.id)
            b = self.connect('b')
            self.emit(b, 'join', dict(code=room['code'], compatibility=self.descriptor))
            self.assertTrue(self.events(b, 'room_error'))

    def test_loading_barrier_host_and_four_players(self):
        clients, code = self.room(4)
        self.emit(clients[1], 'start_game')
        self.assertTrue(self.events(clients[1], 'room_error'))
        self.emit(clients[0], 'start_game')
        self.assertTrue(self.events(clients[0], 'prepare'))
        for client in clients[:-1]:
            self.emit(client, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.assertFalse(self.events(clients[0], 'start'))
        self.emit(clients[-1], 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.assertTrue(self.events(clients[0], 'start'))

    def test_ordered_inputs_restart_and_desync(self):
        clients, code = self.room()
        self.start(clients)
        pad = dict(buttons=0, x=10, y=-20)
        for frame in (2, 1):
            for client in clients:
                self.emit(client, 'input', dict(epoch=0, frame=frame, pad=pad))
        self.assertEqual([e['frame'] for e in self.events(clients[0], 'frameset')], [1, 2])
        self.emit(clients[0], 'restart_game')
        self.assertEqual(self.events(clients[0], 'prepare')[0]['epoch'], 1)
        for client in clients:
            self.emit(client, 'loaded', dict(epoch=1, compatibility=self.descriptor))
            self.emit(client, 'input', dict(epoch=0, frame=1, pad=pad))
        self.assertFalse(self.events(clients[0], 'frameset'))
        for client in clients:
            self.emit(client, 'input', dict(epoch=1, frame=1, pad=pad))
        self.assertTrue(self.events(clients[0], 'frameset'))
        for index, client in enumerate(clients):
            self.emit(client, 'hash', dict(epoch=1, frame=1, hash=index))
        self.assertTrue(self.events(clients[0], 'stopped'))

    def test_spectator_and_conflicting_inputs(self):
        clients, code = self.room()
        watcher = self.connect('watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.start(clients + [watcher])
        self.emit(watcher, 'input', dict(epoch=0, frame=1, pad=dict(buttons=0, x=0, y=0)))
        self.assertFalse(self.events(watcher, 'frameset'))
        for buttons in (0, 1):
            self.emit(clients[0], 'input', dict(epoch=0, frame=1, pad=dict(buttons=buttons, x=0, y=0)))
        self.assertTrue(self.events(clients[1], 'stopped'))

    def test_late_spectator_return_roles_and_next_game(self):
        clients, code = self.room(2)
        self.start(clients)
        watcher = self.connect('late-watcher')
        self.emit(watcher, 'list')
        self.assertEqual(self.events(watcher, 'rooms')[-1][0]['phase'], 'running')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        prepared = self.events(watcher, 'prepare')[0]
        self.assertEqual(prepared['members'][-1]['watchMode'], 'media')
        self.emit(watcher, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.assertTrue(self.events(watcher, 'start'))
        self.emit(watcher, 'role', dict(role='player'))
        self.emit(watcher, 'return_lobby')
        self.assertTrue(self.events(watcher, 'room_error'))
        self.emit(clients[0], 'return_lobby')
        returned = self.events(watcher, 'lobby_returned')[0]
        self.assertEqual(returned['code'], code)
        self.assertEqual(returned['phase'], 'lobby')
        self.assertEqual(returned['epoch'], 1)
        self.assertEqual([p['role'] for p in returned['members']], ['player', 'player', 'spectator'])
        self.assertTrue(all(not p['ready'] and not p['loaded'] and 'watchMode' not in p for p in returned['members']))
        self.emit(clients[1], 'role', dict(role='spectator'))
        self.emit(watcher, 'role', dict(role='player'))
        self.assertEqual(self.events(watcher, 'room_update')[-1]['players'], 2)
        other = dict(self.descriptor, id='fzerox', title='F-Zero X')
        self.emit(watcher, 'change_game', dict(gameId='fzerox', compatibility=other))
        self.assertTrue(self.events(watcher, 'room_error'))
        self.emit(clients[0], 'change_game', dict(gameId='fzerox', compatibility=other))
        changed = self.events(watcher, 'room_update')[-1]
        self.assertEqual(changed['game']['id'], 'fzerox')
        self.assertEqual(changed['code'], code)
        self.assertEqual(changed['epoch'], 2)
        for client in (clients[0], watcher): self.emit(client, 'ready', dict(ready=True))
        self.emit(clients[0], 'start_game')
        self.assertEqual(self.events(watcher, 'prepare')[0]['epoch'], 2)
        for client in clients + [watcher]: self.emit(client, 'loaded', dict(epoch=2, compatibility=other))
        self.assertTrue(self.events(watcher, 'start'))
        self.emit(clients[0], 'input', dict(epoch=0, frame=1, pad=dict(buttons=0, x=0, y=0)))
        self.assertFalse(self.events(watcher, 'frameset'))

    def test_loading_lobby_visible_and_late_viewer_does_not_block_start(self):
        clients, code = self.room(1)
        self.emit(clients[0], 'start_game')
        watcher = self.connect('during-load')
        self.emit(watcher, 'list')
        self.assertEqual(self.events(watcher, 'rooms')[-1][0]['phase'], 'loading')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.assertTrue(self.events(watcher, 'prepare'))
        self.emit(clients[0], 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.assertTrue(self.events(clients[0], 'start'))
        watcher.get_received('/retro')
        self.emit(clients[0], 'return_lobby')
        self.emit(watcher, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.assertFalse(self.events(watcher, 'start'))

    def test_media_only_from_first_player_with_bounded_delivery(self):
        clients, code = self.room(2)
        self.start(clients)
        watcher = self.connect('media-watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.emit(watcher, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        packet = dict(epoch=0, kind='video', payload=b'RIFF0000WEBPfixture')
        for client in (watcher, clients[1]): self.emit(client, 'spectator_media', packet)
        self.assertFalse(self.events(watcher, 'spectator_media'))
        self.emit(clients[0], 'spectator_media', dict(packet, payload=b'invalid'))
        self.assertFalse(self.events(watcher, 'spectator_media'))
        self.emit(clients[0], 'spectator_media', packet)
        self.assertEqual(self.events(watcher, 'spectator_media')[0]['sequence'], 1)
        self.emit(clients[0], 'return_lobby')
        self.emit(clients[0], 'spectator_media', packet)
        self.assertFalse(self.events(watcher, 'spectator_media'))

    def test_change_to_smaller_game_keeps_first_seat_and_validates_build(self):
        clients, code = self.room(4)
        other = dict(self.descriptor, id='oot', title=GAMES['oot'].title, maxPlayers=1)
        self.emit(clients[0], 'change_game', dict(gameId='oot', compatibility=dict(other, build='wrong')))
        self.assertTrue(self.events(clients[0], 'room_error'))
        with patch.object(Game, 'descriptor', lambda game, app: other):
            self.emit(clients[0], 'change_game', dict(gameId='oot', compatibility=other))
        room = self.events(clients[0], 'room_update')[-1]
        self.assertEqual(room['players'], 1)
        self.assertEqual([p['role'] for p in room['members']], ['player', 'spectator', 'spectator', 'spectator'])
        self.assertTrue(all(not p['ready'] for p in room['members']))
        self.emit(clients[1], 'role', dict(role='player'))
        self.assertTrue(self.events(clients[1], 'room_error'))
        self.emit(clients[0], 'role', dict(role='spectator'))
        self.emit(clients[1], 'role', dict(role='player'))
        self.assertEqual(self.events(clients[1], 'room_update')[-1]['members'][1]['slot'], 0)

    def test_late_join_and_return_for_every_registered_backend(self):
        backends = {game.backend for game in GAMES.values()}
        for backend in sorted(backends):
            with self.subTest(backend=backend):
                self.descriptor.update(backend=backend)
                self.descriptor.pop('rollback', None)
                if backend == 'rollback-v1':
                    self.descriptor['rollback'] = dict(maxPrediction=6, inputDelay=2)
                clients, code = self.room(1)
                self.start(clients)
                watcher = self.connect('backend-' + backend)
                self.emit(watcher, 'list')
                self.assertIn(code, [r['code'] for r in self.events(watcher, 'rooms')[-1]])
                self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
                self.assertTrue(self.events(watcher, 'prepare'))
                self.emit(watcher, 'loaded', dict(epoch=0, compatibility=self.descriptor))
                self.assertTrue(self.events(watcher, 'start'))
                self.emit(clients[0], 'return_lobby')
                self.assertEqual(self.events(watcher, 'lobby_returned')[0]['phase'], 'lobby')
                for client in clients + [watcher]: self.emit(client, 'leave')

    def test_ended_game_with_disconnected_host_can_return_to_lobby(self):
        clients, code = self.room(2)
        self.start(clients)
        clients[0].disconnect(namespace='/retro')
        self.emit(clients[1], 'failed', dict(epoch=0, message='Test interrupted round'))
        self.emit(clients[1], 'return_lobby')
        room = self.events(clients[1], 'lobby_returned')[0]
        self.assertEqual(room['phase'], 'lobby')
        self.assertEqual(room['players'], 1)
        self.assertEqual(room['host'], room['members'][0]['id'])

    def test_spectator_inherits_sync_room_when_last_player_leaves(self):
        self.descriptor.update(backend='sync-input-v1')
        clients, code = self.room(1)
        self.start(clients)
        watcher = self.connect('remaining-watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.emit(clients[0], 'leave')
        self.emit(watcher, 'return_lobby')
        room = self.events(watcher, 'lobby_returned')[0]
        self.assertEqual(room['players'], 0)
        self.assertEqual(room['host'], room['members'][0]['id'])
        self.emit(watcher, 'role', dict(role='player'))
        self.assertEqual(self.events(watcher, 'room_update')[-1]['players'], 1)


if __name__ == '__main__':
    if '--serve' in sys.argv:
        if '--perfectdark' in sys.argv:
            from dataclasses import replace
            from retro_package.catalog import PREVIEW_GAMES
            PREVIEW_GAMES['perfectdark'] = replace(PREVIEW_GAMES['perfectdark'], build_dir=str(ROOT / '.tmp/perfectdark/build'))
        if '--perfectdark-sync' in sys.argv:
            from dataclasses import replace
            from retro_package.catalog import PERFECTDARK_SYNC
            GAMES['perfectdark'] = replace(PERFECTDARK_SYNC, build_dir=str(ROOT / '.tmp/perfectdark/build'))
        if '--authoritative' in sys.argv:
            from dataclasses import replace
            # Explicit test-only catalog entry; the browser test supplies a tiny
            # independent simulation, never a real MK64 authoritative adapter.
            GAMES['mk64'] = replace(GAMES['mk64'], backend='authoritative-host-v1',
                input_schema='fps-command-v1', tick_rate=60, files=(), rom='js/netplay/authoritative.js')
        if '--smash' in sys.argv:
            from dataclasses import replace
            from retro_package.catalog import SMASH64
            GAMES['smash64'] = replace(SMASH64, build_dir=str(ROOT / '.tmp/battleship-web/build-wasm'))
        if '--smash-input-delay' in sys.argv:
            from dataclasses import replace
            delay = int(sys.argv[sys.argv.index('--smash-input-delay') + 1])
            if not 0 <= delay <= 4:
                raise ValueError('Smash test input delay must be 0..4.')
            GAMES['smash64'] = replace(GAMES['smash64'], input_delay=delay)
        if '--rollback' in sys.argv:
            from dataclasses import replace
            # Only the isolated fixture changes backend; no production game opts in.
            GAMES['mk64'] = replace(GAMES['mk64'], backend='rollback-v1')
        if '--fzero' in sys.argv:
            from dataclasses import replace
            GAMES['fzerox'] = replace(GAMES['fzerox'], build_dir=str(ROOT / '.tmp/fzerox/runtime-build'))
        app, sio = make_app(ROOT / 'instance')
        if '--smash-hybrid' in sys.argv:
            @app.after_request
            def enable_smash_hybrid(response):
                if response.mimetype == 'text/html' and not response.direct_passthrough:
                    response.set_data(response.get_data().replace(
                        b'peakNativeFlow: true,', b'peakNativeFlow: true, peakHybridRollback: true,'))
                return response
        port = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else 8066
        if not 1024 <= port <= 65535:
            raise ValueError('Test port must be 1024..65535.')
        sio.run(app, host='127.0.0.1', port=port, debug=False, allow_unsafe_werkzeug=True)
    else:
        unittest.main()
