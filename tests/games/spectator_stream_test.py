"""The video rendezvous must not bypass room, role, epoch or relay bounds."""
import unittest
from unittest.mock import patch
import retro_test as fixture
from retro_package import spectator_streams


class SpectatorStreamTests(unittest.TestCase):
    close_clients = fixture.RetroTests.close_clients
    connect = fixture.RetroTests.connect
    emit = fixture.RetroTests.emit
    events = fixture.RetroTests.events
    room = fixture.RetroTests.room
    start = fixture.RetroTests.start

    def setUp(self):
        fixture.RetroTests.setUp(self)
        self.app.config['NETPLAY_ICE_SERVERS'] = []

    def live(self, backend='recomp-ring-lockstep-v1'):
        self.descriptor['backend'] = backend
        players, code = self.room()
        self.start(players)
        watcher = self.connect('watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.emit(watcher, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        for client in [*players, watcher]:
            client.get_received('/retro')
        self.emit(watcher, 'spectator_connect', dict(epoch=0, token='first'))
        dest = self.events(watcher, 'spectator_transport')[0]
        source = self.events(players[0], 'spectator_transport')[0]
        self.assertEqual(dest['iceServers'], [])
        self.assertFalse(dest['publisher'])
        self.assertTrue(source['publisher'])
        return players, watcher, code, dest['peer'], source['peer']

    def test_all_video_backends_authenticate_signaling(self):
        for backend in spectator_streams.BACKENDS:
            with self.subTest(backend=backend):
                players, watcher, _, host_id, viewer_id = self.live(backend)
                self.emit(players[0], 'spectator_signal', dict(epoch=0, token='first', to=viewer_id,
                          type='offer', value='v=0', **{'from': 'spoofed'}))
                self.assertEqual(self.events(watcher, 'spectator_signal'), [dict(epoch=0, token='first', type='offer', value='v=0', **{'from': host_id})])
                self.emit(watcher, 'spectator_signal', dict(epoch=0, token='first', to=host_id, type='answer', value='v=0'))
                self.assertEqual(self.events(players[0], 'spectator_signal')[0]['from'], viewer_id)
                for client in [*players, watcher]:
                    client.disconnect(namespace='/retro')

    def test_wrong_roles_epochs_rooms_and_payloads_rejected(self):
        players, watcher, code, host_id, viewer_id = self.live()
        outsider = self.connect('outside')
        good = dict(epoch=0, token='first', to=viewer_id, type='offer', value='v=0')
        for client in (players[1], watcher, outsider):
            self.emit(client, 'spectator_signal', good)
        for bad in (dict(epoch=True), dict(epoch=1), dict(token='old'), dict(to=host_id), dict(type='answer'),
                    dict(value='x'*65537), dict(type='candidate', value={'candidate':'x','sdpMLineIndex':True}),
                    dict(type='candidate', value={'candidate':'x','extra':1}), dict(type='camera')):
            self.emit(players[0], 'spectator_signal', dict(good, **bad))
        self.assertFalse(self.events(watcher, 'spectator_signal'))
        self.emit(players[0], 'spectator_signal', dict(good, type='candidate', value={'candidate':'candidate:x','sdpMid':'0','sdpMLineIndex':0}))
        self.assertEqual(len(self.events(watcher, 'spectator_signal')), 1)
        self.emit(watcher, 'leave')
        self.emit(players[0], 'spectator_signal', good)
        self.assertFalse(self.events(watcher, 'spectator_signal'))

    def test_relay_only_suppressed_after_video_with_expiring_lease(self):
        players, watcher, _, host_id, viewer_id = self.live()
        packet = dict(epoch=0, kind='video', payload=b'RIFF\x04\x00\x00\x00WEBP')
        self.emit(players[0], 'spectator_media', packet)
        self.assertEqual(len(self.events(watcher, 'spectator_media')), 1)
        self.emit(watcher, 'spectator_stream_state', dict(epoch=0, token='first', active=True))
        self.assertTrue(self.events(players[0], 'spectator_stream_state')[0]['active'])
        self.emit(players[0], 'spectator_media', packet)
        self.assertFalse(self.events(watcher, 'spectator_media'))
        self.emit(watcher, 'spectator_stream_state', dict(epoch=0, token='old', active=False))
        self.emit(players[0], 'spectator_media', packet)
        self.assertFalse(self.events(watcher, 'spectator_media'))
        import time
        with patch.object(spectator_streams, 'monotonic', return_value=time.monotonic()+6), patch('retro_package.native.monotonic', return_value=time.monotonic()+6):
            self.emit(players[0], 'spectator_media', packet)
        self.assertEqual(len(self.events(watcher, 'spectator_media')), 1)

    def test_rejoin_token_replaces_old_connection_and_lobby_clears_it(self):
        players, watcher, _, host_id, viewer_id = self.live()
        self.emit(watcher, 'spectator_stream_state', dict(epoch=0, token='first', active=True))
        self.emit(watcher, 'spectator_connect', dict(epoch=0, token='second'))
        self.assertEqual(self.events(watcher, 'spectator_transport')[0]['token'], 'second')
        good = dict(epoch=0, to=viewer_id, type='offer', value='v=0')
        self.emit(players[0], 'spectator_signal', dict(good, token='first'))
        self.assertFalse(self.events(watcher, 'spectator_signal'))
        self.emit(players[0], 'spectator_signal', dict(good, token='second'))
        self.assertEqual(len(self.events(watcher, 'spectator_signal')), 1)
        self.emit(players[0], 'return_lobby')
        watcher.get_received('/retro')
        self.emit(players[0], 'spectator_signal', dict(good, token='second'))
        self.emit(watcher, 'spectator_connect', dict(epoch=1, token='lobby'))
        self.assertFalse(self.events(watcher, 'spectator_transport'))

    def test_initial_viewer_uses_media_and_signaling_is_bounded(self):
        players, code = self.room(1)
        watcher = self.connect('early-viewer')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.emit(players[0], 'start_game')
        prepared = self.events(watcher, 'prepare')[0]
        self.assertEqual(prepared['members'][-1]['watchMode'], 'media')
        # No rendezvous before all players have loaded and the round is running.
        self.emit(watcher, 'spectator_connect', dict(epoch=0, token='early'))
        self.assertFalse(self.events(watcher, 'spectator_transport'))
        for client in [*players, watcher]:
            self.emit(client, 'loaded', dict(epoch=0, compatibility=self.descriptor))
            client.get_received('/retro')
        self.emit(watcher, 'spectator_connect', dict(epoch=0, token='early'))
        target = self.events(players[0], 'spectator_transport')[0]['peer']
        watcher.get_received('/retro')
        for _ in range(180):
            self.emit(players[0], 'spectator_signal', dict(epoch=0, token='early', to=target,
                      type='candidate', value={'candidate':'candidate:x'}))
        count = len(self.events(watcher, 'spectator_signal'))
        self.assertGreater(count, 100)
        self.assertLess(count, 140)

    def test_cmr2_publisher_follows_coordinator(self):
        import struct
        players, watcher, _, host_id, viewer_id = self.live('cmr2-server-relay-v1')
        self.emit(players[0], 'cmr2_command', dict(epoch=0, kind=1, payload=struct.pack('<6I',0x2064,99,8,0,0,0)))
        for seat, player in enumerate(players):
            self.emit(player, 'cmr2_command', dict(epoch=0, kind=3, name='P'+str(seat), payload=bytes(16)))
        self.emit(watcher, 'spectator_stream_state', dict(epoch=0, token='first', active=True))
        self.emit(players[0], 'leave')
        self.emit(players[1], 'spectator_connect', dict(epoch=0))
        new = self.events(watcher, 'spectator_transport')[0]
        self.assertNotEqual(new['peer'], host_id)
        self.emit(players[1], 'spectator_signal', dict(epoch=0, token='first', to=viewer_id, type='offer', value='new'))
        self.assertEqual(self.events(watcher, 'spectator_signal')[0]['value'], 'new')


if __name__ == '__main__':
    unittest.main()
