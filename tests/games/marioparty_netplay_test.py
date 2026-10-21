"""Both Mario Party registrations exercised with four authenticated socket seats."""
import unittest
from unittest.mock import patch
import retro_test as fixture


class PartyNetwork(unittest.TestCase):
    def setUp(self):
        fixture.RetroTests.setUp(self)
        background = patch.object(self.sio, 'start_background_task')
        self.background = background.start()
        self.addCleanup(background.stop)
    close_clients = fixture.RetroTests.close_clients
    connect = fixture.RetroTests.connect
    emit = fixture.RetroTests.emit
    events = fixture.RetroTests.events

    def launch(self, game):
        self.descriptor.update(id=game, adapter=game, tickRate=60, backend=fixture.GAMES[game].backend)
        players = [self.connect(game + str(i)) for i in range(4)]
        self.emit(players[0], 'create', dict(name=game, gameId=game, compatibility=self.descriptor))
        self.seats = [self.events(players[0], 'room')[0]]
        code = self.code = self.seats[0]['code']
        for player in players[1:]:
            self.emit(player, 'join', dict(code=code, compatibility=self.descriptor))
            self.seats.append(self.events(player, 'room')[0])
            self.emit(player, 'role', dict(role='player'))
        for player in players:
            self.emit(player, 'ready', dict(ready=True))
        self.emit(players[0], 'start_game')
        for player in players[:3]:
            self.emit(player, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.assertFalse(self.events(players[0], 'start'))
        self.emit(players[3], 'loaded', dict(epoch=0, compatibility=self.descriptor))
        for player in players:
            self.assertEqual(len(self.events(player, 'start')), 1)
        return players

    def test_four_seat_ordering_duplicate_delay_restart_and_desync(self):
        for game in ('marioparty', 'marioparty2'):
            with self.subTest(game=game):
                players = self.launch(game)
                pads = [dict(buttons=1 << i, x=i*20, y=-i*20) for i in range(4)]
                # Complete future rows first; no peer can bypass the missing seat/frame.
                for frame in (3, 2, 1):
                    for slot in (2, 0, 1):
                        for _ in range(2):
                            self.emit(players[slot], 'input', dict(epoch=0, frame=frame, pad=pads[slot]))
                for player in players:
                    self.assertFalse(self.events(player, 'frameset'))
                for frame in (3, 2, 1):
                    self.emit(players[3], 'input', dict(epoch=0, frame=frame, pad=pads[3]))
                for player in players:
                    packets = self.events(player, 'frameset')
                    self.assertEqual([p['frame'] for p in packets], [1, 2, 3])
                    self.assertTrue(all(p['pads'] == pads for p in packets))
                for player in players:
                    self.emit(player, 'hash', dict(epoch=0, frame=3, hash=123))
                for player in players:
                    self.assertFalse(self.events(player, 'stopped'))
                self.emit(players[0], 'restart_game')
                for player in players:
                    self.assertEqual(self.events(player, 'prepare')[0]['epoch'], 1)
                    self.emit(player, 'loaded', dict(epoch=1, compatibility=self.descriptor))
                for player in players:
                    player.get_received('/retro')
                    self.emit(player, 'input', dict(epoch=0, frame=1, pad=pads[0]))
                    self.emit(player, 'hash', dict(epoch=0, frame=1, hash=999))
                for player in players:
                    self.assertFalse(self.events(player, 'frameset'))
                for slot, player in enumerate(players):
                    self.emit(player, 'input', dict(epoch=1, frame=1, pad=pads[slot]))
                for player in players:
                    self.assertEqual(self.events(player, 'frameset')[0]['pads'], pads)
                for slot, player in enumerate(players):
                    self.emit(player, 'hash', dict(epoch=1, frame=1, hash=123 + (slot == 3)))
                for player in players:
                    self.assertIn('desynchronized', self.events(player, 'stopped')[0]['message'])
                self.close_clients()

    def test_disconnect_pauses_and_reconnects_without_deadline(self):
        from retro_package import rooms as relay
        for game in ('marioparty', 'marioparty2'):
            with self.subTest(game=game):
                players = self.launch(game)
                pad = dict(buttons=128, x=30, y=-40)
                for player in players:
                    self.emit(player, 'input', dict(epoch=0, frame=1, pad=pad))
                for player in players:
                    self.events(player, 'frameset')
                self.emit(players[0], 'hash', dict(epoch=0, frame=1, hash=123))
                self.emit(players[0], 'input', dict(epoch=0, frame=2, pad=pad))
                players[0].disconnect(namespace='/retro')
                timeout, *args = self.background.call_args.args
                for player in players[1:]:
                    self.assertTrue(self.events(player, 'transport_paused'))
                    self.emit(player, 'input', dict(epoch=0, frame=2, pad=pad))
                    self.assertFalse(self.events(player, 'frameset'))
                with patch.object(self.sio, 'sleep'):
                    timeout(*args)
                for player in players[1:]:
                    self.assertFalse(self.events(player, 'stopped'))
                replacement = self.connect(game + '0')
                payload = dict(code=self.code, token=self.seats[0]['resumeToken'],
                               compatibility=self.descriptor, retained=True, epoch=0, frame=0)
                intruder = self.connect('intruder-' + game)
                self.emit(intruder, 'resume', payload)
                self.assertTrue(self.events(intruder, 'room_error'))
                for override in (dict(retained='invalid'), dict(epoch=1), dict(frame=99), dict(frame=True)):
                    self.emit(replacement, 'resume', dict(payload, **override))
                    self.assertTrue(self.events(replacement, 'room_error'))
                with patch.object(relay, 'monotonic', return_value=relay.monotonic() + 3600):
                    self.emit(replacement, 'resume', payload)
                packets = replacement.get_received('/retro')
                resumed = next(p['args'][0] for p in packets if p['name'] == 'resumed')
                self.assertFalse(resumed['paused'])
                self.assertEqual(resumed['completed'], 1)
                self.assertEqual([p['frame'] for p in resumed['frames']], [1])
                self.assertEqual([p['args'][0]['frame'] for p in packets if p['name'] == 'frameset'], [2])
                self.assertEqual(resumed['members'][0]['slot'], 0)
                for player in players[1:]:
                    self.emit(player, 'hash', dict(epoch=0, frame=1, hash=123))
                for player in [replacement, *players[1:]]:
                    self.assertFalse(self.events(player, 'stopped'))
                self.close_clients()

    def test_every_missing_player_must_return_and_connected_host_can_end_pause(self):
        for game in ('marioparty', 'marioparty2'):
            with self.subTest(game=game):
                players = self.launch(game)
                for player in players[:2]:
                    player.disconnect(namespace='/retro')
                replacement = self.connect(game + '0')
                self.emit(replacement, 'resume', dict(code=self.code, token=self.seats[0]['resumeToken'],
                    compatibility=self.descriptor, retained=True, epoch=0, frame=0))
                self.assertTrue(self.events(replacement, 'resumed')[0]['paused'])
                self.assertFalse(self.events(players[2], 'transport_resumed'))
                second = self.connect(game + '1')
                self.emit(second, 'resume', dict(code=self.code, token=self.seats[1]['resumeToken'],
                    compatibility=self.descriptor, retained=True, epoch=0, frame=0))
                self.assertFalse(self.events(second, 'resumed')[0]['paused'])
                self.assertTrue(self.events(players[2], 'transport_resumed'))
                second.disconnect(namespace='/retro')
                self.emit(players[2], 'return_lobby')
                room = self.events(players[2], 'lobby_returned')[0]
                self.assertEqual(room['phase'], 'lobby')
                self.assertEqual(room['players'], 3)
                self.close_clients()

    def test_abandoned_room_is_cleaned_up(self):
        for game in ('marioparty', 'marioparty2'):
            with self.subTest(game=game):
                players = self.launch(game)
                for player in players:
                    player.disconnect(namespace='/retro')
                timeout, *args = self.background.call_args.args
                with patch.object(self.sio, 'sleep'):
                    timeout(*args)
                observer = self.connect('observer-' + game)
                self.emit(observer, 'list')
                self.assertEqual(self.events(observer, 'rooms')[-1], [])
                self.close_clients()


if __name__ == '__main__':
    unittest.main()
