"""Persistent channel ranking and shared favorites, with no real streams or databases."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flask import Flask
from app import db, login_manager
from app.models import Channel, ChannelPlayCount
from app.routes import main_bp
from app.services.streamer import streamer


class ChannelPreferencesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = Flask(__name__)
        self.app.config.update(SECRET_KEY='test', LOGIN_DISABLED=True,
            SQLALCHEMY_DATABASE_URI='sqlite://',
            SQLALCHEMY_BINDS={'channels_db': 'sqlite:///' + str(Path(self.directory.name) / 'channels.db')})
        db.init_app(self.app)
        login_manager.init_app(self.app)
        self.app.register_blueprint(main_bp)
        self.context = self.app.app_context()
        self.context.push()
        db.create_all()
        db.session.add_all([Channel(id=1, name='Alpha', url='fixture'), Channel(id=2, name='Beta', url='fixture')])
        db.session.commit()
        self.client = self.app.test_client()
        self.emitter = patch('app.routes.socketio.emit').start()
        patch('app.routes.socketio.start_background_task').start()
        self.start = patch.object(streamer, 'start_stream', return_value=(True, 'Started')).start()
        patch.object(streamer, 'process', None).start()
        patch.object(streamer, 'healthy', return_value=True).start()

    def tearDown(self):
        patch.stopall()
        db.session.remove()
        for engine in db.engines.values():
            engine.dispose()
        self.context.pop()
        self.directory.cleanup()

    def test_ranking_persists_and_failed_plays_do_not_count(self):
        self.assertEqual([c['id'] for c in self.client.get('/api/channels').json], [1, 2])
        for _ in range(2):
            self.assertEqual(self.client.post('/api/play/2').status_code, 200)
        db.session.remove()
        channels = self.client.get('/api/channels').json
        self.assertTrue(all('url' not in c for c in channels))
        self.assertEqual([(c['id'], c['play_count']) for c in channels], [(2, 2), (1, 0)])
        self.start.return_value = False, 'Unavailable'
        self.assertEqual(self.client.post('/api/play/1').status_code, 500)
        self.assertIsNone(db.session.get(ChannelPlayCount, 1))
        self.assertEqual(self.client.post('/api/play/999').status_code, 404)
        self.emitter.assert_any_call('channels_updated')

    def test_favorites_persist_and_validate(self):
        for favorite in [True, True, False]:
            response = self.client.put('/api/channels/2/favorite', json={'favorite': favorite})
            self.assertEqual(response.status_code, 200)
            db.session.remove()
            channels = self.client.get('/api/channels').json
            self.assertEqual(next(c for c in channels if c['id'] == 2)['Favorites'], favorite)
        self.assertEqual(self.client.put('/api/channels/2/favorite', json={'favorite': 'false'}).status_code, 400)
        self.assertEqual(self.client.put('/api/channels/999/favorite', json={'favorite': True}).status_code, 404)

    def test_current_channel_selection_counts_without_restarting(self):
        from unittest.mock import Mock
        with patch.object(streamer, 'current_channel_id', 2), patch.object(streamer, 'process', Mock(poll=lambda: None)):
            self.assertEqual(self.client.post('/api/play/2').status_code, 200)
        self.start.assert_not_called()
        self.assertEqual(db.session.get(ChannelPlayCount, 2).play_count, 1)

    def test_status_preserves_selection_between_death_and_watchdog_tick(self):
        from unittest.mock import Mock
        with patch.object(streamer, 'current_channel_id', 2), patch.object(streamer, 'source', (2, 'fixture', 'Beta')), patch.object(streamer, 'watchdog_token', 'selected'), patch.object(streamer, 'process', Mock(poll=lambda: 1)):
            state = self.client.get('/api/status').json
            self.assertTrue(state['is_streaming'])
            self.assertTrue(state['stream_recovering'])
            self.assertEqual(state['current_channel_id'], 2)

    def test_clock_fallback_reads_native_instead_of_master_playlist(self):
        from unittest.mock import Mock
        directory = Path(self.directory.name)
        (directory / '0').mkdir()
        (directory / 'index.m3u8').write_text('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n0/index.m3u8\n')
        native = directory / '0' / 'index.m3u8'
        native.write_text('#EXTM3U\n#EXTINF:2,\n#EXT-X-PROGRAM-DATE-TIME:2026-09-09T09:48:22.405-0400\nseg_fallback_000.ts\n')
        with patch.object(streamer, 'current_channel_id', 1), patch.object(streamer, 'process', Mock(poll=lambda: None)), patch.object(streamer, 'clock_playlist_path', None), patch.object(streamer, 'current_channel_dir', str(directory)):
            response = self.client.get('/api/live-clock/1')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['session'], 'seg_fallback')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            native.write_text('#EXTM3U\n#EXTINF:2,\nseg_no_dates_000.ts\n')
            response = self.client.get('/api/live-clock/1')
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json['reason'], 'invalid_timestamps')

    def test_clock_explains_inactive_stream(self):
        response = self.client.get('/api/live-clock/1')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json['reason'], 'inactive_stream')


if __name__ == '__main__':
    unittest.main()
