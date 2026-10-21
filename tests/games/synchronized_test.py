import base64
import unittest
from retro_test import RetroTests
from retro_package.synchronized import InputHistory, PAD, NEUTRAL, MAX_FRAMES

class HistoryTests(unittest.TestCase):
    def test_session_limit_is_24_hours_at_60_hz(self):
        self.assertEqual(MAX_FRAMES, 24 * 3600 * 60)
    def test_order_and_replay(self):
        h=InputHistory(2)
        self.addCleanup(h.close)
        for frame in (2,1):
            self.assertTrue(h.input(0,frame,{**NEUTRAL,'buttons':frame}))
        self.assertIsNone(h.drain())
        self.assertTrue(h.input(1,1,NEUTRAL))
        first=h.drain();self.assertEqual(first['count'],1)
        self.assertTrue(h.input(1,2,NEUTRAL));h.drain()
        replay=h.packet(1)
        rows=list(PAD.iter_unpack(base64.b64decode(replay['data'])))
        self.assertEqual([row[0] for row in rows],[1,0,2,0])
        self.assertEqual(h.packet(3)['count'],0)
        self.assertIsNone(h.packet(4))
        self.assertFalse(h.input(0,3,{**NEUTRAL,'buttons':True}))
        self.assertFalse(h.input(0,67,NEUTRAL))
    def test_absent_seat_and_activation(self):
        h=InputHistory(2);self.addCleanup(h.close)
        h.input(1,2,{**NEUTRAL,'buttons':1});h.seat(1,False)
        for frame in (1,2):h.input(0,frame,NEUTRAL)
        self.assertEqual(h.drain()['count'],2)
        self.assertEqual(list(PAD.iter_unpack(base64.b64decode(h.packet(1)['data']))),[(0,0,0,0,0)]*4)
        self.assertEqual(h.seat(1,True),8)
        for frame in range(3,10):h.input(0,frame,NEUTRAL)
        h.drain();self.assertEqual(h.frame,7)
        h.input(1,8,NEUTRAL);h.drain();self.assertEqual(h.frame,8)
    def test_conflicts_and_hashes(self):
        h=InputHistory(2);self.addCleanup(h.close)
        h.input(0,1,NEUTRAL)
        with self.assertRaises(ValueError):h.input(0,1,{**NEUTRAL,'buttons':1})
        h.input(1,1,NEUTRAL);h.drain()
        self.assertTrue(h.check_hash(0,1,23));self.assertFalse(h.check_hash(1,1,24))

    def test_viewers_keep_receiving_neutral_frames_after_last_player_leaves(self):
        h=InputHistory(2);self.addCleanup(h.close)
        self.assertIsNone(h.idle(3))
        h.seat(0,False);h.seat(1,False)
        packet=h.idle(3)
        self.assertEqual(packet['through'],3)
        self.assertEqual(base64.b64decode(packet['data']),bytes(3*2*8))
        h.seat(1,True)
        self.assertIsNone(h.idle(3))

class Rooms(unittest.TestCase):
    setUp=RetroTests.setUp
    close_clients=RetroTests.close_clients
    connect=RetroTests.connect
    emit=RetroTests.emit
    events=RetroTests.events
    room=RetroTests.room
    start=RetroTests.start
    def setup_room(self):
        self.descriptor.update(backend='sync-input-v1',inputSchema='fps-command-v1',tickRate=60)
        clients,code=self.room(2);self.start(clients)
        for c in clients:c.get_received('/retro')
        return clients,code
    def test_live_spectator_does_not_restart(self):
        clients,code=self.setup_room()
        for c in clients:self.emit(c,'sync_input',dict(epoch=0,frame=1,command=NEUTRAL))
        self.assertEqual(self.events(clients[0],'sync_frames')[0]['through'],1)
        watcher=self.connect('late');self.emit(watcher,'join',dict(code=code,compatibility=self.descriptor))
        self.assertTrue(self.events(watcher,'prepare'));self.assertFalse(self.events(clients[0],'prepare'))
        self.emit(watcher,'loaded',dict(epoch=0,compatibility=self.descriptor));self.assertTrue(self.events(watcher,'start'))
        self.emit(watcher,'sync_replay',dict(epoch=0,start=1));self.assertEqual(self.events(watcher,'sync_history')[0]['count'],1)
        self.emit(watcher,'sync_input',dict(epoch=0,frame=2,command=NEUTRAL))
        self.emit(watcher,'sync_pause',dict(epoch=0))
        self.emit(clients[0],'sync_input',dict(epoch=0,frame=2,command=NEUTRAL))
        self.assertFalse(self.events(clients[0],'sync_frames'))
        self.emit(clients[1],'sync_input',dict(epoch=0,frame=2,command=NEUTRAL))
        self.assertEqual(self.events(clients[0],'sync_frames')[-1]['through'],2)
    def test_bad_spectator_hash_only_removes_spectator(self):
        clients,code=self.setup_room()
        for c in clients:self.emit(c,'sync_input',dict(epoch=0,frame=1,command=NEUTRAL))
        self.emit(clients[0],'sync_hash',dict(epoch=0,frame=1,hash=23))
        watcher=self.connect('watch');self.emit(watcher,'join',dict(code=code,compatibility=self.descriptor))
        self.emit(watcher,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.emit(watcher,'sync_hash',dict(epoch=0,frame=1,hash=24))
        self.assertTrue(self.events(watcher,'stopped'))
        self.assertFalse(self.events(clients[0],'stopped'))
        for c in clients:self.emit(c,'sync_input',dict(epoch=0,frame=2,command=NEUTRAL))
        self.assertEqual(self.events(clients[0],'sync_frames')[-1]['through'],2)

    def test_hidden_player_releases_only_own_seat_and_can_return(self):
        clients,code=self.setup_room()
        self.emit(clients[1],'sync_pause',dict(epoch=99))
        self.emit(clients[0],'sync_input',dict(epoch=0,frame=1,command=NEUTRAL))
        self.assertFalse(self.events(clients[0],'sync_frames'))
        self.emit(clients[1],'sync_pause',dict(epoch=0))
        self.assertEqual(self.events(clients[0],'sync_frames')[-1]['through'],1)
        self.emit(clients[1],'sync_input',dict(epoch=0,frame=2,command={**NEUTRAL,'buttons':1}))
        self.emit(clients[0],'sync_input',dict(epoch=0,frame=2,command=NEUTRAL))
        packet=self.events(clients[0],'sync_frames')[-1]
        self.assertEqual(list(PAD.iter_unpack(base64.b64decode(packet['data'])))[-1][0],0)
        self.emit(clients[1],'sync_ready',dict(epoch=0,frame=2))
        self.assertTrue(self.events(clients[1],'sync_live'))
        for frame in range(3,10):self.emit(clients[0],'sync_input',dict(epoch=0,frame=frame,command=NEUTRAL))
        self.assertEqual(self.events(clients[0],'sync_frames')[-1]['through'],7)
        self.emit(clients[1],'sync_input',dict(epoch=0,frame=8,command={**NEUTRAL,'buttons':1}))
        self.assertEqual(self.events(clients[0],'sync_frames')[-1]['through'],8)
        self.assertFalse(self.events(clients[0],'stopped'))

    def test_player_leaves_and_host_continues(self):
        clients,code=self.setup_room()
        self.emit(clients[1],'leave')
        self.assertFalse(self.events(clients[0],'stopped'))
        self.emit(clients[0],'sync_input',dict(epoch=0,frame=1,command=NEUTRAL))
        self.assertEqual(self.events(clients[0],'sync_frames')[0]['count'],1)
    def test_reconnect_and_page_reload_reuse_controller_slot(self):
        self.descriptor.update(backend='sync-input-v1',inputSchema='fps-command-v1',tickRate=60)
        host=self.connect('host');guest=self.connect('guest')
        self.emit(host,'create',dict(name='Resume',gameId='mk64',compatibility=self.descriptor))
        room=self.events(host,'room')[0]
        self.emit(guest,'join',dict(code=room['code'],compatibility=self.descriptor))
        seat=self.events(guest,'room')[0]
        for c in [host,guest]:
            self.emit(c,'role',dict(role='player'));self.emit(c,'ready',dict(ready=True))
        self.start([host,guest])
        guest.disconnect(namespace='/retro')
        self.emit(host,'sync_input',dict(epoch=0,frame=1,command=NEUTRAL))
        self.assertEqual(self.events(host,'sync_frames')[0]['through'],1)
        replacement=self.connect('guest')
        self.emit(replacement,'resume',dict(code=room['code'],token=seat['resumeToken'],compatibility=self.descriptor,retained=False))
        resumed=self.events(replacement,'prepare')[0]
        self.assertEqual(resumed['players'],2)
        self.emit(replacement,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.emit(replacement,'sync_replay',dict(epoch=0,start=1))
        self.assertEqual(self.events(replacement,'sync_history')[0]['through'],1)
        self.emit(replacement,'sync_ready',dict(epoch=0,frame=1))
        self.assertEqual(self.events(replacement,'sync_live')[0]['through'],1)
        for frame in range(2,8):
            self.emit(host,'sync_input',dict(epoch=0,frame=frame,command=NEUTRAL))
            self.emit(replacement,'sync_input',dict(epoch=0,frame=frame,command={**NEUTRAL,'buttons':1}))
        packets=self.events(host,'sync_frames')
        last=list(PAD.iter_unpack(base64.b64decode(packets[-1]['data'])))
        self.assertEqual(last[-1][0],1,'Recovered player controls its original second seat')
        self.assertFalse(self.events(host,'stopped'))

    def test_legacy_packets_do_not_mutate_sync_room(self):
        clients,code=self.setup_room()
        for c in clients:self.emit(c,'input',dict(epoch=0,frame=1,pad=dict(buttons=0,x=0,y=0)))
        self.assertFalse(self.events(clients[0],'frameset'))
        for c in clients:self.emit(c,'sync_input',dict(epoch=0,frame=1,command=NEUTRAL))
        self.assertEqual(self.events(clients[0],'sync_frames')[0]['through'],1)

if __name__=='__main__':unittest.main()
