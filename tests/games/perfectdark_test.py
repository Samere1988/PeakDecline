"""Preview route boundaries; production rooms must not advertise unfinished FPS adapters."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from retro_test import make_app
from retro_package.catalog import GAMES, PREVIEW_GAMES, Game


class PerfectDarkPreviewTests(unittest.TestCase):
    def test_preview_is_authenticated_and_not_a_room_game(self):
        self.assertNotIn('perfectdark', GAMES)
        with tempfile.TemporaryDirectory() as directory:
            app, _ = make_app(Path(directory))
            http = app.test_client()
            self.assertEqual(http.get('/games/retro/preview/perfectdark').status_code, 401)
            self.assertEqual(http.get('/games/retro/build/perfectdark/pd.wasm').status_code, 401)
            http.get('/test-login/pd-test')
            with patch.object(Game, 'descriptor', return_value={'available': False}):
                self.assertEqual(http.get('/games/retro/preview/perfectdark').status_code, 404)
            with patch.object(Game, 'descriptor', return_value={'available': True}):
                response = http.get('/games/retro/preview/perfectdark')
                self.assertEqual(response.status_code, 200)
                self.assertIn(b'Multiplayer and spectators are not connected yet', response.data)
                self.assertIn('no-store', response.headers['Cache-Control'])
            for filename in ('source.json', '../users.db', 'pd.html'):
                self.assertEqual(http.get('/games/retro/build/perfectdark/' + filename).status_code, 404)
            self.assertEqual(http.get('/games/retro/runtime/perfectdark').status_code, 404)


if __name__ == '__main__':
    unittest.main()
