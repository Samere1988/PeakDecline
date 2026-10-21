"""Lockstep peer-input rendezvous, relay window and seat recovery, without production state."""
import unittest
import marioparty_netplay_test as party
from retro_package.catalog import GAMES


class LockstepPeerTests(party.PartyNetwork):
    def setUp(self):
        super().setUp()
        self.descriptor.update(lockstep=dict(peerInputs=True))
        self.app.config['NETPLAY_ICE_SERVERS'] = []

    def test_catalog_opts_in_lockstep_games(self):
        for game in ('fzerox', 'marioparty', 'marioparty2'):
            self.assertTrue(GAMES[game].peer_inputs)
            self.assertEqual(GAMES[game].backend, 'recomp-ring-lockstep-v1')

    def test_compatibility_requires_matching_peer_mode(self):
        player = self.connect('mismatch')
        self.emit(player, 'create', dict(name='x', gameId='fzerox', compatibility=dict(self.descriptor, lockstep=None)))
        self.assertFalse(self.events(player, 'room'))

    def test_signaling_window_and_retained_reconnect(self):
        players = self.launch('marioparty')
        for player in players:
            player.get_received('/retro')
            self.emit(player, 'rollback_connect', {'epoch': 0})
        rosters = [self.events(player, 'rollback_transport')[0] for player in players]
        self.assertEqual([r['slot'] for r in rosters], [0, 1, 2, 3])
        self.assertEqual(set(rosters[3]['peers']), {0, 1, 2, 3})
        self.emit(players[0], 'rollback_signal', dict(epoch=0, to=2, type='offer', value='v=0'))
        self.assertEqual(self.events(players[2], 'rollback_signal')[0]['from'], 0)
        # Peer rows may lead the TCP journal; the relay accepts the 128-frame horizon.
        pad = dict(buttons=4, x=0, y=0)
        self.emit(players[0], 'input', dict(epoch=0, frame=128, pad=pad))
        self.emit(players[0], 'input', dict(epoch=0, frame=129, pad=pad))
        room = next(iter(relay_rooms(self)))
        self.assertIn(128, room['inputs']); self.assertNotIn(129, room['inputs'])
        # A retained tab reconnects with a new sid and keeps signaling rights.
        players[1].disconnect(namespace='/retro')
        replacement = self.connect('marioparty1')
        self.emit(replacement, 'resume', dict(code=self.code, token=self.seats[1]['resumeToken'],
            compatibility=self.descriptor, retained=True, epoch=0, frame=0))
        self.assertTrue(self.events(replacement, 'resumed'))
        self.assertFalse(self.events(players[0], 'rollback_peer'), 'a retained transport is not a new peer')
        self.emit(replacement, 'rollback_signal', dict(epoch=0, to=0, type='answer', value='v=0'))
        self.assertEqual(self.events(players[0], 'rollback_signal')[0]['from'], 1)
        self.close_clients()

    def test_without_peer_mode_signaling_is_rejected(self):
        self.descriptor.pop('lockstep')
        players = self.launch('marioparty')
        for player in players:
            self.emit(player, 'rollback_connect', {'epoch': 0})
            self.assertFalse(self.events(player, 'rollback_transport'))
        self.emit(players[0], 'input', dict(epoch=0, frame=17, pad=dict(buttons=0, x=0, y=0)))
        self.assertNotIn(17, next(iter(relay_rooms(self)))['inputs'])
        self.close_clients()

    def test_reloaded_tab_keeps_inputs_others_may_have_consumed(self):
        players = self.launch('marioparty')
        for player in players:
            self.emit(player, 'rollback_connect', {'epoch': 0})
        pads = [dict(buttons=1 << i, x=0, y=0) for i in range(4)]
        for slot, player in enumerate(players):
            self.emit(player, 'input', dict(epoch=0, frame=1, pad=pads[slot]))
        # Seat 2's next inputs reached the relay; seat 3's journal is behind
        # (others may have its copies). Frame 5 follows a gap and is discarded.
        for frame in (2, 3, 5):
            self.emit(players[2], 'input', dict(epoch=0, frame=frame, pad=pads[2]))
        room = next(iter(relay_rooms(self)))
        self.assertEqual(room['completed'], 1)
        replacement = self.connect('marioparty2')
        self.emit(replacement, 'resume', dict(code=self.code, token=self.seats[2]['resumeToken'],
            compatibility=self.descriptor, retained=False))
        self.assertEqual(self.events(replacement, 'prepare')[0]['recovery'], dict(through=1, checkpointFrame=0))
        self.assertEqual([room['inputs'][f][2] for f in (2, 3, 5)], [pads[2]] * 3, 'kept until the new tab is live')
        self.assertNotIn(self.seats[2]['memberId'], room.get('rollback_peers', set()))
        self.emit(replacement, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.emit(replacement, 'party_replay', dict(epoch=0, start=1))
        self.assertEqual([r['frame'] for r in self.events(replacement, 'party_history')[0]['frames']], [1])
        self.emit(replacement, 'party_replay_ready', dict(epoch=0, frame=1, hash=None))
        live = self.events(replacement, 'party_live')[0]
        self.assertEqual((live['completed'], live['inputsThrough']), (1, 3))
        self.assertEqual([room['inputs'][f][2] for f in (2, 3, 5)], [pads[2], pads[2], None], 'inputs after a gap are discarded')
        # The new tab continues after its retained inputs and joins as a new peer.
        for player in players:
            player.get_received('/retro')
        self.emit(replacement, 'rollback_connect', {'epoch': 0})
        for player in (players[0], players[1], players[3]):
            self.assertEqual(self.events(player, 'rollback_peer'), [dict(epoch=0, slot=2)])
        for frame in (2, 3):
            for slot in (0, 1, 3):
                self.emit(players[slot], 'input', dict(epoch=0, frame=frame, pad=pads[slot]))
        self.emit(replacement, 'input', dict(epoch=0, frame=4, pad=pads[2]))
        self.assertEqual([p['frame'] for p in self.events(players[0], 'frameset')], [2, 3])
        self.assertFalse(self.events(players[0], 'stopped'))
        self.close_clients()


    def test_witnessed_rows_keep_a_closed_tabs_consumed_inputs(self):
        players = self.launch('marioparty')
        pads = [dict(buttons=1 << i, x=i, y=-i) for i in range(4)]
        room = next(iter(relay_rooms(self)))
        witness = lambda frames, slot=0: dict(epoch=0, rows=[dict(frame=f, pads=[dict(p) for p in pads]) for f in frames])
        # Seat 1 is connected and missing: witnesses never fill a live seat.
        self.emit(players[1], 'lockstep_witness', witness([1]))
        self.assertNotIn(1, room['inputs'], 'only a paused match accepts witnessed rows')
        for slot in (1, 2, 3):
            self.emit(players[slot], 'input', dict(epoch=0, frame=1, pad=pads[slot]))
        # Seat 0's tab closes; its frame 1 and 2 inputs reached others only by RTC.
        players[0].disconnect(namespace='/retro')
        for bad in (dict(epoch=1, rows=[]), dict(epoch=0, rows=[dict(frame=0, pads=pads)]),
                    dict(epoch=0, rows=[dict(frame=1, pads=pads[:3])]), dict(epoch=0, rows=[dict(frame=1, pads=[dict(buttons=-1, x=0, y=0)] * 4)]),
                    dict(epoch=0, rows=[dict(frame=200, pads=pads)]), dict(epoch=0, rows='x')):
            self.emit(players[1], 'lockstep_witness', bad)
        self.assertEqual(room['inputs'][1][0], None)
        self.emit(players[1], 'lockstep_witness', witness([1, 2]))
        self.assertEqual(room['inputs'][1], pads)
        self.assertEqual(room['inputs'][2], [pads[0], None, None, None], 'connected seats submit their own inputs')
        self.emit(players[2], 'lockstep_witness', witness([1]))
        self.assertFalse(self.events(players[2], 'stopped'), 'an identical witness is accepted')
        replacement = self.connect('marioparty0')
        self.emit(replacement, 'resume', dict(code=self.code, token=self.seats[0]['resumeToken'],
            compatibility=self.descriptor, retained=False))
        self.emit(replacement, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.emit(replacement, 'party_replay', dict(epoch=0, start=1))
        self.emit(replacement, 'party_replay_ready', dict(epoch=0, frame=0, hash=None))
        live = self.events(replacement, 'party_live')[0]
        self.assertEqual((live['completed'], live['inputsThrough']), (0, 2))
        self.assertEqual([p['frame'] for p in self.events(players[1], 'frameset')], [1])
        # After resuming, a contradicting witness for another absence stops the match.
        players[3].disconnect(namespace='/retro')
        changed = [dict(p) for p in pads]; changed[0] = dict(buttons=99, x=0, y=0)
        self.emit(players[1], 'lockstep_witness', dict(epoch=0, rows=[dict(frame=2, pads=changed)]))
        self.assertIn('Conflicting', self.events(players[1], 'stopped')[0]['message'])
        self.close_clients()


def relay_rooms(test):
    """The registered handlers close over the room table; reach it through a handler cell."""
    handler = test.sio.server.handlers['/retro']['input']
    while hasattr(handler, '__wrapped__'):
        handler = handler.__wrapped__
    cells = {name: cell.cell_contents for name, cell in zip(handler.__code__.co_freevars, handler.__closure__ or ())}
    return cells['rooms'].values()


if __name__ == '__main__':
    unittest.main()
