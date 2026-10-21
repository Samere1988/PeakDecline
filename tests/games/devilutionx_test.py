"""Native protocol and authenticated room/spectator regression tests."""
import struct
import unittest
from unittest.mock import patch
import retro_test as fixture
from retro_package.native import NativeRelay, BACKEND

INFO = struct.pack('<I', 40) + bytes(36)
def join(slot=0):
    return bytes([0x11, 255, 254]) + b'abcd' + (INFO if slot == 0 else b'')

class NativePackets(unittest.TestCase):
    def test_join_before_host_and_broadcast(self):
        relay = NativeRelay(2)
        self.assertEqual(relay.receive(1, join(1)), [])
        replies = relay.receive(0, join())
        self.assertEqual([(seat, packet[0]) for seat, packet in replies], [(0, 0x12), (0, 0x13), (1, 0x13), (1, 0x12)])
        self.assertEqual(replies[-1][1][7], 1)
        self.assertEqual(replies[-1][1][8:], INFO)
        packet = bytes([2, 0, 255, 0, 1, 0, 0, 0])
        self.assertEqual(relay.receive(0, packet), [(1, packet)])
        with self.assertRaises(ValueError): relay.receive(1, packet)

    def test_four_seats_and_no_cross_room_delivery(self):
        relay = NativeRelay(4)
        other_room = NativeRelay(4)
        for slot in (3, 1, 2, 0): relay.receive(slot, join(slot))
        self.assertEqual(relay.joined, {0, 1, 2, 3})
        self.assertEqual(other_room.joined, set())
        packet = bytes([1, 2, 255, 42])
        self.assertEqual([seat for seat, _ in relay.receive(2, packet)], [0, 1, 3])
        self.assertEqual(relay.receive(2, bytes([1, 2, 1, 42])), [(1, bytes([1, 2, 1, 42]))])
        with self.assertRaises(ValueError): relay.receive(4, join(4))

    def test_rejects_bad_packets_and_shareware(self):
        for packet in (None, [], b'x', bytes(65537), bytes([0x11,255,254])+b'abcd'+bytes(24),
                       bytes([0x11,255,254])+b'abcd'+INFO[:4]+b'\x01'+INFO[5:]):
            with self.assertRaises(ValueError): NativeRelay(2).receive(0, packet)
        relay = NativeRelay(1);relay.receive(0, join())
        for packet in (bytes([0x13,0,255,1]), bytes([2,0,255]), bytes([0x31,0,9])+bytes(4),
                       bytes([0x14,0,255,1])+bytes(4)):
            with self.assertRaises(ValueError): relay.receive(0, packet)

class NativeRooms(unittest.TestCase):
    setUp = fixture.RetroTests.setUp
    close_clients = fixture.RetroTests.close_clients
    connect = fixture.RetroTests.connect
    emit = fixture.RetroTests.emit
    events = fixture.RetroTests.events

    def room(self):
        self.descriptor.update(id='devilutionx', title='Diablo · DevilutionX', tickRate=20,
            inputSchema='diablo-packet-v1', backend=BACKEND, adapter='devilutionx')
        players=[self.connect('native-'+str(i)) for i in range(2)]
        self.emit(players[0], 'create', dict(name='Diablo', gameId='devilutionx', compatibility=self.descriptor))
        code=self.events(players[0],'room')[0]['code']
        self.emit(players[1], 'join', dict(code=code,compatibility=self.descriptor))
        self.emit(players[1], 'role',dict(role='player'))
        for client in players:self.emit(client,'ready',dict(ready=True))
        self.emit(players[0],'start_game')
        for client in players:self.emit(client,'loaded',dict(epoch=0,compatibility=self.descriptor))
        for client in players:self.assertTrue(self.events(client,'start'))
        return players,code

    def test_live_spectator_cannot_send_packets_or_media(self):
        players,code=self.room()
        watcher=self.connect('watcher')
        self.emit(watcher,'list')
        self.assertEqual(self.events(watcher,'rooms')[0][0]['phase'],'running')
        self.emit(watcher,'join',dict(code=code,compatibility=self.descriptor))
        self.assertTrue(self.events(watcher,'prepare'))
        self.emit(watcher,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.assertTrue(self.events(watcher,'start'))
        self.emit(watcher,'diablo_packet',dict(epoch=0,packet=join()))
        self.assertFalse(self.events(players[0],'diablo_packet'))
        self.emit(players[0],'diablo_packet',dict(epoch=0,packet=join()))
        self.assertEqual(self.events(players[0],'diablo_packet')[0]['packet'][0],0x12)
        self.assertFalse(self.events(watcher,'diablo_packet'))
        payload=b'RIFF'+bytes(4)+b'WEBP'+bytes(20)
        for sender in (watcher,players[1]):self.emit(sender,'diablo_media',dict(epoch=0,kind='video',payload=payload))
        self.assertFalse(self.events(watcher,'diablo_media'))
        self.emit(players[0],'diablo_media',dict(epoch=0,kind='video',payload=payload))
        self.assertEqual(self.events(watcher,'diablo_media')[0]['payload'],payload)
        self.assertFalse(self.events(players[1],'diablo_media'))
        self.emit(players[0],'diablo_media',dict(epoch=1,kind='video',payload=payload))
        self.assertFalse(self.events(watcher,'diablo_media'))
        self.emit(watcher,'leave')
        self.assertFalse(self.events(players[0],'stopped'))
        self.emit(players[1],'leave')
        self.assertTrue(self.events(players[0],'stopped'))

    def test_slow_spectator_has_bounded_outstanding_media(self):
        players, code = self.room()
        watcher = self.connect('slow-watcher')
        self.emit(watcher, 'join', dict(code=code, compatibility=self.descriptor))
        self.emit(watcher, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.events(watcher, 'start')
        for _ in range(20):
            self.emit(players[0], 'diablo_media', dict(epoch=0, kind='audio', payload=bytes(2)))
        packets = self.events(watcher, 'diablo_media')
        self.assertEqual(len(packets), 8)
        self.emit(watcher, 'diablo_media_ack', dict(epoch=0, sequence=100))
        self.emit(players[0], 'diablo_media', dict(epoch=0, kind='audio', payload=bytes(2)))
        self.assertFalse(self.events(watcher, 'diablo_media'))
        self.emit(watcher, 'diablo_media_ack', dict(epoch=0, sequence=8))
        self.emit(players[0], 'diablo_media', dict(epoch=0, kind='audio', payload=bytes(2)))
        self.assertEqual(self.events(watcher, 'diablo_media')[0]['sequence'], 9)

    def test_full_data_is_private_and_range_served(self):
        from pathlib import Path
        data=Path(self.app.instance_path)/'devilutionx/data';data.mkdir(parents=True)
        (data/'diabdat.mpq').write_bytes(b'MPQ\x1a'+bytes(32))
        client=self.app.test_client();url='/games/retro/data/devilutionx/diabdat.mpq'
        self.assertNotEqual(client.get(url).status_code,200)
        client.get('/test-login/data-reader')
        response=client.get(url,headers={'Range':'bytes=0-3'})
        self.assertEqual(response.status_code,206)
        self.assertEqual(response.data,b'MPQ\x1a')
        self.assertIn('private',response.headers['Cache-Control'])
        response.close()

if __name__=='__main__': unittest.main()
