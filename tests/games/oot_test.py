"""Single-player room authorization, late spectators, and bounded media."""
import unittest
import retro_test as fixture

class OotRooms(unittest.TestCase):
    setUp = fixture.RetroTests.setUp
    close_clients = fixture.RetroTests.close_clients
    connect = fixture.RetroTests.connect
    emit = fixture.RetroTests.emit
    events = fixture.RetroTests.events

    def room(self):
        self.descriptor.update(id='oot', title='The Legend of Zelda: Ocarina of Time', maxPlayers=1,
            tickRate=20, backend='solo-media-v1', adapter='oot')
        host=self.connect('oot-player')
        self.emit(host,'create',dict(name='Ocarina',gameId='oot',compatibility=self.descriptor))
        code=self.events(host,'room')[0]['code']
        return host,code

    def start(self,host):
        self.emit(host,'ready',dict(ready=True))
        self.emit(host,'start_game')
        self.assertTrue(self.events(host,'prepare'))
        self.emit(host,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.assertTrue(self.events(host,'start'))

    def test_one_player_and_late_spectator(self):
        host,code=self.room()
        guest=self.connect('oot-watcher')
        self.emit(guest,'join',dict(code=code,compatibility=self.descriptor))
        self.emit(guest,'role',dict(role='player'))
        self.assertTrue(self.events(guest,'room_error'))
        self.emit(guest,'leave')
        self.start(host)
        self.emit(guest,'join',dict(code=code,compatibility=self.descriptor))
        self.assertTrue(self.events(guest,'prepare'))
        self.emit(guest,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.assertTrue(self.events(guest,'start'))
        payload=b'RIFF'+bytes(4)+b'WEBP'+bytes(20)
        self.emit(guest,'solo_media',dict(epoch=0,kind='video',payload=payload))
        self.assertFalse(self.events(host,'solo_media'))
        self.emit(host,'solo_media',dict(epoch=1,kind='video',payload=payload))
        self.assertFalse(self.events(guest,'solo_media'))
        self.emit(host,'solo_media',dict(epoch=0,kind='video',payload=payload))
        self.assertEqual(self.events(guest,'solo_media')[0]['payload'],payload)
        # A native Diablo packet must never be accepted by the solo backend.
        self.emit(host,'diablo_packet',dict(epoch=0,packet=b'bad'))
        self.assertFalse(self.events(host,'stopped'))
        self.emit(guest,'leave')
        self.assertFalse(self.events(host,'stopped'))

    def test_slow_spectator_backpressure_and_host_leaving(self):
        host,code=self.room();self.start(host)
        guest=self.connect('slow')
        self.emit(guest,'join',dict(code=code,compatibility=self.descriptor))
        self.emit(guest,'loaded',dict(epoch=0,compatibility=self.descriptor))
        for _ in range(20):self.emit(host,'solo_media',dict(epoch=0,kind='audio',payload=bytes(64)))
        events=self.events(guest,'solo_media');self.assertEqual(len(events),8)
        self.emit(guest,'solo_media_ack',dict(epoch=0,sequence=10000))
        self.emit(host,'solo_media',dict(epoch=0,kind='audio',payload=bytes(64)))
        self.assertFalse(self.events(guest,'solo_media'))
        self.emit(guest,'solo_media_ack',dict(epoch=0,sequence=8))
        self.emit(host,'solo_media',dict(epoch=0,kind='audio',payload=bytes(64)))
        self.assertEqual(len(self.events(guest,'solo_media')),1)
        self.emit(host,'leave');self.assertTrue(self.events(guest,'stopped'))

if __name__ == '__main__':unittest.main()
