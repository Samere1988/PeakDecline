"""Run the restored application behind nginx on the local interface."""
import socket

from gevent import pywsgi
from geventwebsocket.handler import WebSocketHandler

from app import create_app, db, socketio

app = create_app()
with app.app_context():
    db.create_all()


class LowLatencyHandler(WebSocketHandler):
    """Send small Socket.IO frames immediately instead of batching them.

    With Nagle's algorithm on, each game frame or input waited for the peer's
    next packet to acknowledge the previous one: about 16 ms at 60 Hz traffic.
    """

    def __init__(self, sock, address, server, rfile=None):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        super().__init__(sock, address, server, rfile)


if __name__ == '__main__':
    # Equivalent to socketio.run(app, debug=False) under gevent, with the handler above.
    socketio.wsgi_server = pywsgi.WSGIServer(('127.0.0.1', 8000), app,
                                             handler_class=LowLatencyHandler, log=None)
    socketio.wsgi_server.serve_forever()
