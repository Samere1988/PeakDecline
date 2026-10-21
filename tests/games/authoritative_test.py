"""Authority relay boundaries and authenticated Socket.IO integration."""
import unittest
from retro_test import RetroTests
from retro_package.authoritative import AuthorityRelay, valid_state


CONFIG = dict(historyTicks=120, maxPending=64, maxRewindTicks=12, snapshotInterval=3, interpolationTicks=6)
COMMAND = dict(buttons=0, moveX=60, moveY=0, lookX=0, lookY=0)


class RelayTests(unittest.TestCase):
    def test_deltas_and_events_are_atomic(self):
        relay = AuthorityRelay(1, 60, CONFIG, clock=lambda: 0)
        self.assertIsNotNone(relay.snapshot(dict(tick=0, acks=[0], state={'player': 0, 'gone': 1})))
        event = dict(id=1, tick=1, type='shot', data={'weapon': 1}, prediction='0:1:muzzle')
        packet = dict(tick=1, acks=[0], baseTick=0, changed={'player': 1}, removed=['gone'], events=[event])
        self.assertIsNone(relay.snapshot({**packet, 'baseTick': 5}))
        self.assertIsNone(relay.snapshot({**packet, 'events': [{**event, 'id': 2}]}))
        self.assertEqual(relay.tick, 0)
        self.assertIsNotNone(relay.snapshot(packet))
        self.assertEqual(relay.state, {'player': 1})
        self.assertIsNone(relay.snapshot(dict(tick=2, acks=[0], state={}, events=[event])))
        self.assertEqual(relay.event_id, 1)
        self.assertIsNotNone(relay.snapshot(dict(tick=2, acks=[0], state={'player': 2})))

    def test_recovery_keeps_events_and_bounds_expired_cosmetic_history(self):
        relay=AuthorityRelay(1,60,CONFIG,clock=lambda:1000)
        self.assertIsNotNone(relay.snapshot(dict(tick=0,acks=[0],state={'x':0})))
        event=dict(id=1,tick=1,type='shot',data={'weapon':1})
        self.assertIsNotNone(relay.snapshot(dict(tick=1,acks=[0],state={'x':1},events=[event])))
        checkpoint=relay.recovery(0)
        self.assertEqual(checkpoint['state'],{'x':1})
        self.assertEqual(checkpoint['events'],[event])
        self.assertEqual(checkpoint['eventCursor'],1)
        self.assertIsNone(relay.recovery(2))
        self.assertIsNone(relay.recovery(True))
        relay.event_history.clear();relay.event_history_bytes=0
        checkpoint=relay.recovery(0)
        self.assertTrue(checkpoint['resetEffects'])
        self.assertNotIn('events',checkpoint)
        self.assertEqual(checkpoint['state'],{'x':1})

    def test_bounds_and_state_validation(self):
        relay = AuthorityRelay(2, 60, CONFIG, clock=lambda: 0)
        self.assertIsNone(relay.snapshot(dict(tick=100, acks=[0, 0], state={})))
        self.assertIsNotNone(relay.snapshot(dict(tick=0, acks=[0, 0], state={})))
        self.assertIsNone(relay.command(0, dict(seq=1, viewTick=1, command=COMMAND)))
        self.assertIsNone(relay.command(0, dict(seq=True, viewTick=0, command=COMMAND)))
        self.assertIsNotNone(relay.command(0, dict(seq=1, viewTick=0, command=COMMAND)))
        self.assertIsNone(relay.command(0, dict(seq=1, viewTick=0, command=COMMAND)))
        self.assertIsNone(relay.snapshot(dict(tick=1, acks=[2, 0], state={})))
        self.assertIsNotNone(relay.snapshot(dict(tick=1, acks=[1, 0], state={})))
        for seq in range(2, 66):
            self.assertIsNotNone(relay.command(0, dict(seq=seq, viewTick=0, command=COMMAND)))
        self.assertIsNone(relay.command(0, dict(seq=66, viewTick=0, command=COMMAND)))
        self.assertFalse(valid_state({'bad': float('nan')}))
        self.assertFalse(valid_state({'bad': float('inf')}))
        self.assertFalse(valid_state({'big': ['a' * 4000] * 20}))
        nested = {}
        for _ in range(15):
            nested = {'nested': nested}
        self.assertFalse(valid_state(nested))


class RoomTests(unittest.TestCase):
    # Reuse the isolated fixture helpers without inheriting unrelated test cases.
    setUp = RetroTests.setUp
    close_clients = RetroTests.close_clients
    connect = RetroTests.connect
    emit = RetroTests.emit
    events = RetroTests.events
    room = RetroTests.room
    start = RetroTests.start

    def fps_room(self):
        self.descriptor.update(backend='authoritative-host-v1', inputSchema='fps-command-v1', tickRate=60,
                               authoritative=CONFIG)
        clients, code = self.room(2)
        watcher = self.connect('watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.start(clients + [watcher])
        for peer in clients + [watcher]:
            peer.get_received('/retro')
        return clients, watcher

    def resumable_room(self):
        self.descriptor.update(backend='authoritative-host-v1', inputSchema='fps-command-v1',tickRate=60,authoritative=CONFIG)
        host=self.connect('resume-host')
        self.emit(host,'create',dict(gameId='mk64',name='Recoverable',compatibility=self.descriptor))
        host_room=self.events(host,'room')[0]
        guest=self.connect('resume-guest')
        self.emit(guest,'join',dict(code=host_room['code'],compatibility=self.descriptor))
        guest_room=self.events(guest,'room')[0]
        self.emit(guest,'role',dict(role='player'))
        for peer in (host,guest):self.emit(peer,'ready',dict(ready=True))
        self.start([host,guest])
        self.emit(host,'world_snapshot',dict(epoch=0,tick=0,acks=[0,0],state={'world':0}))
        for peer in (host,guest):peer.get_received('/retro')
        return host,guest,host_room,guest_room

    def test_authenticated_seat_resume_preserves_slot_and_running_session(self):
        host,guest,_,seat=self.resumable_room()
        guest.disconnect(namespace='/retro')
        self.assertFalse(self.events(host,'stopped'))
        attacker=self.connect('wrong-user')
        request=dict(code=seat['code'],token=seat['resumeToken'],compatibility=self.descriptor,retained=True)
        self.emit(attacker,'resume',request)
        self.assertTrue(self.events(attacker,'room_error'))
        replacement=self.connect('resume-guest')
        self.emit(replacement,'resume',request)
        resumed=self.events(replacement,'resumed')[0]
        self.assertEqual(resumed['phase'],'running')
        self.assertEqual(next(m for m in resumed['members'] if m['id']==resumed['memberId'])['slot'],1)
        self.assertEqual(resumed['baseline']['tick'],0)
        self.emit(replacement,'fps_command',dict(epoch=0,seq=1,viewTick=0,command=COMMAND))
        self.assertEqual(self.events(host,'fps_command')[0]['slot'],1)
        duplicate=self.connect('resume-guest')
        self.emit(duplicate,'resume',request)
        self.assertTrue(self.events(duplicate,'room_error'),'A resume token cannot take over an already connected seat')

    def test_host_transport_resume_replays_only_unacknowledged_commands(self):
        host,guest,seat,_=self.resumable_room()
        self.emit(guest,'fps_command',dict(epoch=0,seq=1,viewTick=0,command=COMMAND))
        self.events(host,'fps_command')
        host.disconnect(namespace='/retro')
        self.assertEqual(self.events(guest,'transport_paused'),[dict(epoch=0)])
        self.emit(guest,'fps_command',dict(epoch=0,seq=2,viewTick=0,command=COMMAND))
        replacement=self.connect('resume-host')
        request=dict(code=seat['code'],token=seat['resumeToken'],compatibility=self.descriptor,retained=False)
        self.emit(replacement,'resume',request)
        self.assertTrue(self.events(replacement,'room_error'),'A new host engine cannot masquerade as the retained authority')
        self.emit(replacement,'resume',{**request,'retained':True})
        packets=replacement.get_received('/retro')
        resumed=next(p['args'][0] for p in packets if p['name']=='resumed')
        self.assertEqual(resumed['received'],[0,1],'Commands sent while host was offline must be retried, not silently accepted')
        commands=[p['args'][0] for p in packets if p['name']=='fps_command']
        self.assertEqual([p['seq'] for p in commands],[1])
        self.assertEqual(self.events(guest,'transport_resumed')[0]['received'],[0,1])
        self.emit(replacement,'world_snapshot',dict(epoch=0,tick=1,acks=[0,1],state={'world':1}))
        self.assertEqual(self.events(guest,'world_snapshot')[0]['tick'],1)

    def test_guest_refresh_bootstraps_player_with_existing_sequence(self):
        host,guest,_,seat=self.resumable_room()
        self.emit(guest,'fps_command',dict(epoch=0,seq=1,viewTick=0,command=COMMAND))
        guest.disconnect(namespace='/retro')
        replacement=self.connect('resume-guest')
        self.emit(replacement,'resume',dict(code=seat['code'],token=seat['resumeToken'],compatibility=self.descriptor,retained=False))
        packets=replacement.get_received('/retro')
        prepare=next(p['args'][0] for p in packets if p['name']=='prepare')
        self.assertEqual(prepare['resumeSequence'],1)
        self.emit(replacement,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.assertEqual(self.events(replacement,'world_bootstrap')[0]['tick'],0)
        self.emit(replacement,'fps_command',dict(epoch=0,seq=2,viewTick=0,command=COMMAND))
        self.assertEqual(self.events(host,'fps_command')[-1]['seq'],2)

    def test_guest_leaving_keeps_game_running_and_restart_drops_absent_seat(self):
        host,guest,_,seat=self.resumable_room()
        self.emit(guest,'leave')
        packets=host.get_received('/retro')
        self.assertFalse(any(p['name']=='stopped' for p in packets))
        room=next(p['args'][0] for p in packets if p['name']=='room_update')
        self.assertEqual(room['phase'],'running')
        self.assertEqual(room['players'],2)
        self.assertFalse(next(p for p in room['members'] if p['slot']==1)['connected'])
        self.emit(guest,'resume',dict(code=seat['code'],token=seat['resumeToken'],compatibility=self.descriptor,retained=True))
        self.assertTrue(self.events(guest,'room_error'),'Leaving deliberately revokes the resume credential')
        self.emit(host,'world_snapshot',dict(epoch=0,tick=1,acks=[0,0],state={'world':1}))
        self.assertEqual(self.events(host,'world_snapshot')[-1]['tick'],1)
        self.assertFalse(self.events(guest,'world_snapshot'),'Departed users must leave the broadcast room')
        self.emit(host,'restart_game')
        prepared=self.events(host,'prepare')[0]
        self.assertEqual(prepared['epoch'],1)
        self.assertEqual(prepared['players'],1)
        self.emit(host,'loaded',dict(epoch=1,compatibility=self.descriptor))
        self.assertEqual(self.events(host,'start')[0]['phase'],'running')

    def test_spectator_joins_running_world_without_restarting_players(self):
        (authority, guest), watcher = self.fps_room()
        self.emit(authority, 'world_snapshot', dict(epoch=0,tick=0,acks=[0,0],state={'world':0}))
        self.emit(authority, 'world_snapshot', dict(epoch=0,tick=1,acks=[0,0],state={'world':1},
            events=[dict(id=1,tick=1,type='explosion',data={'x':3})]))
        self.emit(authority, 'list')
        code = self.events(authority,'rooms')[-1][0]['code']
        late = self.connect('late-spectator')
        self.emit(late,'join',dict(code=code,compatibility=self.descriptor))
        packets=late.get_received('/retro')
        self.assertEqual([p['name'] for p in packets].count('prepare'),1)
        self.assertEqual(next(p['args'][0] for p in packets if p['name']=='room')['phase'],'running')
        self.assertFalse(self.events(authority,'prepare'),'An existing engine must not restart for a new viewer')
        self.emit(authority,'world_snapshot',dict(epoch=0,tick=2,acks=[0,0],baseTick=1,changed={'world':2},removed=[]))
        self.assertFalse(self.events(late,'world_snapshot'),'Unloaded viewers cannot receive unusable deltas')
        self.emit(late,'loaded',dict(epoch=0,compatibility=self.descriptor))
        packets=late.get_received('/retro')
        relevant=[p for p in packets if p['name'] in ('start','world_bootstrap')]
        self.assertEqual([p['name'] for p in relevant],['start','world_bootstrap'])
        self.assertEqual(relevant[1]['args'][0],dict(epoch=0,tick=2,acks=[0,0],state={'world':2},eventCursor=1))
        self.emit(late,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.assertFalse(self.events(late,'world_bootstrap'),'Duplicate readiness must not reset the event cursor')
        self.emit(late,'fps_command',dict(epoch=0,seq=1,viewTick=2,command=COMMAND))
        self.assertFalse(self.events(authority,'fps_command'))
        self.emit(late,'world_snapshot',dict(epoch=0,tick=3,acks=[0,0],state={'world':999}))
        self.assertFalse(self.events(authority,'world_snapshot'))
        self.emit(authority,'world_snapshot',dict(epoch=0,tick=3,acks=[0,0],baseTick=2,changed={'world':3},removed=[],
            events=[dict(id=2,tick=3,type='shot',data={'x':4})]))
        self.assertEqual(self.events(late,'world_snapshot')[0]['events'][0]['id'],2)
        self.emit(late,'leave')
        self.assertFalse(self.events(guest,'stopped'),'A viewer leaving must not stop play')

    def test_authority_identity_spectators_and_restart(self):
        (authority, guest), watcher = self.fps_room()
        initial = dict(epoch=0, tick=0, acks=[0, 0], state={'players': [{'x': 0}, {'x': 0}]})
        for impostor in (guest, watcher):
            self.emit(impostor, 'world_snapshot', initial)
        self.assertFalse(self.events(authority, 'world_snapshot'))
        self.emit(authority, 'world_snapshot', initial)
        for peer in (authority, guest, watcher):
            self.assertEqual(self.events(peer, 'world_snapshot'), [initial])
        packet = dict(epoch=0, seq=1, viewTick=0, command=COMMAND, slot=0)
        self.emit(watcher, 'fps_command', packet)
        self.assertFalse(self.events(authority, 'fps_command'))
        self.emit(guest, 'fps_command', packet)
        self.assertEqual(self.events(authority, 'fps_command')[0]['slot'], 1)
        self.assertFalse(self.events(watcher, 'fps_command'))
        # Legacy inputs/hashes cannot mutate authority state or end this match.
        self.emit(guest, 'input', dict(epoch=0, frame=1, pad=dict(buttons=0, x=0, y=0)))
        self.assertFalse(self.events(authority, 'frameset'))
        self.emit(authority, 'world_snapshot', dict(initial, tick=1, acks=[0, 1]))
        self.assertEqual(self.events(guest, 'world_snapshot')[0]['acks'], [0, 1])
        self.emit(authority, 'restart_game')
        for peer in (authority, guest, watcher):
            self.emit(peer, 'loaded', dict(epoch=1, compatibility=self.descriptor))
            peer.get_received('/retro')
        self.emit(guest, 'fps_command', packet)
        self.emit(authority, 'world_snapshot', initial)
        self.assertFalse(self.events(authority, 'fps_command'))
        self.assertFalse(self.events(guest, 'world_snapshot'))
        self.emit(authority, 'world_snapshot', dict(initial, epoch=1))
        self.assertEqual(self.events(watcher, 'world_snapshot')[0]['tick'], 0)
        self.emit(authority, 'leave')
        self.assertTrue(self.events(guest, 'stopped'), 'Authority departure ends the session, without implicit migration.')


if __name__ == '__main__':
    unittest.main()
