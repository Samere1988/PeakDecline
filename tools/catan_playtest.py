"""Local manual CATAN sandbox: four browser seats, isolated from production.

Run with the project virtualenv. Binds loopback only; fixed test identities must
never be exposed by a public proxy or bound to a network interface.
"""
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import sys
import threading
import uuid
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from flask import Flask, redirect, render_template
from flask_login import LoginManager, UserMixin
from flask_socketio import SocketIO
from werkzeug.serving import make_server
from app.catan_online import register


class TestPlayer(UserMixin):
    def __init__(self, seat):
        self.id = 'playtest-' + str(seat)
        self.username = ['You (Red)', 'Test Blue', 'Test Orange', 'Test Green'][seat]


def create_app(seat, storage, links):
    app = Flask('catan_playtest_' + str(seat), template_folder=str(ROOT / 'templates'), static_folder=str(ROOT / 'static'))
    app.config.update(SECRET_KEY=secrets.token_hex(32), CATAN_DATABASE=str(storage / 'games.sqlite3'),
                      SESSION_COOKIE_NAME='catan_playtest_' + str(seat), MAX_CONTENT_LENGTH=12000)
    login = LoginManager(app)

    @login.request_loader
    def load_user(request):
        return TestPlayer(seat)

    socketio = SocketIO(app, async_mode='threading')
    register(app, socketio)

    @app.get('/')
    def index():
        return redirect(links[seat]['url'] if links else '/games/catan')

    @app.get('/games/catan')
    def game():
        return render_template('catan.html', player_name=TestPlayer(seat).username, online=True,
                               playtest_links=links, playtest_seat=seat)

    app.add_url_rule('/games', 'main.games', index)

    @app.get('/playtest-health')
    def health():
        return dict(service='catan-local-playtest', seat=seat, pid=os.getpid())

    return app


def start():
    storage = ROOT / '.tmp' / 'catan-playtest'
    storage.mkdir(parents=True, exist_ok=True)
    links = []
    apps = [create_app(i, storage, links) for i in range(4)]
    info_path = storage / 'connection.json'
    old = json.loads(info_path.read_text(encoding='utf-8')) if info_path.exists() else None
    ports = [urlparse(link['url']).port for link in old['links']] if old else [0]*4
    servers = []
    for port, app in zip(ports, apps):
        # Windows can reserve previously used ephemeral ports after a reboot.
        # Keep the saved link where possible; otherwise choose a free local port.
        with socket.socket() as probe:
            try: probe.bind(('127.0.0.1',port))
            except OSError: port=0
        servers.append(make_server('127.0.0.1',port,app,threaded=True))
    clients = [app.test_client() for app in apps]
    tokens = [client.get('/api/catan/lobby').json['csrf'] for client in clients]
    room = None
    if info_path.exists():
        old = json.loads(info_path.read_text(encoding='utf-8'))
        response = clients[0].get('/api/catan/rooms/' + old['room'])
        if response.status_code == 200:
            room = response.json
    if room is None:
        response = clients[0].post('/api/catan/rooms', json={'name': 'PeakDecline testing room'}, headers={'X-Catan-CSRF': tokens[0]})
        if response.status_code != 201:
            raise RuntimeError(response.json)
        room = response.json
        for i in range(1, 4):
            response = clients[i].post('/api/catan/rooms/' + room['id'] + '/actions',
                                      json=dict(type='join', version=room['version'], command=uuid.uuid4().hex),
                                      headers={'X-Catan-CSRF': tokens[i]})
            if response.status_code != 200:
                raise RuntimeError(response.json)
            room = response.json
        for i in range(4):
            response = clients[i].post('/api/catan/rooms/' + room['id'] + '/actions',
                                      json=dict(type='ready', version=room['version'], command=uuid.uuid4().hex),
                                      headers={'X-Catan-CSRF': tokens[i]})
            if response.status_code != 200:
                raise RuntimeError(response.json)
            room = response.json
    for i, server in enumerate(servers):
        links.append(dict(name=TestPlayer(i).username, url=f'http://127.0.0.1:{server.server_port}/games/catan?room={room["id"]}'))
    info = dict(pid=os.getpid(), room=room['id'], links=links, database=str(storage / 'games.sqlite3'))
    info_path.write_text(json.dumps(info, indent=2), encoding='utf-8')
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print(json.dumps(info), flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        for server in servers:
            server.shutdown()


if __name__ == '__main__':
    start()
