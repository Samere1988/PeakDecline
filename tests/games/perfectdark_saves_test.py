"""Save bootstrap is room-scoped, immutable, and absent from public listings."""
import base64
import unittest
from retro_test import RetroTests

class PerfectDarkSaveRooms(unittest.TestCase):
    setUp=RetroTests.setUp
    close_clients=RetroTests.close_clients
    connect=RetroTests.connect
    emit=RetroTests.emit
    events=RetroTests.events

    def test_start_and_late_watcher_use_same_snapshot(self):
        self.descriptor.update(id='perfectdark',backend='sync-input-v1',inputSchema='fps-command-v1',tickRate=60)
        http=self.app.test_client();http.get('/test-login/owner')
        url='/games/retro/saves/perfectdark'
        token=http.get(url).json['csrf']
        original={'eeprom.bin':base64.b64encode(bytes(2048)).decode()}
        def save(revision,files):
            self.assertEqual(http.put(url,json=dict(revision=revision,files=files),headers={'X-CSRF-Token':token}).status_code,200)
        save(0,original)
        host=self.connect('owner')
        self.emit(host,'create',dict(name='Saved PD',gameId='perfectdark',compatibility=self.descriptor))
        code=self.events(host,'room')[0]['code']
        self.emit(host,'ready',dict(ready=True));self.emit(host,'start_game')
        prepared=self.events(host,'prepare')[0]
        self.assertEqual(prepared['initialSave'],dict(revision=1,files=original))
        self.emit(host,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.assertTrue(self.events(host,'start'))
        save(1,{'eeprom.bin':base64.b64encode(bytes([1])*2048).decode()})
        watcher=self.connect('watcher')
        self.emit(watcher,'join',dict(code=code,compatibility=self.descriptor))
        events=watcher.get_received('/retro')
        late=next(e['args'][0] for e in events if e['name']=='prepare')
        self.assertEqual(late['initialSave'],prepared['initialSave'])
        for event in events:
            if event['name'] in ('room','room_update'):
                self.assertNotIn('initialSave',event['args'][0])
            if event['name']=='rooms':
                self.assertTrue(all('initialSave' not in room for room in event['args'][0]))

if __name__=='__main__':unittest.main()
