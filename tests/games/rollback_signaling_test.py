"""Authenticated RTC rendezvous and bounded relay, without production state."""
import unittest
import retro_test as fixture
from retro_package.rooms import rollback_ice_servers


class RollbackSignalingTests(unittest.TestCase):
    close_clients = fixture.RetroTests.close_clients
    connect = fixture.RetroTests.connect
    emit = fixture.RetroTests.emit
    events = fixture.RetroTests.events
    room = fixture.RetroTests.room
    start = fixture.RetroTests.start

    def setUp(self):
        fixture.RetroTests.setUp(self)
        self.descriptor.update(backend='rollback-v1', rollback=dict(maxPrediction=6, inputDelay=2, peerInputs=True))
        self.app.config['NETPLAY_ICE_SERVERS'] = []

    def connected_room(self, count=2):
        clients, code = self.room(count)
        self.start(clients)
        for client in clients:
            client.get_received('/retro')
            self.emit(client, 'rollback_connect', {'epoch': 0})
        return clients, code

    def test_authenticated_roster_and_signaling(self):
        clients, _ = self.connected_room()
        first = self.events(clients[0], 'rollback_transport')[0]
        second = self.events(clients[1], 'rollback_transport')[0]
        self.assertEqual(first['slot'], 0)
        self.assertEqual(second['slot'], 1)
        self.assertEqual(set(second['peers']), {0, 1})
        self.assertEqual(second['iceServers'], [])
        self.emit(clients[0], 'rollback_signal', dict(epoch=0, to=1, type='offer', value='v=0', **{'from': 3}))
        event = self.events(clients[1], 'rollback_signal')[0]
        self.assertEqual(event, dict(epoch=0, to=1, type='offer', value='v=0', **{'from': 0}))
        self.emit(clients[1], 'rollback_signal', dict(epoch=0, to=0, type='answer', value='v=0'))
        self.assertEqual(self.events(clients[0], 'rollback_signal')[0]['from'], 1)

    def test_spectator_stale_cross_room_and_malformed_rejected(self):
        clients, code = self.room()
        watcher = self.connect('watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.start(clients + [watcher])
        for client in clients:
            self.emit(client, 'rollback_connect', {'epoch': 0})
            client.get_received('/retro')
        watcher.get_received('/retro')
        self.emit(watcher, 'rollback_connect', {'epoch': 0})
        self.assertFalse(self.events(watcher, 'rollback_transport'))
        self.emit(watcher, 'rollback_signal', dict(epoch=0, to=1, type='offer', value='v=0'))
        outsider = self.connect('other-room')
        self.emit(outsider, 'create', dict(name='Other', gameId='mk64', compatibility=self.descriptor))
        self.emit(outsider, 'rollback_signal', dict(epoch=0, to=1, type='offer', value='v=0'))
        for payload in (
            dict(epoch=1, to=1, type='offer', value='v=0'),
            dict(epoch=True, to=1, type='offer', value='v=0'),
            dict(epoch=0, to=True, type='offer', value='v=0'),
            dict(epoch=0, to=2, type='offer', value='v=0'),
            dict(epoch=0, to=1, type='answer', value='v=0'),
            dict(epoch=0, to=1, type='offer', value='x'*65537),
            dict(epoch=0, to=1, type='candidate', value={'candidate':'x','sdpMLineIndex':True}),
        ):
            self.emit(clients[0], 'rollback_signal', payload)
        self.assertFalse(self.events(clients[1], 'rollback_signal'))
        self.emit(clients[0], 'rollback_signal', dict(epoch=0, to=1, type='candidate',
            value=dict(candidate='candidate:x', sdpMid='0', sdpMLineIndex=0, usernameFragment='u')))
        self.assertEqual(len(self.events(clients[1], 'rollback_signal')), 1)

    def test_non_peer_session_and_signaling_rate_bound(self):
        clients, _ = self.connected_room()
        for _ in range(140):
            self.emit(clients[0], 'rollback_signal', dict(epoch=0, to=1, type='candidate', value={'candidate':'candidate:x'}))
        self.assertEqual(len(self.events(clients[1], 'rollback_signal')), 128)
        self.emit(clients[0], 'leave')
        self.descriptor['rollback']['peerInputs'] = False
        clients, _ = self.room()
        self.start(clients)
        self.emit(clients[0], 'rollback_connect', {'epoch': 0})
        self.assertFalse(self.events(clients[0], 'rollback_transport'))

    def test_generation_forwarding_and_legacy_compatibility(self):
        clients, _ = self.connected_room()
        for client in clients:
            client.get_received('/retro')
        candidate = dict(candidate='candidate:x', sdpMid='0', sdpMLineIndex=0)
        for generation in (0, 1, 4):
            for source, target, kind, value in (
                (0, 1, 'offer', 'v=0'),
                (1, 0, 'answer', 'v=0'),
                (0, 1, 'candidate', candidate),
                (1, 0, 'candidate', candidate),
                (1, 0, 'restart', None),
            ):
                with self.subTest(generation=generation, kind=kind, source=source):
                    self.emit(clients[source], 'rollback_signal', dict(epoch=0, to=target, type=kind,
                              value=value, generation=generation, **{'from': 99}))
                    self.assertEqual(self.events(clients[target], 'rollback_signal'), [
                        dict(epoch=0, to=target, type=kind, value=value,
                             generation=generation, **{'from': source})])
        for source, target, kind, value in (
            (0, 1, 'offer', 'v=0'), (1, 0, 'answer', 'v=0'), (0, 1, 'candidate', candidate),
        ):
            self.emit(clients[source], 'rollback_signal', dict(epoch=0, to=target, type=kind, value=value))
            self.assertEqual(self.events(clients[target], 'rollback_signal'), [
                dict(epoch=0, to=target, type=kind, value=value, **{'from': source})])

    def test_confirmed_phase_buffer_without_peer_transport(self):
        self.descriptor['rollback'].update(peerInputs=False, inputDelay=1, confirmedInputDelay=8)
        clients, _ = self.room()
        self.start(clients)
        for client in clients:
            client.get_received('/retro')
        pad = dict(buttons=0, x=0, y=0)
        # The second seat has not submitted anything yet; all nine inputs must
        # fit the relay's agreed window and remain available when it catches up.
        for frame in range(1, 10):
            self.emit(clients[0], 'input', dict(epoch=0, frame=frame, pad=pad))
        # Exercise the wider confirmed-phase budget beyond the old window of 9.
        self.emit(clients[0], 'input', dict(epoch=0, frame=10, pad=pad))
        for frame in range(1, 11):
            self.emit(clients[1], 'input', dict(epoch=0, frame=frame, pad=pad))
        self.assertEqual([event['frame'] for event in self.events(clients[0], 'frameset')],
                         list(range(1, 11)))

    def test_invalid_generation_and_restart_rejected(self):
        clients, _ = self.connected_room()
        for client in clients:
            client.get_received('/retro')
        for generation in (True, False, -1, 5, 1.0, '1', None):
            for source, target, kind, value in (
                (0, 1, 'offer', 'v=0'), (1, 0, 'answer', 'v=0'),
                (0, 1, 'candidate', {'candidate': 'candidate:x'}), (1, 0, 'restart', None),
            ):
                with self.subTest(generation=generation, kind=kind):
                    self.emit(clients[source], 'rollback_signal', dict(epoch=0, to=target,
                              type=kind, value=value, generation=generation))
                    self.assertFalse(self.events(clients[target], 'rollback_signal'))
        for source, payload in (
            (1, dict(epoch=0, to=0, type='restart', value=None)),
            (1, dict(epoch=0, to=0, type='restart', generation=1)),
            (0, dict(epoch=0, to=1, type='restart', generation=1, value=None)),
            (1, dict(epoch=1, to=0, type='restart', generation=1, value=None)),
            (1, dict(epoch=0, to=0, type='restart', generation=1, value='')),
            (1, dict(epoch=0, to=0, type='restart', generation=1, value=False)),
            (1, dict(epoch=0, to=0, type='restart', generation=1, value={})),
        ):
            with self.subTest(source=source, payload=payload):
                self.emit(clients[source], 'rollback_signal', payload)
                self.assertFalse(self.events(clients[1 - source], 'rollback_signal'))

    def test_restart_uses_existing_signaling_rate_limit(self):
        clients, _ = self.connected_room()
        for client in clients:
            client.get_received('/retro')
        for _ in range(127):
            self.emit(clients[1], 'rollback_signal', dict(epoch=0, to=0, type='candidate',
                      generation=1, value={'candidate': 'candidate:x'}))
        self.assertEqual(len(self.events(clients[0], 'rollback_signal')), 127)
        restart = dict(epoch=0, to=0, type='restart', generation=1, value=None)
        self.emit(clients[1], 'rollback_signal', restart)
        self.assertEqual(len(self.events(clients[0], 'rollback_signal')), 1)
        self.emit(clients[1], 'rollback_signal', restart)
        self.assertFalse(self.events(clients[0], 'rollback_signal'))

    def test_bounded_relay_accepts_peer_lead_and_recovers_contiguously(self):
        clients, _ = self.connected_room()
        for client in clients:
            client.get_received('/retro')
        pad = dict(buttons=0, x=0, y=0)
        self.emit(clients[0], 'input', dict(epoch=0, frame=129, pad=pad))
        self.assertFalse(self.events(clients[1], 'frame_input'))
        for frame in range(1, 129):
            self.emit(clients[0], 'input', dict(epoch=0, frame=frame, pad=pad))
        self.assertEqual(len(self.events(clients[1], 'frame_input')), 128)
        for frame in range(1, 129):
            self.emit(clients[1], 'input', dict(epoch=0, frame=frame, pad=pad))
        self.assertEqual(self.events(clients[0], 'frameset')[-1]['frame'], 128)
        self.emit(clients[0], 'input', dict(epoch=0, frame=129, pad=pad))
        self.emit(clients[1], 'input', dict(epoch=0, frame=129, pad=pad))
        self.assertEqual(self.events(clients[0], 'frameset')[-1]['frame'], 129)

    def test_ice_configuration_validation(self):
        valid = [{'urls':['turn:relay.example:3478?transport=udp'], 'username':'test', 'credential':'temporary'}]
        self.app.config['NETPLAY_ICE_SERVERS'] = valid
        self.assertEqual(rollback_ice_servers(self.app), valid)
        for invalid in ('invalid json', {}, [{'urls':'https://example.com'}], [{'urls':'stun:x\nprivate'}], [{'urls':'stun:x','credential':3}]):
            self.app.config['NETPLAY_ICE_SERVERS'] = invalid
            self.assertEqual(rollback_ice_servers(self.app), [])


if __name__ == '__main__':
    unittest.main()
