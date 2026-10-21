"""Verify persistent login cookies and empty-room shutdown without real streams."""
from datetime import timedelta
from unittest.mock import Mock, patch
import unittest

from channel_preferences_test import ChannelPreferencesTest
from app import db
from app.auth import auth_bp
from app.models import User, Channel
from app import routes
from app.services.streamer import streamer


class SessionCleanupTest(ChannelPreferencesTest):
    def setUp(self):
        super().setUp()
        routes.live_tv_occupancy.clear()
        routes.live_tv_empty_token = None
        self.app.register_blueprint(auth_bp)
        self.app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
        self.tasks = []
        patch('app.routes.socketio.start_background_task', side_effect=lambda fn: self.tasks.append(fn)).start()
        patch('app.routes.socketio.sleep').start()
        patch.object(streamer, 'process', Mock(poll=lambda: None)).start()
        self.stop = patch.object(streamer, 'stop_stream').start()

    def tearDown(self):
        routes.live_tv_occupancy.clear()
        routes.live_tv_empty_token = None
        super().tearDown()

    def test_login_survives_browser_close_and_logout_still_works(self):
        user = User(id='login-test', username='test', email='test@example.invalid')
        user.set_password('test-password')
        db.session.add(user)
        db.session.commit()
        response = self.client.post('/login', data={'email': user.email, 'password': 'test-password'})
        self.assertEqual(response.status_code, 302)
        self.assertIn('Expires=', response.headers['Set-Cookie'])
        with self.client.session_transaction() as login_session:
            self.assertTrue(login_session.permanent)
            self.assertEqual(login_session['_user_id'], user.id)
        self.client.get('/logout')
        with self.client.session_transaction() as login_session:
            self.assertNotIn('_user_id', login_session)

    def test_last_disconnect_stops_after_grace_and_clears_playing(self):
        db.session.get(Channel, 1).is_playing = '1'
        db.session.commit()
        routes.live_tv_occupancy['viewer'] = 'test'
        with self.app.test_request_context('/') as context:
            context.request.sid = 'viewer'
            routes.sio_disconnect()
        self.stop.assert_not_called()
        self.assertEqual(len(self.tasks), 1)
        self.tasks[0]()
        self.stop.assert_called_once()
        self.assertEqual(db.session.get(Channel, 1).is_playing, '0')
        self.assertTrue(any(call.args[0] == 'channel_changed' for call in self.emitter.call_args_list))

    def test_refresh_cancels_old_countdown_even_after_leaving_again(self):
        routes._schedule_empty_live_tv_cleanup()
        old_task = self.tasks[-1]
        with self.app.test_request_context('/') as context, patch('app.routes.join_room'):
            context.request.sid = 'rejoined'
            routes.handle_join_live_tv()
            old_task()
            self.stop.assert_not_called()
            routes.sio_disconnect()
        old_task()
        self.stop.assert_not_called()
        self.tasks[-1]()
        self.stop.assert_called_once()

    def test_remaining_viewer_or_other_page_disconnect_does_not_schedule(self):
        routes.live_tv_occupancy.update(first='test', second='test')
        with self.app.test_request_context('/') as context:
            context.request.sid = 'first'
            routes.sio_disconnect()
            context.request.sid = 'other-page'
            routes.sio_disconnect()
        self.assertEqual(self.tasks, [])
        self.stop.assert_not_called()


if __name__ == '__main__':
    unittest.main()
