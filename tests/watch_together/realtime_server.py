"""Loopback-only integration app: actual room template, WebSockets and Plex HLS.

Uses temporary databases and test identities. Only dedicated test transcodes are
stopped; progress reporting is disabled to avoid altering watched history.
"""
import ast
import atexit
import logging
import os
from pathlib import Path
import sys
import tempfile
import uuid
from urllib.parse import urlencode
import xml.etree.ElementTree as ET

import requests
from gevent import get_hub
from flask import Flask, jsonify, redirect, request, Response, send_from_directory
from flask_login import login_user

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app import db, login_manager, socketio
from app.models import Room, User
from app.routes import main_bp, _save_room_playback_state, _get_room_state_payload
from app.auth import auth_bp

# Read configuration without instantiating the app or opening production DBs.
tree = ast.parse((ROOT / 'app/__init__.py').read_text())
config = {node.targets[0].slice.value: ast.literal_eval(node.value)
          for node in ast.walk(tree) if isinstance(node, ast.Assign)
          and isinstance(node.targets[0], ast.Subscript)
          and isinstance(node.targets[0].slice, ast.Constant)
          and str(node.targets[0].slice.value).startswith('PLEX_')}
plex_url = os.getenv('WATCH_PLEX_URL', config.get('PLEX_URL')).rstrip('/')
plex_token = os.getenv('WATCH_PLEX_TOKEN', config.get('PLEX_TOKEN'))
headers = {'X-Plex-Token': plex_token}
synthetic = os.getenv('WATCH_TEST_SYNTHETIC') == '1'
temporary = tempfile.TemporaryDirectory(prefix='watch-together-')
app = Flask(__name__, template_folder=str(ROOT / 'templates'), static_folder=str(ROOT / 'static'))
app.config.update(SECRET_KEY=uuid.uuid4().hex,
                  SQLALCHEMY_DATABASE_URI='sqlite:///' + str(Path(temporary.name) / 'users.db'),
                  SQLALCHEMY_BINDS={'channels_db': 'sqlite:///' + str(Path(temporary.name) / 'channels.db')},
                  PLEX_URL=plex_url, PLEX_TOKEN=plex_token)
db.init_app(app)
login_manager.init_app(app)
socketio.init_app(app, async_mode='gevent')
app.register_blueprint(main_bp)
app.register_blueprint(auth_bp)
logging.getLogger('werkzeug').setLevel(logging.ERROR)
sessions = []
proxy_metrics = {'requests': 0, 'bytes': 0, 'errors': 0, 'segments': 0,
                 'history_reports_blocked': 0}


def plex_get(path, **kwargs):
    if synthetic:
        raise RuntimeError('Plex requests are disabled in synthetic device tests')
    response = requests.get(plex_url + path, headers=headers, timeout=30, **kwargs)
    response.raise_for_status()
    return response


@app.before_request
def isolate_progress():
    if synthetic and request.path.startswith('/api/plex/'):
        return jsonify(audio=[], subtitles=[])
    if request.path.endswith('/plex-progress'):
        proxy_metrics['history_reports_blocked'] += 1
        return jsonify(success=True, test_history_reporting_disabled=True)


@app.get('/test/login/<int:user_id>')
def login(user_id):
    if not 0 <= user_id < 15:
        return '', 404
    login_user(db.session.get(User, str(user_id)))
    return redirect('/plex-watch-together/room/1')


@app.post('/test/media/<kind>')
def media(kind):
    if synthetic:
        room = db.session.get(Room, 1)
        room.current_media_key = 'fixture'
        room.current_media_title = 'Generated device test video'
        room.current_media_url = '/test/fixture/test.m3u8'
        _save_room_playback_state(1, 'paused', 0, new_media=True)
        socketio.emit('media_updated', _get_room_state_payload(room), to='room_1')
        return jsonify(kind='synthetic')
    media_type = 4 if kind == 'episode' else 1
    root = ET.fromstring(plex_get('/library/all', params={
        'type': media_type, 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 1}).content)
    item = root.find('Video')
    if item is None:
        return jsonify(error='No media of requested type'), 404
    session = 'watch-test-' + uuid.uuid4().hex
    sessions.append(session)
    params = {
        'path': item.get('key'), 'mediaIndex': 0, 'partIndex': 0,
        'protocol': 'hls', 'directPlay': 0, 'directStream': 0,
        'videoCodec': 'h264', 'audioCodec': 'aac', 'maxVideoBitrate': 1000,
        'videoResolution': '854x480', 'videoQuality': 60,
        'session': session, 'subtitleSize': 100, 'skipSubtitles': 1,
        'X-Plex-Client-Identifier': session, 'X-Plex-Product': 'PeakDecline isolated test',
        'X-Plex-Platform': 'Chrome', 'X-Plex-Client-Profile-Name': 'Chrome',
    }
    # The production set_media route performs this decision request too. Plex
    # can reject start.m3u8 with HTTP 400 when its session has no decision.
    plex_get('/video/:/transcode/universal/decision', params=params)
    room = db.session.get(Room, 1)
    room.current_media_key = item.get('ratingKey')
    room.current_media_title = 'Plex integration fixture (' + kind + ')'
    room.current_media_url = '/plex-transcode/video/:/transcode/universal/start.m3u8?' + urlencode(params)
    _save_room_playback_state(1, 'paused', 0, new_media=True)
    socketio.emit('media_updated', _get_room_state_payload(room), to='room_1')
    return jsonify(kind=kind, session_count=len(sessions))


@app.route('/plex-transcode/<path:rest>')
def proxy(rest):
    # Same URL prefix as the production reverse proxy; credentials stay server-side.
    try:
        # Production routes this prefix through its reverse proxy. Do not make
        # synchronous requests in the gevent application loop emulate a proxy:
        # that would block WebSocket dispatch and unrelated page navigations.
        response = get_hub().threadpool.apply(
            plex_get, ('/' + rest,), {'params': request.args.to_dict(flat=False)})
        proxy_metrics['requests'] += 1
        proxy_metrics['bytes'] += len(response.content)
        if rest.endswith('.ts') or rest.endswith('.m4s'):
            proxy_metrics['segments'] += 1
        return Response(response.content, content_type=response.headers.get('Content-Type'))
    except requests.RequestException as error:
        proxy_metrics['errors'] += 1
        proxy_metrics['last_error'] = type(error).__name__
        proxy_metrics['last_status'] = error.response.status_code if error.response is not None else None
        return 'Plex upstream request failed', 502


@app.get('/test/status')
def status():
    from app.routes import _unique_room_users
    transcodes = []
    if synthetic:
        return jsonify(users=len(_unique_room_users('1')), transcodes=[], proxy=proxy_metrics)
    try:
        for item in ET.fromstring(plex_get('/transcode/sessions').content):
            if item.get('key', '').split('/')[-1] in sessions:
                transcodes.append({k: item.get(k) for k in
                                   ('videoDecision', 'audioDecision', 'speed', 'throttled', 'progress')})
    except requests.RequestException:
        pass
    return jsonify(users=len(_unique_room_users('1')), transcodes=transcodes, proxy=proxy_metrics)


@app.get('/test/fixture/<path:name>')
def fixture(name):
    if not synthetic:
        return '', 404
    return send_from_directory(ROOT / 'tests/watch_together/fixtures', name)


def stop_transcodes():
    stopped = 0
    for session in sessions[:]:
        try:
            plex_get('/video/:/transcode/universal/stop', params={'session': session})
            stopped += 1
            sessions.remove(session)
        except requests.HTTPError as error:
            if error.response.status_code == 404:
                sessions.remove(session)
        except requests.RequestException:
            pass
    return stopped


@app.post('/test/cleanup')
def cleanup():
    result = dict(stopped=stop_transcodes(), remaining=len(sessions))
    db.session.remove()
    for engine in db.engines.values():
        engine.dispose()
    target = Path(temporary.name).resolve()
    assert target.parent == Path(tempfile.gettempdir()).resolve() and target.name.startswith('watch-together-')
    temporary.cleanup()
    return jsonify(result)


atexit.register(stop_transcodes)
with app.app_context():
    db.create_all()
    for i in range(15):
        db.session.add(User(id=str(i), username=f'test{i}', email=f'test{i}@example.test', is_verified=True))
    db.session.add(Room(id=1, name='Isolated WebSocket/Plex test', host_id='0'))
    db.session.commit()

if __name__ == '__main__':
    socketio.run(app, host='127.0.0.1', port=int(os.getenv('WATCH_TEST_PORT', '18765')),
                 log_output=False)
