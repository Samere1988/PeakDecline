import tempfile
import unittest
from pathlib import Path
import retro_test as fixture

IDS=('sm64','sonic1','sonic2','zelda3','driver2')

class SoloCatalog(unittest.TestCase):
    def test_driver_movies_are_private_and_support_partial_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            app,_=fixture.make_app(Path(directory))
            movie=Path(directory)/'driver2/data/fmv/0.avi'
            movie.parent.mkdir(parents=True)
            movie.write_bytes(bytes(range(100)))
            http=app.test_client()
            self.assertEqual(http.get('/games/retro/data/driver2/fmv/0').status_code,401)
            http.get('/test-login/movie-viewer')
            response=http.get('/games/retro/data/driver2/fmv/0',headers={'Range':'bytes=10-19'})
            self.assertEqual(response.status_code,206)
            self.assertEqual(response.data,bytes(range(10,20)))
            self.assertIn('private',response.headers['Cache-Control'])
            self.assertEqual(http.get('/games/retro/data/driver2/fmv/500').status_code,404)

    def test_private_assets_gate_availability(self):
        with tempfile.TemporaryDirectory() as directory:
            app,_=fixture.make_app(Path(directory))
            http=app.test_client()
            self.assertEqual(http.get('/games/retro/data/sm64').status_code,401)
            http.get('/test-login/assets')
            for game_id in IDS:
                game=fixture.GAMES[game_id]
                self.assertEqual(game.max_players,1)
                self.assertEqual(game.backend,'solo-media-v1')
                self.assertTrue(game.private_data)
                build=Path(directory)/game.build_dir;build.mkdir(parents=True)
                for name in game.files:(build/name).write_bytes(b'fixture')
                self.assertFalse(game.descriptor(app)['available'])
                data=Path(directory)/game.rom;data.parent.mkdir(parents=True);data.write_bytes(b'private game data')
                self.assertTrue(game.descriptor(app)['available'])
                response=http.get('/games/retro/data/'+game_id)
                self.assertEqual(response.data,b'private game data')
                self.assertIn('private',response.headers['Cache-Control'])
                self.assertEqual(http.get('/games/retro/runtime/'+game_id).status_code,200)
            self.assertEqual(http.get('/games/retro/data/unknown').status_code,404)
            self.assertEqual(http.get('/games/retro').status_code,200)

class SoloRooms(unittest.TestCase):
    setUp=fixture.RetroTests.setUp
    close_clients=fixture.RetroTests.close_clients
    connect=fixture.RetroTests.connect
    emit=fixture.RetroTests.emit
    events=fixture.RetroTests.events

    def test_new_games_allow_one_player_and_late_spectators(self):
        for game_id in IDS:
            self.descriptor.update(id=game_id,maxPlayers=1,tickRate=30,backend='solo-media-v1')
            host=self.connect('host-'+game_id)
            self.emit(host,'create',dict(name='Solo',gameId=game_id,compatibility=self.descriptor))
            code=self.events(host,'room')[0]['code']
            watch=self.connect('watch-'+game_id)
            self.emit(watch,'join',dict(code=code,compatibility=self.descriptor))
            self.emit(watch,'role',dict(role='player'))
            self.assertTrue(self.events(watch,'room_error'))
            self.emit(watch,'leave')
            self.emit(host,'ready',dict(ready=True));self.emit(host,'start_game')
            self.assertTrue(self.events(host,'prepare'))
            self.emit(host,'loaded',dict(epoch=0,compatibility=self.descriptor))
            self.assertTrue(self.events(host,'start'))
            self.emit(watch,'join',dict(code=code,compatibility=self.descriptor))
            self.assertTrue(self.events(watch,'prepare'))
            self.emit(host,'leave')
            self.emit(watch,'leave')

if __name__=='__main__':unittest.main()
