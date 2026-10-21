"""A checksum mismatch ends only the match and preserves a usable room."""
import unittest
from unittest.mock import patch
import retro_test as fixture


class DesyncRecoveryTests(unittest.TestCase):
    close_clients = fixture.RetroTests.close_clients
    connect = fixture.RetroTests.connect
    emit = fixture.RetroTests.emit
    events = fixture.RetroTests.events
    room = fixture.RetroTests.room
    start = fixture.RetroTests.start

    def setUp(self):
        fixture.RetroTests.setUp(self)
        self.descriptor.update(backend='rollback-v1', rollback=dict(maxPrediction=6, inputDelay=1))

    def test_mismatch_returns_everyone_and_old_packets_cannot_stop_next_match(self):
        clients, code = self.room(4)
        watcher = self.connect('watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        everyone = clients + [watcher]
        self.start(everyone)
        pad = dict(buttons=0, x=0, y=0)
        for client in clients:
            self.emit(client, 'input', dict(epoch=0, frame=1, pad=pad))
        for client in everyone:
            client.get_received('/retro')
        self.emit(watcher, 'hash', dict(epoch=0, frame=1, hash=99))
        for client in clients[:-1]:
            self.emit(client, 'hash', dict(epoch=0, frame=1, hash=12))
        self.assertFalse(self.events(clients[0], 'lobby_returned'))
        with patch('retro_package.rooms.record_diagnostics') as record:
            self.emit(clients[-1], 'hash', dict(epoch=0, frame=1, hash=34))
        self.assertEqual(record.call_args.args[0], 'desync')
        self.assertEqual(record.call_args.kwargs['frame'], 1)
        for client in everyone:
            events = client.get_received('/retro')
            self.assertFalse(any(e['name'] == 'stopped' for e in events))
            returned = [e['args'][0] for e in events if e['name'] == 'lobby_returned']
            self.assertEqual(len(returned), 1)
            room = returned[0]
            self.assertEqual((room['code'], room['phase'], room['epoch']), (code, 'lobby', 1))
            self.assertEqual([p['role'] for p in room['members']], ['player'] * 4 + ['spectator'])
            self.assertTrue(all(not p['ready'] and not p['loaded'] for p in room['members']))
            self.assertEqual(room['interruption'], dict(reason='desync', epoch=0, frame=1,
                checksums=[dict(slot=i, hash=12 if i < 3 else 34) for i in range(4)]))
        # A fresh readiness barrier remains required; spectators cannot start it.
        self.emit(clients[0], 'start_game')
        self.assertTrue(self.events(clients[0], 'room_error'))
        for client in clients:
            self.emit(client, 'ready', dict(ready=True))
        self.emit(watcher, 'start_game')
        self.assertTrue(self.events(watcher, 'room_error'))
        self.emit(clients[0], 'start_game')
        self.assertEqual(self.events(clients[0], 'prepare')[0]['epoch'], 1)
        for client in everyone:
            self.emit(client, 'loaded', dict(epoch=1, compatibility=self.descriptor))
        self.assertEqual(self.events(clients[0], 'start')[0]['epoch'], 1)
        for client in clients:
            self.emit(client, 'failed', dict(epoch=0, message='Old runtime shutdown'))
            self.emit(client, 'hash', dict(epoch=0, frame=1, hash=99))
            self.emit(client, 'input', dict(epoch=0, frame=1, pad=pad))
            self.emit(client, 'input', dict(epoch=1, frame=1, pad=pad))
        self.assertEqual(self.events(clients[0], 'frameset')[0]['epoch'], 1)
        for client in clients:
            self.emit(client, 'hash', dict(epoch=1, frame=1, hash=56))
        for client in everyone:
            events = client.get_received('/retro')
            self.assertFalse(any(e['name'] in ('stopped', 'lobby_returned') for e in events))

    def test_runtime_failure_preserves_room_and_rejects_late_failure(self):
        clients, code = self.room(2)
        self.start(clients)
        self.emit(clients[1], 'failed', dict(epoch=0, message='WASM exception'))
        room = self.events(clients[0], 'lobby_returned')[0]
        self.assertEqual((room['code'], room['epoch'], room['phase']), (code, 1, 'lobby'))
        self.assertEqual(room['interruption']['reason'], 'runtime_failure')
        self.assertEqual(room['players'], 2)
        self.emit(clients[1], 'failed', dict(epoch=0, message='Late exception'))
        self.emit(clients[1], 'failed', dict(epoch=1, message='No running game'))
        self.assertFalse(self.events(clients[0], 'stopped'))

    def test_departed_host_leaves_usable_lobby_for_remaining_players(self):
        clients, code = self.room(3)
        self.start(clients)
        self.emit(clients[0], 'leave')
        room = self.events(clients[1], 'lobby_returned')[0]
        self.assertEqual((room['code'], room['epoch'], room['phase']), (code, 1, 'lobby'))
        self.assertEqual(room['interruption']['reason'], 'player_left')
        self.assertEqual([p['slot'] for p in room['members']], [0, 1])
        self.assertEqual(room['host'], room['members'][0]['id'])
        self.assertTrue(all(not p['ready'] for p in room['members']))
        for client in clients[1:]:
            self.emit(client, 'ready', dict(ready=True))
        self.emit(clients[1], 'start_game')
        self.assertEqual(self.events(clients[1], 'prepare')[0]['epoch'], 1)


if __name__ == '__main__':
    unittest.main()
