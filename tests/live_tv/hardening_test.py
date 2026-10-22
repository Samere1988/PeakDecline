"""Isolated access control, probe, and recovery regression tests."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flask import Flask
from app import login_manager
from app.routes import main_bp, handle_join_live_tv
from app.services.streamer import StreamService, streamer


class MediaAccessTests(unittest.TestCase):
    def test_media_requires_login_and_nonmedia_is_never_served(self):
        app = Flask(__name__)
        app.secret_key = 'isolated-test'
        login_manager.init_app(app)
        app.register_blueprint(main_bp)
        with tempfile.TemporaryDirectory() as directory, patch.object(streamer, 'stream_root', directory):
            root = Path(directory) / '1' / '0'
            root.mkdir(parents=True)
            (root / 'index.m3u8').write_text('#EXTM3U')
            (root / 'seg_1234abcd_001.ts').write_bytes(b'media')
            (root / 'ffmpeg_error.log').write_text('private')
            client = app.test_client()
            for prefix in ['/static/stream/', '/stream/']:
                self.assertEqual(client.get(prefix + '1/0/index.m3u8').status_code, 401)
                self.assertEqual(client.get(prefix + '1/0/ffmpeg_error.log').status_code, 404)
                with patch('app.routes.current_user', Mock(is_authenticated=True)):
                    response = client.get(prefix + '1/0/index.m3u8')
                    self.assertEqual(response.status_code, 200)
                    self.assertIn('no-store', response.headers['Cache-Control'])
                    response.close()
                    with client.get(prefix + '1/0/seg_1234abcd_001.ts') as segment:
                        self.assertEqual(segment.status_code, 200)
                    self.assertEqual(client.get(prefix + '1/0/ffmpeg_error.log').status_code, 404)
                    self.assertEqual(client.get(prefix + '../private.env').status_code, 404)
            self.assertEqual(client.get('/api/live/media-auth').status_code, 401)
            with patch('app.routes.current_user', Mock(is_authenticated=True)):
                self.assertEqual(client.get('/api/live/media-auth').status_code, 204)

    def test_guest_cannot_keep_encoder_alive(self):
        with patch('app.routes.current_user', Mock(is_authenticated=False)), patch('app.routes.join_room') as join:
            handle_join_live_tv()
            join.assert_not_called()


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.service = StreamService()
        self.service.source = (1, 'test-source', 'Test')
        self.service.watchdog_token = 'selection'

    def test_dead_process_restarts_and_superseded_watchdog_cannot_restart(self):
        self.service.process = Mock(poll=lambda: 1)
        with patch.object(self.service, '_start_stream', return_value=(True, 'Ready')) as start:
            self.assertEqual(self.service.watchdog_step('selection'), 'recovered')
            start.assert_called_once_with(1, 'test-source', 'Test')
            self.assertEqual(self.service.revision, 2)
            self.service.stop_stream()
            self.assertEqual(self.service.watchdog_step('selection'), 'stopped')
            start.assert_called_once()

    def test_retries_back_off_and_stop_after_three_failures(self):
        with patch.object(self.service, '_start_stream', return_value=(False, 'Unavailable')) as start, patch('app.services.streamer.time.monotonic', return_value=100) as now:
            self.assertEqual(self.service.watchdog_step('selection'), 'recovering')
            self.assertIsNone(self.service.watchdog_step('selection'))
            now.return_value = 102
            self.assertEqual(self.service.watchdog_step('selection'), 'recovering')
            now.return_value = 106
            self.assertEqual(self.service.watchdog_step('selection'), 'recovering')
            now.return_value = 114
            self.assertEqual(self.service.watchdog_step('selection'), 'failed')
            self.assertEqual(start.call_count, 3)
            self.assertIsNone(self.service.watchdog_token)
            self.assertFalse(self.service.recovering)

    def test_failed_recovery_preserves_the_session_used_by_stop(self):
        self.service.session_id = 'original'
        def fail(*args):
            self.service.session_id = None
            return False, 'Unavailable'
        with patch.object(self.service, '_start_stream', side_effect=fail):
            self.assertEqual(self.service.watchdog_step('selection'), 'recovering')
            self.assertEqual(self.service.session_id, 'original')

    def test_unchanged_playlist_is_a_failure_even_with_running_process(self):
        self.service.process = Mock(poll=lambda: None)
        self.service.last_edge = 123
        self.service.last_progress = 0
        with patch('app.services.live_clock.live_clock.snapshot', return_value={'edge_pdt': 123}), patch('app.services.streamer.time.monotonic', return_value=21):
            self.assertFalse(self.service.healthy())

    def test_probe_distinguishes_audio_from_video_only_and_hides_source_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            for audio in [False, True]:
                path = str(Path(directory) / f'input-{audio}.ts')
                args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25']
                if audio:
                    args += ['-f', 'lavfi', '-i', 'sine=frequency=440']
                subprocess.run(args + ['-t', '0.2', '-c:v', 'libx264', '-c:a', 'aac', path], check=True, capture_output=True)
                self.assertEqual(self.service._has_audio(path), audio)
        with patch('app.services.streamer.cooperative_subprocess.run', return_value=Mock(returncode=1, stderr=b'secret-token')):
            with self.assertRaisesRegex(RuntimeError, '^Source probe failed$'):
                self.service._has_audio('secret-source')


if __name__ == '__main__':
    unittest.main()
