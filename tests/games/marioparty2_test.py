"""Mario Party 2 shares the production lobby protocol but stays unavailable."""
import unittest
import retro_test as fixture

descriptor = fixture.Game.descriptor

class MarioParty2Room(unittest.TestCase):
    setUp=fixture.RetroTests.setUp
    close_clients=fixture.RetroTests.close_clients
    connect=fixture.RetroTests.connect
    emit=fixture.RetroTests.emit
    events=fixture.RetroTests.events
    # Only run this game's contract here, not inherited generic tests.
    def test_marioparty2_contract(self):
        game=fixture.GAMES['marioparty2']
        self.assertFalse(descriptor(game,self.app)['available'])
        self.assertEqual(game.max_players,4)
        self.assertIn('js/retro_controller.js',game.scripts)
        self.descriptor.update(id='marioparty2',maxPlayers=4,tickRate=60,backend=game.backend)
        players=[self.connect('mp-'+str(i)) for i in range(4)]
        self.emit(players[0],'create',dict(name='Mario Party 2',gameId='marioparty2',compatibility=self.descriptor))
        code=self.events(players[0],'room')[0]['code']
        for player in players[1:]:
            self.emit(player,'join',dict(code=code,compatibility=self.descriptor))
            self.emit(player,'role',dict(role='player'))
        watcher=self.connect('mp-watch')
        self.emit(watcher,'join',dict(code=code,compatibility=self.descriptor))
        self.emit(watcher,'role',dict(role='player'))
        self.assertTrue(self.events(watcher,'room_error'))
        for player in players:self.emit(player,'ready',dict(ready=True))
        self.emit(players[0],'start_game')
        self.assertTrue(self.events(watcher,'prepare'))
        for player in players:self.emit(player,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.emit(watcher,'loaded',dict(epoch=0,compatibility=self.descriptor))
        self.assertTrue(self.events(players[0],'start'))

if __name__=='__main__':
    unittest.main()
