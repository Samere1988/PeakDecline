"""Reload recovery journal, authorization and replay barrier regression tests."""
import unittest
from unittest.mock import patch
import marioparty_netplay_test as fixture
from retro_package.party_history import PartyHistory, MAX_FRAMES


class Journal(unittest.TestCase):
    def test_chunks_extremes_bounds_and_close(self):
        history = PartyHistory(4)
        self.addCleanup(history.close)
        pads = [dict(buttons=65535, x=-80, y=80)] * 4
        for frame in range(1, 1302):
            history.append(frame, pads)
        self.assertEqual(len(history.packet(1, 9)['frames']), 600)
        self.assertEqual(history.packet(1201, 9)['frames'][-1], dict(epoch=9, frame=1301, pads=pads))
        self.assertEqual(history.packet(1302, 9)['frames'], [])
        for start in (True, 0, -1, 1303, '1'):
            self.assertIsNone(history.packet(start, 9))
        with self.assertRaises(ValueError):
            history.append(1303, pads)
        history.frame = MAX_FRAMES
        with self.assertRaises(ValueError):
            history.append(MAX_FRAMES+1, pads)


class Reload(unittest.TestCase):
    setUp = fixture.PartyNetwork.setUp
    close_clients = fixture.PartyNetwork.close_clients
    connect = fixture.PartyNetwork.connect
    emit = fixture.PartyNetwork.emit
    events = fixture.PartyNetwork.events
    launch = fixture.PartyNetwork.launch

    def resume_fresh(self, client, seat=0):
        self.emit(client, 'resume', dict(code=self.code, token=self.seats[seat]['resumeToken'],
            compatibility=self.descriptor, retained=False))

    def replay(self, client, through):
        for start in range(1, through+1, 600):
            self.emit(client, 'party_replay', dict(epoch=0, start=start))
            event = self.events(client, 'party_history')[0]
            self.assertEqual(event['start'], start)
            self.assertEqual(event['through'], through)
            self.assertEqual(len(event['frames']), min(600, through-start+1))

    def test_full_journal_reload_checksum_and_seat_barrier_for_both_games(self):
        for game in ('marioparty','marioparty2'):
            with self.subTest(game=game):
                players = self.launch(game)
                pads = [dict(buttons=i+1, x=i*10, y=-i*10) for i in range(4)]
                for frame in range(1,1302):
                    for i, player in enumerate(players):
                        self.emit(player, 'input', dict(epoch=0,frame=frame,pad=pads[i]))
                    if frame == 1259:
                        for player in players:
                            self.emit(player, 'hash', dict(epoch=0,frame=frame,hash=12345))
                    for player in players:
                        player.get_received('/retro')
                players[0].disconnect(namespace='/retro')
                replacement = self.connect(game+'0')
                self.resume_fresh(replacement)
                events = replacement.get_received('/retro')
                prepare = next(e['args'][0] for e in events if e['name']=='prepare')
                self.assertEqual(prepare['recovery'],dict(through=1301,checkpointFrame=1259))
                self.assertTrue(prepare['paused'])
                self.assertIn('initialSave',prepare)
                # No data or release until the fresh module loads and fetches history.
                self.emit(replacement,'party_replay',dict(epoch=0,start=1))
                self.assertFalse(self.events(replacement,'party_history'))
                self.emit(replacement,'loaded',dict(epoch=0,compatibility=self.descriptor))
                self.assertTrue(self.events(replacement,'start')[0]['paused'])
                self.emit(replacement,'party_replay_ready',dict(epoch=0,frame=1301,hash=12345))
                self.assertFalse(self.events(replacement,'party_live'))
                self.emit(replacement,'party_replay',dict(epoch=0,start=601))
                self.assertTrue(self.events(replacement,'room_error'))
                self.replay(replacement,1301)
                self.emit(replacement,'party_replay_ready',dict(epoch=0,frame=1301,hash=999))
                self.assertTrue(self.events(replacement,'stopped'))
                for player in players[1:]:
                    self.assertFalse(self.events(player,'stopped'))
                # A failed reconstruction can retry without replacing the match.
                retry=self.connect(game+'0')
                self.resume_fresh(retry)
                self.events(retry,'prepare')
                self.emit(retry,'loaded',dict(epoch=0,compatibility=self.descriptor))
                self.replay(retry,1301)
                self.emit(retry,'party_replay_ready',dict(epoch=0,frame=1301,hash=12345))
                self.assertFalse(self.events(retry,'party_live')[0]['paused'])
                for player in players[1:]:
                    self.assertTrue(self.events(player,'transport_resumed'))
                for i, player in enumerate([retry,*players[1:]]):
                    self.emit(player,'input',dict(epoch=0,frame=1302,pad=pads[i]))
                self.assertEqual(self.events(retry,'frameset')[0]['pads'],pads)
                self.close_clients()

    def test_reload_can_replace_old_connected_socket_but_not_another_account(self):
        for game in ('marioparty','marioparty2'):
            with self.subTest(game=game):
                players=self.launch(game)
                intruder=self.connect('intruder')
                self.resume_fresh(intruder)
                self.assertTrue(self.events(intruder,'room_error'))
                self.assertFalse(self.events(players[0],'stopped'))
                replacement=self.connect(game+'0')
                self.resume_fresh(replacement)
                self.assertTrue(self.events(players[0],'stopped'))
                self.assertTrue(self.events(replacement,'prepare'))
                self.emit(replacement,'loaded',dict(epoch=0,compatibility=self.descriptor))
                self.emit(replacement,'party_replay',dict(epoch=0,start=1))
                self.assertEqual(self.events(replacement,'party_history')[0]['frames'],[])
                self.emit(replacement,'party_replay_ready',dict(epoch=0,frame=0,hash=None))
                self.assertTrue(self.events(replacement,'party_live'))
                self.close_clients()

    def test_two_fresh_players_wait_for_both_replays_and_failure_is_isolated(self):
        for game in ('marioparty','marioparty2'):
            with self.subTest(game=game):
                players=self.launch(game)
                for player in players[:2]:
                    player.disconnect(namespace='/retro')
                replacements=[]
                for seat in range(2):
                    player=self.connect(game+str(seat));replacements.append(player)
                    self.resume_fresh(player,seat)
                    self.events(player,'prepare')
                    self.emit(player,'loaded',dict(epoch=0,compatibility=self.descriptor))
                    self.emit(player,'party_replay',dict(epoch=0,start=1))
                    self.events(player,'party_history')
                self.emit(replacements[0],'party_replay_ready',dict(epoch=0,frame=0,hash=None))
                self.assertTrue(self.events(replacements[0],'party_live')[0]['paused'])
                self.emit(replacements[1],'failed',dict(epoch=0,message='Replay initialization failed'))
                for player in [replacements[0],*players[2:]]:
                    events=player.get_received('/retro')
                    self.assertFalse(any(e['name'] in ('stopped','transport_resumed') for e in events))
                retry=self.connect(game+'1')
                self.resume_fresh(retry,1);self.events(retry,'prepare')
                self.emit(retry,'loaded',dict(epoch=0,compatibility=self.descriptor))
                self.emit(retry,'party_replay',dict(epoch=0,start=1));self.events(retry,'party_history')
                self.emit(retry,'party_replay_ready',dict(epoch=0,frame=0,hash=None))
                self.assertFalse(self.events(retry,'party_live')[0]['paused'])
                for player in [replacements[0],*players[2:]]:
                    self.assertTrue(self.events(player,'transport_resumed'))
                self.close_clients()


if __name__=='__main__':
    unittest.main()
