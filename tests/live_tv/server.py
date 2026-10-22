"""Loopback-only production routes with generated FFmpeg input and temp DBs."""
import os
from pathlib import Path
import subprocess
import signal
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from flask import Flask, jsonify, redirect, send_from_directory, request
from flask_login import login_user
from app import db, socketio, login_manager
from app.models import User, Channel
from app.routes import main_bp, play_channel
from app.auth import auth_bp
from app.services.streamer import streamer

temporary = tempfile.TemporaryDirectory(prefix='peak-live-clock-')
directory = Path(temporary.name)
# Guide refresh must never read real sources or launch external downloads in tests.
from app.services import guide
guide.ROOT = directory
guide.next_check = float('inf')
app = Flask(__name__, template_folder=str(ROOT / 'templates'), static_folder=str(ROOT / 'static'))
app.config.update(SECRET_KEY=uuid.uuid4().hex,
    SQLALCHEMY_DATABASE_URI='sqlite:///' + str(directory / 'users.db'),
    SQLALCHEMY_BINDS={'channels_db': 'sqlite:///' + str(directory / 'channels.db')})
db.init_app(app)
login_manager.init_app(app)
socketio.init_app(app, async_mode='gevent')
app.register_blueprint(main_bp)
app.register_blueprint(auth_bp)
streamer.stream_root = str(directory)
streamer.log_root = str(directory / 'private-logs')
real_probe = streamer._has_audio
streamer._has_audio = lambda source: source != 'fixture-no-audio' if source.startswith('fixture') else real_probe(source)
real_popen = subprocess.Popen


def generated_input(args, **kwargs):
    args = list(args)
    if '-i' in args and args[args.index('-i') + 1].startswith('fixture'):
        audio = args[args.index('-i') + 1] != 'fixture-no-audio'
        test_size = os.environ.get('LIVE_TEST_VIDEO', '320x180')
        args[args.index('-user_agent'):args.index('-filter_complex')] = [
            '-re', '-f', 'lavfi', '-i', f'testsrc2=size={test_size}:rate=25',
            *(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] if audio else [])]
        # The synthetic harness uses separate lavfi video/audio inputs;
        # production channel URLs normally expose both on input 0.
        if audio:
            args = ['1:a:0?' if value == '0:a:0?' else value for value in args]
    return real_popen(args, **kwargs)


# Only input is substituted. Actual startup, waits, shutdown, output options,
# route transactions and versioned broadcasts all run unchanged.
subprocess.Popen = generated_input


@app.get('/test/login/<int:identity>')
def login(identity):
    if identity not in range(15):
        return '', 404
    login_user(db.session.get(User, str(identity)))
    return redirect('/live-tv')


@app.get('/test/measure')
def measure():
    from app.services.live_clock import live_clock
    playlist = Path(streamer.clock_playlist_path or Path(streamer.current_channel_dir) / 'index.m3u8')
    snapshot = live_clock.snapshot(playlist, streamer.current_channel_id)
    snapshot['durations'] = [float(line.split(':', 1)[1].split(',')[0])
        for line in playlist.read_text().splitlines() if line.startswith('#EXTINF:')]
    return jsonify(snapshot)


@app.post('/test/start')
def start():
    # Test-only bootstrap calls the production route body; browser channel
    # selection below uses its normal authenticated HTTP endpoint.
    return play_channel.__wrapped__(1)


@app.post('/test/fail/<mode>')
def fail(mode):
    if mode == 'exit':
        streamer.process.terminate()
    elif mode == 'freeze' and hasattr(signal, 'SIGSTOP'):
        os.kill(streamer.process.pid, signal.SIGSTOP)
    else:
        return '', 400
    return jsonify(session=streamer.session_id)


@app.post('/test/stop')
def stop():
    streamer.stop_stream()
    db.session.remove()
    for engine in db.engines.values():
        engine.dispose()
    target = directory.resolve()
    assert target.parent == Path(tempfile.gettempdir()).resolve() and target.name.startswith('peak-live-clock-')
    temporary.cleanup()
    return jsonify(stopped=True)


with app.app_context():
    db.create_all()
    for i in range(15):
        db.session.add(User(id=str(i), username=f'live-test-{i}', email=f'live{i}@example.invalid', is_verified=True))
    for i in [1, 2]:
        db.session.add(Channel(id=i, name=f'Synthetic live sports {i}', url='fixture', is_playing='0'))
    db.session.add(Channel(id=4, name='Video only', url='fixture-no-audio', is_playing='0'))
    db.session.add(Channel(id=3, name='Unavailable test channel', url=str(directory / 'missing-input.ts'), is_playing='0'))
    db.session.commit()

try:
    socketio.run(app, host='127.0.0.1', port=int(os.environ.get('LIVE_TEST_PORT', '18767')), log_output=False)
finally:
    streamer.stop_stream()
    with app.app_context():
        db.session.remove()
        for engine in db.engines.values():
            engine.dispose()
    temporary.cleanup()
