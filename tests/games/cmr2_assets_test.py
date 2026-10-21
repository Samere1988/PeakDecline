"""Private CMR2 manifest admission and catalogue release gating."""
import json
from pathlib import Path
import tempfile
import unittest
from retro_test import make_app,GAMES

class CMR2Assets(unittest.TestCase):
    def test_authenticated_manifest_only_assets_and_build_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);app,_=make_app(root);http=app.test_client();game=GAMES['cmr2']
            build=root/game.build_dir;build.mkdir(parents=True)
            asset=root/'cmr2/data/Game/test.bin';asset.parent.mkdir(parents=True);asset.write_bytes(b'private-data')
            (root/game.rom).write_text('{"installed":true}')
            for name in game.files:
                if name!='verified.json':(build/name).write_bytes(b'candidate')
            (build/'assets.json').write_text(json.dumps({'files':[{'path':'Game/test.bin'}]}))
            self.assertFalse(game.descriptor(app)['available'])
            (build/'verified.json').write_text('{"passed":true}')
            self.assertTrue(game.descriptor(app)['available'])
            route='/games/retro/data/cmr2/file/'
            self.assertEqual(http.get(route+'Game/test.bin').status_code,401)
            http.get('/test-login/cmr-assets')
            response=http.get(route+'Game/test.bin')
            self.assertEqual(response.data,b'private-data')
            self.assertIn('private',response.headers['Cache-Control'])
            self.assertEqual(response.headers['Cross-Origin-Resource-Policy'],'same-origin')
            (asset.parent/'secret.exe').write_bytes(b'not-an-asset')
            self.assertEqual(http.get(route+'Game/secret.exe').status_code,404)
            self.assertEqual(http.get(route+'../build/LICENSE').status_code,404)
            self.assertEqual(http.get('/games/retro/runtime/cmr2').status_code,200)

if __name__=='__main__':unittest.main()
