"""Loopback UI fixture: enables only a fake lobby, never a playable engine."""
from retro_test import make_app, ROOT, Game
from unittest.mock import patch

if __name__=='__main__':
    app,sio=make_app(ROOT/'instance',async_mode='gevent')
    original=Game.descriptor
    def descriptor(game,app):
        result=original(game,app)
        if game.id=='marioparty':result.update(available=True,build='lobby-fixture')
        return result
    with patch.object(Game,'descriptor',descriptor):
        sio.run(app,host='127.0.0.1',port=8078,debug=False)
