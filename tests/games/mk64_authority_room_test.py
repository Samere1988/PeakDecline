"""Authenticated Socket.IO integration against the real native room worker."""
import os
import time
import zlib
import struct
import tempfile
import unittest
from pathlib import Path
from dataclasses import replace
from unittest.mock import patch
from retro_test import ROOT, GAMES, make_app


class AuthorityRooms(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        game = replace(GAMES['mk64'], build_dir=str(ROOT / '.tmp/mk64/candidate-authority'))
        self.patch = patch.dict(GAMES, mk64=game)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.app, self.sio = make_app(Path(self.temp.name), async_mode=os.environ.get('MK64_TEST_ASYNC','threading'))
        self.game = game.descriptor(self.app)
        self.assertTrue(self.game['available'])
        self.workers = []
        from retro_package.mk64_authority import Worker
        observed = self.workers
        class ObservedWorker(Worker):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                observed.append(self)
        worker_patch = patch('retro_package.rooms.KartWorker', ObservedWorker)
        worker_patch.start(); self.addCleanup(worker_patch.stop)
        self.clients = []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for client in self.clients:
            if client.is_connected('/retro'):
                self.emit(client, 'return_lobby')
                self.emit(client, 'leave')
                client.disconnect(namespace='/retro')
        end = time.monotonic()+3
        while any(w.process and w.process.poll() is None for w in self.workers) and time.monotonic()<end:
            time.sleep(.02)
        self.assertTrue(all(w.process is None or w.process.poll() is not None for w in self.workers), 'Room workers must be reaped')

    def connect(self, user):
        http = self.app.test_client(); http.get('/test-login/'+user)
        client = self.sio.test_client(self.app, namespace='/retro', flask_test_client=http)
        self.clients.append(client)
        return client

    def emit(self, client, event, data=None):
        client.emit(event, data, namespace='/retro')

    def events(self, client):
        return client.get_received('/retro')

    def wait(self, client, event, timeout=20):
        end = time.monotonic()+timeout
        while time.monotonic()<end:
            for packet in self.events(client):
                if packet['name']==event:
                    return packet['args'][0]
                if packet['name']=='stopped':
                    self.fail(packet['args'])
            time.sleep(.02)
        self.fail('Timed out waiting for '+event)

    def start(self, count=2):
        clients=[self.connect(str(i)) for i in range(count)]
        self.emit(clients[0], 'create', dict(name='Authority test', gameId='mk64', compatibility=self.game))
        room=self.wait(clients[0],'room'); code=room['code']
        tokens=[room['resumeToken']]
        for client in clients[1:]:
            self.emit(client,'join',dict(code=code,compatibility=self.game))
            tokens.append(self.wait(client,'room')['resumeToken'])
            self.emit(client,'role',dict(role='player'))
        for client in clients:
            self.emit(client,'ready',dict(ready=True))
        self.emit(clients[0],'start_game')
        for client in clients:
            self.wait(client,'prepare')
            self.emit(client,'loaded',dict(epoch=0,compatibility=self.game))
        return clients,code,tokens

    def checkpoint(self, client):
        packet=self.wait(client,'kart_snapshot')
        self.assertIsInstance(packet['payload'],bytes)
        self.emit(client,'kart_ack',dict(epoch=packet['epoch'],sequence=packet['sequence']))
        return packet

    def test_disconnect_reload_spectator_flow_control_and_restart(self):
        clients,code,tokens=self.start()
        a,b=clients
        self.assertEqual(self.checkpoint(a)['type'],'baseline')
        first=self.checkpoint(a)
        # B does not acknowledge its baseline. A must keep getting fresh state.
        time.sleep(.3)
        second=self.checkpoint(a)
        self.assertGreater(second['frame'],first['frame'])
        packets=[e for e in self.events(b) if e['name']=='kart_snapshot']
        self.assertEqual(len(packets),1,'Slow client must have only one unacknowledged snapshot')
        b.disconnect(namespace='/retro')
        third=self.checkpoint(a)
        self.assertGreater(third['frame'],second['frame'])
        intruder=self.connect('other-account')
        self.emit(intruder,'resume',dict(code=code,token=tokens[1],compatibility=self.game,retained=False))
        self.wait(intruder,'room_error')
        resumed=self.connect('1')
        self.emit(resumed,'resume',dict(code=code,token=tokens[1],compatibility=self.game,retained=False))
        room=self.wait(resumed,'room')
        self.assertEqual(next(m['slot'] for m in room['members'] if m['id']==room['memberId']),1)
        self.emit(resumed,'loaded',dict(epoch=0,compatibility=self.game))
        self.assertEqual(self.checkpoint(resumed)['type'],'baseline')
        self.assertGreater(self.checkpoint(resumed)['frame'],first['frame'])
        spectator=self.connect('watcher')
        self.emit(spectator,'join',dict(code=code,compatibility=self.game))
        self.wait(spectator,'prepare')
        self.emit(spectator,'loaded',dict(epoch=0,compatibility=self.game))
        self.assertEqual(self.checkpoint(spectator)['type'],'baseline')
        self.checkpoint(spectator)
        self.emit(a,'return_lobby')
        self.assertEqual(self.wait(resumed,'lobby_returned')['phase'],'lobby')

    def test_initial_spectator_does_not_hold_start(self):
        a,watcher=self.connect('host'),self.connect('viewer')
        self.emit(a,'create',dict(name='Slow viewer',gameId='mk64',compatibility=self.game))
        code=self.wait(a,'room')['code']
        self.emit(watcher,'join',dict(code=code,compatibility=self.game))
        self.emit(a,'ready',dict(ready=True));self.emit(a,'start_game')
        self.wait(a,'prepare')
        self.emit(a,'loaded',dict(epoch=0,compatibility=self.game))
        self.assertEqual(self.checkpoint(a)['type'],'baseline')
        self.emit(watcher,'failed',dict(epoch=0,message='Viewer failed to load'))
        self.checkpoint(a)

    def test_clients_cannot_publish_state_or_abort_with_legacy_hashes(self):
        clients,_,_=self.start(2)
        a,b=clients
        self.checkpoint(a);first=self.checkpoint(a)
        self.emit(a,'hash',dict(epoch=0,frame=first['frame'],hash=1))
        self.emit(b,'hash',dict(epoch=0,frame=first['frame'],hash=2))
        pad=dict(buttons=0x8000,x=20,y=0)
        for frame in range(first['frame']+2,first['frame']+17):
            self.emit(a,'kart_input',dict(epoch=0,frame=frame,pad=pad,slot=1))
        seen=False
        for _ in range(4):
            packet=self.checkpoint(a)
            if packet.get('inputs',[{}])[0].get('buttons')==0x8000:
                seen=True
                self.assertEqual(packet['inputs'][1]['buttons'],0,'Claimed slot must be ignored')
        self.assertTrue(seen,'Authenticated input must reach the server simulation')

    def test_rolling_anchors_and_slow_client_full_recovery(self):
        clients,code,_=self.start(1)
        a=clients[0]
        self.checkpoint(a)
        watcher=self.connect('slow')
        self.emit(watcher,'join',dict(code=code,compatibility=self.game))
        self.wait(watcher,'prepare')
        self.emit(watcher,'loaded',dict(epoch=0,compatibility=self.game))
        held=self.wait(watcher,'kart_snapshot')
        self.assertEqual(held['type'],'baseline')
        deadline=time.monotonic()+10.5
        latest=0
        while time.monotonic()<deadline:
            packet=self.checkpoint(a)
            latest=max(latest,packet['frame'])
        self.assertGreater(latest,held['frame']+240)
        self.emit(watcher,'kart_ack',dict(epoch=0,sequence=held['sequence']))
        full=self.checkpoint(watcher)
        self.assertEqual(full['type'],'baseline','Expired anchor chain must recover from a complete snapshot')
        self.assertGreater(full['sequence'],held['sequence'])
        baseline=zlib.decompress(full['payload']);anchor=full['sequence']
        for _ in range(8):
            packet=self.checkpoint(watcher)
            self.assertEqual(packet['base'],anchor)
            packed=zlib.decompress(packet['payload'])
            size,count=struct.unpack_from('<II',packed)
            self.assertEqual(size,len(baseline))
            restored=bytearray(baseline);at=8
            for _ in range(count):
                offset=struct.unpack_from('<I',packed,at)[0];at+=4
                length=min(256,len(restored)-offset)
                restored[offset:offset+length]=packed[at:at+length];at+=length
            self.assertEqual(at,len(packed))
            if packet['type']=='anchor':
                baseline=restored;anchor=packet['sequence']

    def test_live_tab_takeover_preserves_seat_and_worker(self):
        clients,code,tokens=self.start(1)
        a=clients[0]
        self.checkpoint(a);before=self.checkpoint(a)
        replacement=self.connect('0')
        self.emit(replacement,'resume',dict(code=code,token=tokens[0],compatibility=self.game,retained=False))
        self.wait(replacement,'prepare')
        self.emit(replacement,'loaded',dict(epoch=0,compatibility=self.game))
        self.checkpoint(replacement)
        self.assertGreaterEqual(self.checkpoint(replacement)['frame'],before['frame'])
        self.wait(a,'stopped')


if __name__=='__main__':unittest.main()
