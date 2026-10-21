import base64
import tempfile
import unittest
from pathlib import Path
from retro_test import make_app

class AccountSaves(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.app,_=make_app(Path(self.tmp.name))
        self.a=self.app.test_client();self.a.get('/test-login/alice')
        self.pc=self.app.test_client();self.pc.get('/test-login/alice')
        self.b=self.app.test_client();self.b.get('/test-login/bob')
        self.url='/games/retro/saves/devilutionx'

    def put(self,client,revision,files):
        token=client.get(self.url).json['csrf']
        return client.put(self.url,json=dict(revision=revision,files=files),headers={'X-CSRF-Token':token})

    def test_cross_pc_account_isolation_and_conflict(self):
        files={'multi_0.sv':base64.b64encode(b'hero save bytes').decode()}
        self.assertEqual(self.put(self.a,0,files).status_code,200)
        self.assertEqual(self.pc.get(self.url).json['files'],files)
        self.assertEqual(self.b.get(self.url).json['files'],{})
        self.assertEqual(self.put(self.pc,0,{}).status_code,409)
        self.assertEqual(self.a.get(self.url).json['files'],files)
        self.assertEqual(self.put(self.pc,1,{}).status_code,200)
        self.assertEqual(self.a.get(self.url).json['revision'],2)

    def test_perfectdark_eeprom(self):
        self.url='/games/retro/saves/perfectdark'
        files={'eeprom.bin':base64.b64encode(bytes(range(256))*8).decode()}
        self.assertEqual(self.put(self.a,0,files).status_code,200)
        self.assertEqual(self.pc.get(self.url).json['files'],files)
        self.assertEqual(self.b.get(self.url).json['files'],{})
        self.assertEqual(self.put(self.pc,0,files).status_code,409)
        self.assertEqual(self.put(self.a,1,{'pd.ini':files['eeprom.bin']}).status_code,400)
        self.assertEqual(self.put(self.a,1,{'eeprom.bin':'YQ=='}).status_code,400)

    def test_added_ports_are_separate_and_validate_paths(self):
        for game,name,size in [('sm64','sm64_save_file.bin',512),('zelda3','sram.dat',8192),('sonic1','SData.bin',64),('sonic2','SData.bin',64),('driver2','progress.dat',64)]:
            self.url='/games/retro/saves/'+game
            files={name:base64.b64encode(bytes(size)).decode()}
            self.assertEqual(self.a.get(self.url).json['revision'],0)
            self.assertEqual(self.put(self.a,0,files).status_code,200)
            self.assertEqual(self.pc.get(self.url).json['files'],files)
            self.assertEqual(self.b.get(self.url).json['files'],{})
            self.assertEqual(self.put(self.a,1,{'../'+name:files[name]}).status_code,400)
            if game in ('sm64','zelda3'):
                self.assertEqual(self.put(self.a,1,{name:'YQ=='}).status_code,400)

    def test_new_games_restore_on_another_browser(self):
        for game,name,size in [('gta5','/userdata/Documents/Rockstar Games/GTA V/Profiles/test/SGTA50000',256),('mk64','eeprom.bin',512),('marioparty','marioparty.eep',512),('marioparty2','marioparty.eep',512),('fzerox','sram.bin',32768),('smash64','ssb64_save.bin',32768)]:
            self.url='/games/saves/'+game
            files={name:base64.b64encode(bytes(size)).decode()}
            self.assertEqual(self.put(self.a,0,files).status_code,200,game)
            self.assertEqual(self.pc.get(self.url).json['files'],files)
            self.assertEqual(self.b.get(self.url).json['files'],{})
            self.assertEqual(self.put(self.pc,0,files).status_code,409)
        self.url='/games/saves/gta5'
        self.assertEqual(self.put(self.a,1,{'/userdata/Documents/../../bad':'YQ=='}).status_code,400)
        self.assertEqual(self.put(self.a,1,{'/etc/passwd':'YQ=='}).status_code,400)

    def test_derby_and_history(self):
        import json, sqlite3
        self.url='/games/saves/derby'
        for revision in range(7):
            files={'progress.json':base64.b64encode(json.dumps(dict(credits=1000+revision,races=revision,wins=0)).encode()).decode()}
            self.assertEqual(self.put(self.a,revision,files).status_code,200)
        self.assertEqual(self.pc.get(self.url).json['files'],files)
        with sqlite3.connect(self.app.config['RETRO_SAVE_DATABASE']) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM save_history WHERE game="derby"').fetchone()[0],5)
        self.assertEqual(self.put(self.a,7,{'progress.json':base64.b64encode(b'{"credits":1,"races":0,"wins":2}').decode()}).status_code,400)

    def test_switching_accounts_invalidates_open_game_uploads(self):
        old = self.a.get(self.url).json['csrf']
        self.a.get('/test-login/bob')
        result = self.a.put(self.url, json={'revision':0,'files':{}}, headers={'X-CSRF-Token':old})
        self.assertEqual(result.status_code,403)
        self.assertEqual(self.a.get(self.url).json['revision'],0)

    def test_auth_csrf_and_validation(self):
        self.assertEqual(self.app.test_client().get(self.url).status_code,401)
        self.assertEqual(self.a.put(self.url,json={}).status_code,403)
        for files in [{'../escape.sv':'YQ=='},{'diablo.ini':'YQ=='},{'multi_0.sv':'not-base64'}]:
            self.assertEqual(self.put(self.a,0,files).status_code,400)
        self.url='/games/retro/saves/oot'
        self.assertEqual(self.put(self.a,0,{'file1.sav':base64.b64encode(b'{"version":1,"sections":{}}').decode()}).status_code,200)
        self.assertEqual(self.put(self.a,1,{'file1.sav':'YQ=='}).status_code,400)
        self.assertIn('no-store',self.a.get(self.url).headers['Cache-Control'])

if __name__=='__main__':unittest.main()
