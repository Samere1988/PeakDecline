import os
import uuid
import time
import math
import re
import requests
from datetime import datetime, timedelta
from urllib.parse import urlencode, unquote

from flask import Blueprint, render_template, jsonify, send_from_directory, current_app, url_for, Response, request, redirect
from flask_login import login_required, current_user
from flask_socketio import emit, join_room

from . import db, socketio
from .models import Channel, ChannelPlayCount, Room
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from app.utils import get_plex_server
from app.services.streamer import streamer

main_bp = Blueprint('main', __name__)

# In-memory live state used for fast Socket.IO sync.
# The Room database row is also updated on important state changes so refresh/rejoin works.
room_states = {}
room_revisions = {}
playback_epoch = uuid.uuid4().hex

# Grace periods prevent rooms/host ownership from changing during a normal browser refresh.
ROOM_EMPTY_GRACE_SECONDS = 60
HOST_TRANSFER_GRACE_SECONDS = 25

# --- Global User Tracking ---
online_users = set()
online_last_seen = {}
connected_sids = {}

# Live TV page-specific presence
live_tv_occupancy = {}  # sid -> username
live_tv_empty_token = None
live_tv_watchdog_token = None


def _schedule_empty_live_tv_cleanup():
    """Called under streamer.lock; rejoining invalidates an older countdown."""
    global live_tv_empty_token
    if live_tv_occupancy:
        return
    token = live_tv_empty_token = uuid.uuid4().hex
    app = current_app._get_current_object()
    delay = app.config.get('LIVE_TV_EMPTY_GRACE_SECONDS', 60)

    def stop_if_still_empty():
        global live_tv_empty_token
        socketio.sleep(delay)
        with app.app_context(), streamer.lock:
            if token != live_tv_empty_token or live_tv_occupancy:
                return
            live_tv_empty_token = None
            if streamer.process is None and not streamer.recovering:
                return
            streamer.revision += 1
            try:
                streamer.stop_stream()
                Channel.query.update({Channel.is_playing: '0'})
                db.session.commit()
            finally:
                streamer.revision += 1
            socketio.emit('channel_changed', _live_status())

    socketio.start_background_task(stop_if_still_empty)

def _ensure_live_watchdog():
    """One supervisor for each explicit channel selection, never one per viewer."""
    global live_tv_watchdog_token
    token = streamer.watchdog_token
    if not token or token == live_tv_watchdog_token:
        return
    live_tv_watchdog_token = token
    app = current_app._get_current_object()

    def monitor():
        while True:
            socketio.sleep(2)
            with app.app_context(), streamer.lock:
                try:
                    result = streamer.watchdog_step(token)
                    if result == 'stopped':
                        return
                    if result:
                        Channel.query.update({Channel.is_playing: '0'})
                        if streamer.current_channel_id:
                            channel = db.session.get(Channel, streamer.current_channel_id)
                            if channel:
                                channel.is_playing = '1'
                        db.session.commit()
                        socketio.emit('channel_changed', _live_status())
                        if result == 'failed':
                            return
                except Exception:
                    db.session.rollback()
                    # Keep supervising after a transient disk/DB failure. Do not
                    # include source URLs or subprocess arguments in diagnostics.
                    app.logger.warning('Live TV supervisor tick failed; retrying')

    socketio.start_background_task(monitor)


# Watch Together room-specific presence
room_occupancy = {}  # room_id -> {sid: username}
sid_to_room = {}


# --- HELPER: Get Public IP ---
def get_public_ip():
    try:
        return requests.get('https://api.ipify.org', timeout=5).text.strip()
    except Exception as e:
        print(f"Error fetching Public IP: {e}")
        return None


# --- WATCH ROOM HELPERS ---
def _now():
    return time.time()
def _plex_playback_headers(room_id):
    """
    Stable Plex client identity for a PeakDecline room.

    The client identifier should remain stable across:
    - seeks
    - audio changes
    - subtitle changes
    - transcode restarts
    """
    client_id = f"peak-decline-room-{room_id}"

    return {
        'X-Plex-Client-Identifier': client_id,
        'X-Plex-Session-Identifier': client_id,
        'X-Plex-Product': 'PeakDecline',
        'X-Plex-Device': 'Web',
        'X-Plex-Device-Name': 'PeakDecline Watch Together',
        'X-Plex-Platform': 'Web',
        'X-Plex-Version': '1.0'
    }

def _room_key(room_id):
    return str(room_id)


def _unique_live_tv_users():
    users = []
    seen = set()

    for username in live_tv_occupancy.values():
        if username not in seen:
            users.append(username)
            seen.add(username)

    return users


def _viewer_profiles(names):
    from .models import User
    profiles = {user.username: user for user in User.query.filter(User.username.in_(names)).all()}
    return [dict(name=name, avatar='/profile/pictures/' + profiles[name].avatar if name in profiles and profiles[name].avatar else '/static/img/avatar-default.svg') for name in names]


def _emit_live_tv_users():
    socketio.emit("live_tv_profiles_update", _viewer_profiles(_unique_live_tv_users()), to="live_tv")
    socketio.emit(
        "live_tv_users_update",
        _unique_live_tv_users(),
        to="live_tv"
    )



def _unique_room_users(room_id):
    """Return unique usernames in join order for a room."""
    users = []
    seen = set()
    for username in room_occupancy.get(_room_key(room_id), {}).values():
        if username not in seen:
            users.append(username)
            seen.add(username)
    return users


def _emit_room_users(room_id):
    socketio.emit("room_profiles_update", _viewer_profiles(_unique_room_users(room_id)), to=f"room_{_room_key(room_id)}")
    socketio.emit(
        "room_users_update",
        _unique_room_users(room_id),
        to=f"room_{_room_key(room_id)}"
    )


def _youtube_room_snapshot(room):
    import re
    from app.services.youtube_downloads import youtube_downloads
    match = re.fullmatch(r'/api/room/youtube-files/([a-f0-9]{32})/index\.m3u8', room.current_media_url or '')
    if match:
        return youtube_downloads.playlist_snapshot(youtube_downloads.root(current_app) / match[1])
    return None


def _get_room_state_payload(room):
    """Build a reconnect-safe state payload for the current room."""
    if not room or not room.current_media_url:
        return None

    room_id = _room_key(room.id)
    state = room_states.get(room_id, {})
    if state.get("status") == "game":
        return None

    status = state.get("status")
    if not status:
        status = "playing" if room.is_playing else "paused"

    offset = float(state.get("offset", room.current_time or 0.0) or 0.0)
    start_time = float(state.get("start_time", _now()) or _now())

    if status == "playing":
        current_time = max(0.0, offset + (_now() - start_time))
    else:
        current_time = max(0.0, offset)

    return {
        "room_id": room.id,
        "url": room.current_media_url,
        "title": room.current_media_title,
        "rating_key": room.current_media_key,
        "youtube": _youtube_room_snapshot(room),
        "status": status,
        "is_playing": status == "playing",
        "current_time": current_time,
        "start_time": start_time,
        "offset": offset,
        "server_epoch": _now(),
        "playback_epoch": playback_epoch,
        "revision": room_revisions.get(room_id, 0),
        "media_version": state.get("media_version", ""),
        "playback_intent": status in ("playing", "buffering"),
        "buffer_id": state.get("buffer_id"),
    }


def _save_room_playback_state(room_id, status, offset=None, start_time=None,
                              buffer_id=None, new_media=False):
    """Keep memory and database playback state aligned."""
    room_id = _room_key(room_id)
    start_time = float(start_time if start_time is not None else _now())
    offset = float(offset or 0.0)

    previous = room_states.get(room_id, {})
    room_revisions[room_id] = room_revisions.get(room_id, 0) + 1
    room_states[room_id] = {
        "start_time": start_time,
        "offset": offset,
        "status": status,
        "media_version": uuid.uuid4().hex if new_media else previous.get("media_version", ""),
        "buffer_id": buffer_id,
    }

    room = Room.query.get(int(room_id))
    if room:
        room.is_playing = status == "playing"
        room.current_time = offset
        room.last_updated = datetime.utcnow()
        db.session.commit()

    return room_states[room_id]


def _is_current_user_room_host(room_id):
    if not current_user.is_authenticated:
        return False

    room = Room.query.get(int(room_id))
    if not room:
        return False

    return str(room.host_id) == str(current_user.id)


def _schedule_empty_room_cleanup(room_id):
    room_id = _room_key(room_id)
    app = current_app._get_current_object()

    def cleanup_after_grace(target_room_id):
        socketio.sleep(ROOM_EMPTY_GRACE_SECONDS)

        # Someone rejoined during the grace period.
        if room_occupancy.get(target_room_id):
            return

        with app.app_context():
            # Check one more time inside the app context before deleting.
            if room_occupancy.get(target_room_id):
                return

            room_occupancy.pop(target_room_id, None)
            room_states.pop(target_room_id, None)

            room_to_delete = Room.query.get(int(target_room_id))
            if room_to_delete:
                db.session.delete(room_to_delete)
                db.session.commit()

    socketio.start_background_task(cleanup_after_grace, room_id)

def _cleanup_stale_empty_rooms():
    cutoff = datetime.utcnow() - timedelta(seconds=ROOM_EMPTY_GRACE_SECONDS)

    rooms = Room.query.all()
    deleted_any = False

    for room in rooms:
        room_id = _room_key(room.id)
        active_users = room_occupancy.get(room_id, {})

        # If the room has active sockets, do not delete it.
        if active_users:
            continue

        # Do not delete brand-new rooms immediately. Give the host time to enter.
        if room.last_updated and room.last_updated > cutoff:
            continue

        room_occupancy.pop(room_id, None)
        room_states.pop(room_id, None)

        db.session.delete(room)
        deleted_any = True

    if deleted_any:
        db.session.commit()

def _schedule_host_transfer(room_id, leaving_username):
    room_id = _room_key(room_id)
    app = current_app._get_current_object()

    def transfer_after_grace(target_room_id, old_host_username):
        socketio.sleep(HOST_TRANSFER_GRACE_SECONDS)

        # Host came back during the grace period.
        if old_host_username in _unique_room_users(target_room_id):
            return

        users = _unique_room_users(target_room_id)
        if not users:
            with app.app_context():
                room_occupancy.pop(target_room_id, None)
                room_states.pop(target_room_id, None)
                room_to_delete = Room.query.get(int(target_room_id))
                if room_to_delete:
                    db.session.delete(room_to_delete)
                    db.session.commit()
            return

        with app.app_context():
            room = Room.query.get(int(target_room_id))
            if not room:
                return

            from app.models import User

            new_host_username = users[0]
            new_host_user = User.query.filter_by(username=new_host_username).first()
            if not new_host_user:
                return

            room.host_id = new_host_user.id
            db.session.commit()

        socketio.emit("host_changed", {"new_host": new_host_username}, to=f"room_{target_room_id}")
        with app.app_context():
            _emit_room_users(target_room_id)

    socketio.start_background_task(transfer_after_grace, room_id, leaving_username)


# --- SOCKET.IO: CONNECTION / USER TRACKING ---
@socketio.on("connect")
def sio_connect():
    username = current_user.username if current_user.is_authenticated else "Guest"
    connected_sids[request.sid] = username
    online_users.add(username)
    online_last_seen[username] = _now()
    socketio.emit("update_users", sorted(list(online_users)))


@socketio.on("join_live_tv")
def handle_join_live_tv():
    global live_tv_empty_token
    if not current_user.is_authenticated:
        return
    join_room("live_tv")

    username = current_user.username if current_user.is_authenticated else "Guest"
    with streamer.lock:
        live_tv_occupancy[request.sid] = username
        live_tv_empty_token = None

    _emit_live_tv_users()


@socketio.on("request_live_tv_users")
def handle_request_live_tv_users():
    emit("live_tv_users_update", _unique_live_tv_users())

@socketio.on("join_watch_room")
def on_join_watch_room(data):
    room_id = _room_key(data.get('room_id'))
    if not room_id:
        return

    room = Room.query.get(int(room_id))
    if not room:
        emit("room_missing", {"room_id": room_id, "message": "Room no longer exists."}, to=request.sid)
        return

    join_room(f"room_{room_id}")

    username = current_user.username if current_user.is_authenticated else "Guest"
    sid_to_room[request.sid] = room_id

    if room_id not in room_occupancy:
        room_occupancy[room_id] = {}
    room_occupancy[room_id][request.sid] = username
    room.last_updated = datetime.utcnow()
    db.session.commit()

    _emit_room_users(room_id)

    game_state = room_states.get(room_id, {})
    if game_state.get("status") == "game":
        emit("host_started_game", {
            "room_id": room_id,
            "game_name": game_state.get("game_name", "A Game")
        }, to=request.sid)
        return

    # Otherwise send current Plex playback state.
    state_payload = _get_room_state_payload(room)
    if state_payload:
        emit("room_state", state_payload, to=request.sid)

@socketio.on("disconnect")
def sio_disconnect(reason=None):
    # 1. Standard User Tracking Cleanup
    username = connected_sids.pop(request.sid, None)
    if username and username not in connected_sids.values():
        online_users.discard(username)
        online_last_seen.pop(username, None)

    socketio.emit("update_users", sorted(list(online_users)))

    # 1B. Live TV Presence Cleanup
    with streamer.lock:
        if request.sid in live_tv_occupancy:
            live_tv_occupancy.pop(request.sid, None)
            _emit_live_tv_users()
            if not live_tv_occupancy:
                _schedule_empty_live_tv_cleanup()

    # 2. Watch Together Room Occupancy Cleanup
    room_id = sid_to_room.pop(request.sid, None)

    # Important:
    # If this socket was only on Live TV, it will not have a Watch Together room.
    if not room_id or room_id not in room_occupancy:
        return

    leaving_username = room_occupancy[room_id].pop(request.sid, None)

    # 3. If room is empty, wait before deleting. This avoids deleting during refresh.
    if len(room_occupancy[room_id]) == 0:
        _emit_room_users(room_id)
        _schedule_empty_room_cleanup(room_id)
        return

    # 4. If the host disconnected, wait before transferring. This avoids transfer during refresh.
    room = Room.query.get(int(room_id))
    if room and room.host and room.host.username == leaving_username:
        _schedule_host_transfer(room_id, leaving_username)

    _emit_room_users(room_id)


@socketio.on("transfer_host")
def handle_transfer_host(data):
    room_id = _room_key(data.get('room_id'))
    new_host_username = data.get('new_host')

    room = Room.query.get(int(room_id))
    if room and current_user.is_authenticated and str(room.host_id) == str(current_user.id):
        from app.models import User

        new_user = User.query.filter_by(username=new_host_username).first()
        if new_user:
            room.host_id = new_user.id
            db.session.commit()

            socketio.emit("host_changed", {"new_host": new_host_username}, to=f"room_{room_id}")
            _emit_room_users(room_id)


@socketio.on("chat_message")
def sio_chat_message(message):
    username = connected_sids.get(request.sid) or (
        current_user.username if current_user.is_authenticated else "Guest"
    )

    if isinstance(message, dict):
        text = message.get("text", "").strip()
        room_id = message.get("room_id")
    else:
        text = str(message).strip()
        room_id = None

    if not text:
        return

    if room_id:
        socketio.emit("chat_message", {"user": current_user.username if current_user.is_authenticated else username, "avatar": current_user.avatar_url if current_user.is_authenticated else "/static/img/avatar-default.svg", "text": text[:500]}, to=f"room_{_room_key(room_id)}")
    else:
        socketio.emit("chat_message", {"user": current_user.username if current_user.is_authenticated else username, "avatar": current_user.avatar_url if current_user.is_authenticated else "/static/img/avatar-default.svg", "text": text[:500]})


@socketio.on("request_users")
def sio_request_users():
    emit("update_users", sorted(list(online_users)))


# --- STANDARD ROUTES ---
@main_bp.route('/')
def index():
    return render_template('index.html')


@main_bp.route('/requests')
def plex_requests():
    return redirect(current_app.config.get('PLEX_REQUESTS_URL') or os.getenv('PLEX_REQUESTS_URL', 'https://requests.peakdecline.com'))


@main_bp.route('/live-tv')
@login_required
def live_tv():
    return render_template('live_tv.html')


@main_bp.route('/plex-watch-together')
@login_required
def plex_landing():
    _cleanup_stale_empty_rooms()
    rooms = Room.query.order_by(Room.id.desc()).all()
    return render_template('plex_landing.html', rooms=rooms)


# --- API: CHANNELS & PLAYBACK ---
@main_bp.route('/api/channels/<int:channel_id>/guide')
@login_required
def channel_guide(channel_id):
    Channel.query.get_or_404(channel_id)
    from .services.guide import lookup
    response = jsonify(lookup(channel_id))
    response.headers['Cache-Control'] = 'no-store'
    return response

@main_bp.route('/channel-logos/<filename>')
def cached_channel_logo(filename):
    import re
    if not re.fullmatch(r'[a-f0-9]{64}\.(png|jpg|webp|gif)', filename):
        return '', 404
    response = send_from_directory(os.path.join(current_app.static_folder, 'img', 'channel-cache'), filename, max_age=31536000)
    response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@main_bp.route('/api/channels')
@login_required
def get_channels():
    channels = (db.session.query(Channel, ChannelPlayCount.play_count)
                .outerjoin(ChannelPlayCount, Channel.id == ChannelPlayCount.channel_id)
                .order_by(db.func.coalesce(ChannelPlayCount.play_count, 0).desc(),
                          db.func.lower(Channel.name), Channel.id).all())
    channel_list = []
    for channel, play_count in channels:
        channel_list.append({
            'id': int(channel.id),
            'play_count': play_count or 0,
            'name': channel.name,
            'Favorites': str(channel.favorites).lower() in ['1', 'true', 'yes'],
            'is_playing': str(channel.is_playing).lower() in ['1', 'true', 'yes'],
            'logo': channel.logo
        })
    response = jsonify(channel_list)
    response.headers['Cache-Control'] = 'no-store'
    return response


@main_bp.route('/api/channels/<int:channel_id>/favorite', methods=['PUT'])
@login_required
def set_channel_favorite(channel_id):
    channel = Channel.query.get_or_404(channel_id)
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or type(data.get('favorite')) is not bool:
        return jsonify(error='favorite must be a boolean'), 400
    channel.favorites = '1' if data['favorite'] else '0'
    db.session.commit()
    socketio.emit('channels_updated')
    return jsonify(id=int(channel.id), Favorites=data['favorite'])


@main_bp.route('/api/play/<int:channel_id>', methods=['POST'])
@login_required
def play_channel(channel_id):
    channel = Channel.query.get_or_404(channel_id)
    with streamer.lock:
        if (str(streamer.current_channel_id) == str(channel_id) and streamer.process
                and not streamer.recovering and streamer.healthy()):
            success, msg = True, 'Channel already playing'
        else:
            success, msg = streamer.start_stream(channel_id, channel.url, channel.name)
        Channel.query.update({Channel.is_playing: '0'})
        if success:
            channel.is_playing = '1'
            statement = sqlite_insert(ChannelPlayCount).values(channel_id=channel.id, play_count=1)
            db.session.execute(statement.on_conflict_do_update(
                index_elements=['channel_id'],
                set_={'play_count': ChannelPlayCount.play_count + 1}))
        db.session.commit()
        state = _live_status()
        socketio.emit('channel_changed', state)
        if success:
            _ensure_live_watchdog()
            socketio.emit('channels_updated')
            if not live_tv_occupancy:
                _schedule_empty_live_tv_cleanup()
            return jsonify(status='success', message=msg, state=state)
        return jsonify(error=msg, state=state), 500


@main_bp.route('/api/status')
@login_required
def api_status():
    response = jsonify(_live_status())
    response.headers['Cache-Control'] = 'no-store'
    return response


@main_bp.route('/api/live/stop', methods=['POST'])
@login_required
def stop_live_stream():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error='Expected stream session'), 400
    with streamer.lock:
        if data.get('stream_session') != streamer.session_id:
            return jsonify(error='Stream changed. Try again.', state=_live_status()), 409
        streamer.revision += 1
        try:
            streamer.stop_stream()
            Channel.query.update({Channel.is_playing: '0'})
            db.session.commit()
        finally:
            streamer.revision += 1
        state = _live_status()
        socketio.emit('channel_changed', state)
        socketio.emit('channels_updated')
        return jsonify(state=state)


def _live_status():
    running = streamer.process is not None and streamer.process.poll() is None
    recovering = streamer.recovering or bool(streamer.source and streamer.watchdog_token and not running)
    channel_id = streamer.source[0] if recovering and streamer.source else streamer.current_channel_id
    active_channel = db.session.get(Channel, channel_id) if (running or recovering) and channel_id else None
    return {
        "is_streaming": active_channel is not None,
        "current_channel_id": int(active_channel.id) if active_channel else None,
        "current_channel_name": active_channel.name if active_channel else None,
        "current_channel_logo": active_channel.logo if active_channel else None,
        "stream_epoch": streamer.epoch,
        "stream_revision": streamer.revision,
        "stream_session": streamer.session_id,
        "stream_recovering": recovering,
    }


# --- API: USER TRACKING ---
@main_bp.route('/api/live-clock/<int:channel_id>')
@login_required
def live_clock_state(channel_id):
    from .services.live_clock import live_clock
    if (str(streamer.current_channel_id) != str(channel_id) or not streamer.process
            or streamer.process.poll() is not None):
        return jsonify(error='Stream unavailable', reason='inactive_stream'), 503
    playlist = streamer.clock_playlist_path
    if not playlist and streamer.current_channel_dir:
        # The root index is a master playlist with no chunk timestamps.
        native = os.path.join(streamer.current_channel_dir, '0', 'index.m3u8')
        playlist = native if os.path.isfile(native) else os.path.join(streamer.current_channel_dir, 'index.m3u8')
    if not playlist:
        return jsonify(error='Stream clock unavailable', reason='missing_playlist'), 503
    try:
        snapshot = live_clock.snapshot(playlist, channel_id)
    except OSError:
        return jsonify(error='Stream clock unavailable', reason='unreadable_playlist'), 503
    except (ValueError, OverflowError):
        return jsonify(error='Stream clock unavailable', reason='invalid_timestamps'), 503
    snapshot.update(stream_epoch=streamer.epoch, stream_session=streamer.session_id)
    response = jsonify(snapshot)
    response.headers['Cache-Control'] = 'no-store'
    return response


@main_bp.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    if current_user.is_authenticated:
        username = current_user.username
        online_users.add(username)
        online_last_seen[username] = _now()
    return jsonify({'status': 'alive'})


@main_bp.route('/api/online_users')
def get_online_users():
    now = _now()
    cutoff = now - 15
    to_remove = [u for u, ts in online_last_seen.items() if ts < cutoff]

    for user in to_remove:
        online_users.discard(user)
        online_last_seen.pop(user, None)

    return jsonify(sorted(list(online_users)))


# --- STATIC & STREAM SERVING ---
_LIVE_MEDIA = re.compile(r"[0-9]+/(?:[012]/)?(?:index\.m3u8|seg_[a-f0-9]{8}_[0-9]+\.ts)\Z")


@main_bp.before_app_request
def protect_live_media():
    # Covers Flask's built-in static route as well as the legacy /stream alias.
    for prefix in ('/static/stream/', '/stream/'):
        if request.path.startswith(prefix):
            filename = request.path[len(prefix):]
            if not _LIVE_MEDIA.fullmatch(filename):
                return '', 404
            if not current_user.is_authenticated:
                return '', 401, {'Cache-Control': 'no-store'}
            mimetype = 'application/vnd.apple.mpegurl' if filename.endswith('.m3u8') else 'video/mp2t'
            response = send_from_directory(streamer.stream_root, filename, mimetype=mimetype, max_age=0)
            response.headers.update({'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})
            return response


@main_bp.get('/api/live/media-auth')
def live_media_auth():
    # nginx uses an internal auth_request subrequest before serving media itself.
    if not current_user.is_authenticated:
        return '', 401, {'Cache-Control': 'no-store'}
    return '', 204, {'Cache-Control': 'no-store'}


@main_bp.route('/stream/<path:filename>')
def serve_stream(filename):
    # protect_live_media serves valid media before this handler is reached.
    return '', 404


@main_bp.route('/static/<path:filename>')
def custom_static_handler(filename):
    static_dir = os.path.join(current_app.root_path, 'static')
    return send_from_directory(static_dir, filename)


# --- PLEX WATCH PARTY ROUTES ---
@main_bp.route('/create-room', methods=['POST'])
@login_required
def create_room():
    data = request.get_json() or {}
    room_name = data.get('name')

    if not room_name:
        return jsonify({'error': 'Room name is required'}), 400

    new_room = Room(name=room_name, host_id=current_user.id)
    db.session.add(new_room)
    db.session.commit()

    return jsonify({'success': True, 'redirect_url': url_for('main.room_view', room_id=new_room.id)})


@main_bp.route('/plex-watch-together/room/<int:room_id>')
@login_required
def room_view(room_id):
    room = Room.query.get_or_404(room_id)
    return render_template('room.html', room=room)

def _plex_watch_state(item):
    playable = getattr(item, 'type', '') in ('movie', 'episode')

    if not playable:
        return {
            'view_offset_ms': 0,
            'duration_ms': 0,
            'watched': False,
            'is_resume': False,
            'progress_percent': 0
        }

    view_offset_ms = int(getattr(item, 'viewOffset', 0) or 0)
    duration_ms = int(getattr(item, 'duration', 0) or 0)
    view_count = int(getattr(item, 'viewCount', 0) or 0)

    watched = view_count > 0
    is_resume = view_offset_ms > 0 and not watched

    progress_percent = 0
    if duration_ms > 0:
        progress_percent = round(
            min(100, max(0, (view_offset_ms / duration_ms) * 100)),
            1
        )

    return {
        'view_offset_ms': view_offset_ms,
        'duration_ms': duration_ms,
        'watched': watched,
        'is_resume': is_resume,
        'progress_percent': progress_percent
    }

@main_bp.route('/api/plex/search')
@login_required
def search_plex_library():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])

    plex = get_plex_server()
    if not plex:
        return jsonify({'error': 'Could not connect to Plex Server'}), 500

    rating_key = None
    if 'key=' in query:
        try:
            clean = unquote(query)
            start = clean.find('key=') + 4
            end = clean.find('&', start)
            val = clean[start:] if end == -1 else clean[start:end]
            rating_key = val.split('/')[-1] if '/' in val else val
        except Exception:
            pass
    elif query.isdigit():
        rating_key = query

    try:
        if rating_key:
            try:
                results = [plex.fetchItem(int(rating_key))]
            except Exception:
                results = plex.search(query)
        else:
            results = plex.search(query)
    except Exception:
        return jsonify({'error': 'Search failed'}), 500

    output = []
    for item in results:
        if item.type not in ['movie', 'show', 'season', 'episode']:
            continue

        result = {
            'title': item.title,
            'year': item.year,
            'thumb': item.thumb,
            'key': item.ratingKey,
            'type': item.type.capitalize()
        }

        result.update(_plex_watch_state(item))
        output.append(result)
    return jsonify(output)


@main_bp.route('/api/plex/children')
@login_required
def get_plex_children():
    rating_key = request.args.get('key')
    if not rating_key:
        return jsonify([])

    plex = get_plex_server()
    try:
        parent = plex.fetchItem(int(rating_key))
        if parent.type == 'show':
            children = parent.seasons()
        elif parent.type == 'season':
            children = parent.episodes()
        else:
            return jsonify([])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    results = []
    for item in children:
        title = item.title
        if item.type == 'season':
            title = f"Season {item.index}"
        if item.type == 'episode':
            show_title = getattr(parent, 'parentTitle', 'Unknown Show')
            title = f"{show_title}, S{item.seasonNumber}:E{item.index} - {item.title}"

        result = {
            'title': title,
            'year': getattr(item, 'year', ''),
            'thumb': item.thumb if item.thumb else parent.thumb,
            'key': item.ratingKey,
            'type': item.type.capitalize(),
            'parent_title': parent.title
        }

        result.update(_plex_watch_state(item))
        results.append(result)
    return jsonify(results)


@main_bp.route('/api/plex/image')
@login_required
def proxy_plex_image():
    thumb_path = request.args.get('path')
    if not thumb_path:
        return "Missing path", 400

    plex = get_plex_server()
    try:
        img_url = plex.transcodeImage(thumb_path, height=450, width=300, minSize=1, upscale=1)
        resp = requests.get(img_url, stream=True)
        return Response(
            resp.content,
            status=resp.status_code,
            content_type=resp.headers.get('content-type', 'image/jpeg')
        )
    except Exception:
        return "Error", 500


@main_bp.route('/api/room/<room_id>/set_youtube', methods=['POST'])
@login_required
def set_room_youtube(room_id):
    from app.services.youtube import parse_youtube_url

    room = db.session.get(Room, room_id)
    if not room:
        return jsonify(error='Room not found'), 404
    if str(room.host_id) != str(current_user.id):
        return jsonify(error='Only the host can change media'), 403
    data = request.get_json(silent=True)
    try:
        video_id, offset = parse_youtube_url(data.get('url') if isinstance(data, dict) else None)
    except ValueError as error:
        return jsonify(error=str(error)), 400
    from app.services.youtube_downloads import youtube_downloads
    try:
        job = youtube_downloads.start(
            current_app._get_current_object(), room.id, current_user.id, video_id, offset,
            room_states.get(str(room.id), {}).get('media_version', ''), room.current_media_url, socketio)
    except ValueError as error:
        return jsonify(error=str(error)), 409
    return jsonify(success=True, **job), 202


@main_bp.route('/api/room/<room_id>/youtube-status')
@login_required
def youtube_status(room_id):
    from app.services.youtube_downloads import youtube_downloads
    room = db.session.get(Room, room_id)
    if not room:
        return jsonify(error='Room not found'), 404
    job = youtube_downloads.jobs.get(str(room_id))
    return jsonify(youtube_downloads.public(job) if job else {'state': 'idle', 'message': ''})


@main_bp.route('/api/room/youtube-files/<job_id>/<filename>')
@login_required
def youtube_file(job_id, filename):
    import re
    from app.services.youtube_downloads import youtube_downloads
    if (not re.fullmatch(r'[a-f0-9]{32}', job_id)
            or not re.fullmatch(r'(index\.m3u8|seg_[0-9]+\.ts)', filename)):
        return jsonify(error='File not found'), 404
    directory = youtube_downloads.root(current_app) / job_id
    mimetype = 'application/vnd.apple.mpegurl' if filename.endswith('.m3u8') else 'video/mp2t'
    if filename.endswith('.m3u8'):
        # EVENT playlists grow while FFmpeg runs. Never cache an earlier snapshot.
        try:
            playlist = (directory / filename).read_text()
        except OSError:
            return jsonify(error='Playlist not ready'), 404
        playlist = playlist.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES', 1)
        return Response(playlist, mimetype=mimetype, headers={'Cache-Control': 'no-store'})
    return send_from_directory(directory, filename, mimetype=mimetype, conditional=True, max_age=3600)


@main_bp.route(
    '/api/room/<room_id>/set_media',
    methods=['POST']
)
@login_required
def set_room_media(room_id):
    data = request.get_json(silent=True) or {}

    rating_key = data.get('rating_key')

    if not rating_key:
        return jsonify({
            'error': 'Missing rating_key'
        }), 400


    room = Room.query.get(room_id)

    if not room:
        return jsonify({
            'error': 'Room not found'
        }), 404


    if str(room.host_id) != str(current_user.id):
        return jsonify({
            'error': 'Only the host can change media'
        }), 403


    try:
        view_offset = float(
            data.get('view_offset', 0) or 0
        )
    except (TypeError, ValueError):
        return jsonify({
            'error': 'Invalid playback position'
        }), 400


    if (
        not math.isfinite(view_offset)
        or view_offset < 0
    ):
        return jsonify({
            'error': 'Invalid playback position'
        }), 400


    audio_id = data.get(
        'audio_stream_id'
    )

    subtitle_id = data.get(
        'subtitle_stream_id'
    )


    raw_max_video_bitrate = data.get(
        'max_video_bitrate',
        8000
    )


    try:
        max_video_bitrate = int(
            raw_max_video_bitrate
        )
    except (TypeError, ValueError):
        return jsonify({
            'error': 'Invalid video quality'
        }), 400


    allowed_video_bitrates = {
        0,
        2000,
        4000,
        8000,
        12000,
        20000
    }


    if (
        max_video_bitrate
        not in allowed_video_bitrates
    ):
        return jsonify({
            'error': 'Invalid video quality'
        }), 400


    plex = get_plex_server()

    if not plex:
        return jsonify({
            'error': 'Plex unavailable'
        }), 500


    try:
        item = plex.fetchItem(
            int(rating_key)
        )

        # ==========================================
        # APPLY AUDIO / SUBTITLE SELECTION TO PLEX
        # ==========================================
        #
        # Plex's universal transcoder chooses the streams
        # marked "selected" on the media part.
        #
        # audioStreamID/subtitleStreamID in the transcode
        # URL alone are not reliably honored.
        # ==========================================

        if not item.media or not item.media[0].parts:
            return jsonify({
                'error': 'Plex media has no playable part'
            }), 400

        media = item.media[0]
        part = media.parts[0]

        selection_params = {
            'allParts': 1
        }

        selection_changed = False

        # ------------------------------------------
        # AUDIO
        # ------------------------------------------

        if (
                'audio_stream_id' in data
                and audio_id not in (None, '')
        ):
            requested_audio_id = int(audio_id)

            valid_audio_ids = {
                int(stream.id)
                for stream in part.audioStreams()
            }

            if requested_audio_id not in valid_audio_ids:
                return jsonify({
                    'error': 'Invalid Plex audio stream'
                }), 400

            selection_params[
                'audioStreamID'
            ] = requested_audio_id

            selection_changed = True

        # ------------------------------------------
        # SUBTITLES
        # ------------------------------------------

        if 'subtitle_stream_id' in data:

            if subtitle_id in (None, ''):
                # Explicitly turn subtitles off.
                selection_params[
                    'subtitleStreamID'
                ] = 0

                selection_changed = True

            else:
                requested_subtitle_id = int(
                    subtitle_id
                )

                valid_subtitle_ids = {
                    int(stream.id)
                    for stream in part.subtitleStreams()
                }

                if (
                        requested_subtitle_id
                        not in valid_subtitle_ids
                ):
                    return jsonify({
                        'error':
                            'Invalid Plex subtitle stream'
                    }), 400

                selection_params[
                    'subtitleStreamID'
                ] = requested_subtitle_id

                selection_changed = True

        # ------------------------------------------
        # Tell Plex which streams this user selected.
        # ------------------------------------------

        if selection_changed:
            plex.query(
                f'/library/parts/{part.id}',
                method=plex._session.put,
                params=selection_params
            )

            # Give Plex a moment to persist the selection.
            time.sleep(0.15)

            # Reload metadata so the universal transcode
            # decision sees the newly selected streams.
            item = plex.fetchItem(
                int(rating_key)
            )

            media = item.media[0]
            part = media.parts[0]

            print('\nPLEX SELECTION AFTER UPDATE:')

            for stream in part.audioStreams():
                print(
                    'AUDIO',
                    stream.id,
                    stream.language,
                    'selected=',
                    bool(stream.selected)
                )

            for stream in part.subtitleStreams():
                print(
                    'SUBTITLE',
                    stream.id,
                    stream.language,
                    'selected=',
                    bool(stream.selected)
                )
        # -------------------------------------------------
        # TRANSCODE SESSION
        # -------------------------------------------------
        #
        # The Plex CLIENT identity remains stable for the
        # room, but each actual transcoder gets its own ID.
        #
        # This prevents a settings change from colliding
        # with an older transcode.
        # -------------------------------------------------

        transcode_session_id = (
            uuid.uuid4().hex
        )

        plex_headers = (
            _plex_playback_headers(
                room_id
            )
        )

        params = {
            'path': item.key,

            'mediaIndex': 0,
            'partIndex': 0,

            'protocol': 'hls',

            'fastSeek': 1,

            'directPlay': 0,
            'directStream': 1,

            # Important:
            # Allow Plex to rebuild the audio stream around
            # the explicitly requested audioStreamID.
            'directStreamAudio': 0,

            'hasMDE': 1,

            'subtitleSize': 100,
            'audioBoost': 100,

            'workaround': 'nvidia-shallow',

            'copyts': 1,

            'mediaBufferSize': 102400,

            'session': transcode_session_id,

            # Use Plex's Chrome profile because we're serving
            # HLS to a web browser.
            'X-Plex-Client-Profile-Name': 'Chrome',

            # Critical for selecting a non-default audio/subtitle
            # stream on this transcode without modifying the Plex
            # library's globally selected stream.
            'X-Plex-Client-Profile-Extra': (
                'add-settings('
                'DirectPlayStreamSelection=true'
                '&StreamUnselectedIncompatibleAudioStreams=true'
                ')'
            ),

            'X-Plex-Client-Identifier':
                plex_headers[
                    'X-Plex-Client-Identifier'
                ],

            'X-Plex-Session-Identifier':
                plex_headers[
                    'X-Plex-Session-Identifier'
                ],

            'X-Plex-Product':
                plex_headers[
                    'X-Plex-Product'
                ],

            'X-Plex-Device':
                plex_headers[
                    'X-Plex-Device'
                ],

            'X-Plex-Device-Name':
                plex_headers[
                    'X-Plex-Device-Name'
                ],

            'X-Plex-Platform':
                'Web',

            'X-Plex-Version':
                plex_headers[
                    'X-Plex-Version'
                ],

            'X-Plex-Token':
                plex._token
        }

        # Start at the same playback position after
        # changing language/subtitles/quality.
        if view_offset > 0:
            params['offset'] = round(
                view_offset,
                3
            )

        # ==========================================
        # AUDIO
        # ==========================================

        if audio_id not in (
                None,
                ''
        ):
            params['audioStreamID'] = int(
                audio_id
            )

            params['autoSelectAudio'] = 0

        else:
            params['autoSelectAudio'] = 1

        # ==========================================
        # SUBTITLES
        # ==========================================

        params['autoSelectSubtitle'] = 0

        if subtitle_id not in (
                None,
                ''
        ):
            params['subtitleStreamID'] = int(
                subtitle_id
            )

            params['subtitles'] = 'burn'
            params['skipSubtitles'] = 0

        else:
            params['subtitleStreamID'] = 0
            params['skipSubtitles'] = 1
            params['subtitles'] = 'none'

        # ==========================================
        # QUALITY
        # ==========================================

        if max_video_bitrate > 0:
            params['maxVideoBitrate'] = (
                max_video_bitrate
            )


        # -------------------------------------------------
        # START THE PLEX TRANSCODER AT THE CURRENT POSITION
        # -------------------------------------------------

        if view_offset > 0:
            params['offset'] = round(
                view_offset,
                3
            )


        # -------------------------------------------------
        # AUDIO SELECTION
        # -------------------------------------------------
        #
        # Do NOT change Plex's global selected stream.
        #
        # Tell THIS transcode exactly which audio stream
        # should be used.
        # -------------------------------------------------

        if audio_id not in (
            None,
            ''
        ):
            params['audioStreamID'] = str(
                audio_id
            )

            params['autoSelectAudio'] = 0

        else:
            # No explicit choice:
            # let Plex use its normal preferred/default audio.
            params['autoSelectAudio'] = 1


        # -------------------------------------------------
        # SUBTITLE SELECTION
        # -------------------------------------------------

        params['autoSelectSubtitle'] = 0


        if subtitle_id not in (
            None,
            ''
        ):
            params['subtitleStreamID'] = str(
                subtitle_id
            )

        else:
            params['subtitleStreamID'] = 0
            params['skipSubtitles'] = 1


        # -------------------------------------------------
        # QUALITY
        # -------------------------------------------------

        # ==========================================
        # DEBUG: STREAM SELECTION
        # ==========================================

        print('\n========================================')
        print('PLEX STREAM SELECTION DEBUG')
        print('========================================')

        print(f'Rating key: {rating_key}')
        print(f'Requested audio ID: {audio_id}')
        print(f'Requested subtitle ID: {subtitle_id}')
        print(f'Playback offset: {view_offset}')
        print(f'Transcode session: {transcode_session_id}')

        # ------------------------------------------
        # Show the actual streams in media 0 / part 0
        # ------------------------------------------

        media = item.media[0]
        part = media.parts[0]

        print('\nAVAILABLE AUDIO STREAMS:')

        for stream in part.audioStreams():
            print({
                'id': stream.id,
                'language': getattr(
                    stream,
                    'language',
                    None
                ),
                'languageCode': getattr(
                    stream,
                    'languageCode',
                    None
                ),
                'title': getattr(
                    stream,
                    'title',
                    None
                ),
                'codec': getattr(
                    stream,
                    'codec',
                    None
                ),
                'channels': getattr(
                    stream,
                    'channels',
                    None
                ),
                'selected': getattr(
                    stream,
                    'selected',
                    False
                )
            })

        print('\nAVAILABLE SUBTITLE STREAMS:')

        for stream in part.subtitleStreams():
            print({
                'id': stream.id,
                'language': getattr(
                    stream,
                    'language',
                    None
                ),
                'languageCode': getattr(
                    stream,
                    'languageCode',
                    None
                ),
                'title': getattr(
                    stream,
                    'title',
                    None
                ),
                'codec': getattr(
                    stream,
                    'codec',
                    None
                ),
                'selected': getattr(
                    stream,
                    'selected',
                    False
                )
            })

        # ------------------------------------------
        # Show the params we're about to give Plex.
        #
        # IMPORTANT:
        # Never print the Plex token.
        # ------------------------------------------

        safe_params = {
            key: value
            for key, value in params.items()
            if key != 'X-Plex-Token'
        }

        print('\nTRANSCODE PARAMS:')
        print(safe_params)

        # ------------------------------------------
        # Ask Plex what it WOULD actually play.
        #
        # This uses the same universal transcoder
        # configuration, but calls /decision instead
        # of starting HLS.
        # ------------------------------------------

        try:
            decision_params = {
                key: value
                for key, value in params.items()
                if key != 'X-Plex-Token'
            }

            decision = plex.query(
                '/video/:/transcode/universal/decision',
                params=decision_params
            )

            print('\nPLEX TRANSCODE DECISION:')

            if decision is None:
                print('No decision returned by Plex.')

            else:
                for stream in decision.iter('Stream'):

                    stream_type = stream.attrib.get(
                        'streamType'
                    )

                    # 1 = video
                    # 2 = audio
                    # 3 = subtitle
                    if stream_type not in (
                            '2',
                            '3'
                    ):
                        continue

                    label = (
                        'AUDIO'
                        if stream_type == '2'
                        else 'SUBTITLE'
                    )

                    print(
                        f'{label}:',
                        {
                            'id':
                                stream.attrib.get('id'),

                            'language':
                                stream.attrib.get(
                                    'language'
                                ),

                            'languageCode':
                                stream.attrib.get(
                                    'languageCode'
                                ),

                            'title':
                                stream.attrib.get(
                                    'title'
                                ),

                            'codec':
                                stream.attrib.get(
                                    'codec'
                                ),

                            'selected':
                                stream.attrib.get(
                                    'selected'
                                ),

                            'decision':
                                stream.attrib.get(
                                    'decision'
                                )
                        }
                    )

        except Exception as decision_error:
            print(
                '\nPLEX DECISION ERROR:',
                decision_error
            )

        print('========================================\n')
        endpoint = (
            '/video/:/transcode/'
            'universal/start.m3u8'
        )

        base_url = (
            '/plex-transcode'
        )


        full_url = (
            f'{base_url}'
            f'{endpoint}?'
            f'{urlencode(params)}'
        )


        # -------------------------------------------------
        # DISPLAY TITLE
        # -------------------------------------------------

        if item.type == 'episode':
            show_title = getattr(
                item,
                'grandparentTitle',
                'Unknown Show'
            )

            title_str = (
                f'{show_title}, '
                f'S{item.seasonNumber}:'
                f'E{item.index} - '
                f'{item.title}'
            )

        else:
            title_str = (
                f'{item.title} '
                f'({item.year})'
            )


        # -------------------------------------------------
        # SAVE ROOM STATE
        # -------------------------------------------------

        room.current_media_key = str(
            rating_key
        )

        room.current_media_url = (
            full_url
        )

        room.current_media_title = (
            title_str
        )

        room.is_playing = True

        room.current_time = (
            view_offset
        )

        room.last_updated = (
            datetime.utcnow()
        )


        db.session.commit()


        current_epoch = _now()


        _save_room_playback_state(room.id, 'playing', view_offset,
                                  current_epoch, new_media=True)
        socketio.emit('media_updated', _get_room_state_payload(room),
                      to=f"room_{room.id}")


        return jsonify({
            'success': True,
            'url': full_url
        })


    except Exception as e:
        print(
            f'Error setting media: {e}'
        )

        return jsonify({
            'error':
                'Could not start Plex media'
        }), 500

@main_bp.route(
    '/api/room/<room_id>/plex-progress',
    methods=['POST']
)
@login_required
def update_room_plex_progress(room_id):
    data = request.get_json(silent=True) or {}

    room = Room.query.get(room_id)

    if not room:
        return jsonify({
            'error': 'Room not found'
        }), 404

    # Only the current room host reports the room's
    # playback state back to Plex.
    if str(room.host_id) != str(current_user.id):
        return jsonify({
            'error': 'Only the host can update Plex progress'
        }), 403

    rating_key = str(
        data.get('rating_key') or ''
    )

    if not rating_key:
        return jsonify({
            'error': 'Missing rating_key'
        }), 400

    # Reject an old progress request if the room changed
    # to a different movie/episode while this request
    # was still in flight.
    if rating_key != str(
        room.current_media_key or ''
    ):
        return jsonify({
            'error': 'Stale media progress update'
        }), 409

    try:
        current_time = float(
            data.get('current_time', 0) or 0
        )
    except (TypeError, ValueError):
        return jsonify({
            'error': 'Invalid playback position'
        }), 400

    if (
        not math.isfinite(current_time)
        or current_time < 0
    ):
        return jsonify({
            'error': 'Invalid playback position'
        }), 400

    state = str(
        data.get('state') or 'playing'
    ).lower()

    if state not in {
        'playing',
        'paused',
        'stopped'
    }:
        return jsonify({
            'error': 'Invalid playback state'
        }), 400

    completed = (
        data.get('completed') is True
    )

    plex = get_plex_server()

    if not plex:
        return jsonify({
            'error': 'Plex unavailable'
        }), 500

    try:
        item = plex.fetchItem(
            int(rating_key)
        )

        if getattr(
            item,
            'type',
            ''
        ) not in (
            'movie',
            'episode'
        ):
            return jsonify({
                'error': 'Unsupported Plex media type'
            }), 400

        # Plex uses milliseconds for timeline/progress.
        position_ms = int(
            round(current_time * 1000)
        )

        duration_ms = int(
            getattr(
                item,
                'duration',
                0
            ) or 0
        )

        if duration_ms > 0:
            position_ms = min(
                position_ms,
                duration_ms
            )

        # ==========================================
        # 1. PLEX RESUME / WATCHED STATE
        # ==========================================

        if completed:
            item.markPlayed()

        elif position_ms > 0:
            item.updateProgress(
                position_ms,
                state=state
            )

        # ==========================================
        # 2. PLEX ACTIVE PLAYBACK TIMELINE
        # ==========================================
        #
        # updateProgress() updates Plex resume state,
        # but /:/timeline is Plex's actual playback
        # heartbeat endpoint.
        #
        # Keep this client identifier stable for the
        # room. Do NOT generate a new one every 10 sec.
        # ==========================================

        client_id = (
            f'peak-decline-room-{room_id}'
        )

        session_id = (
            f'peak-decline-room-{room_id}'
        )

        timeline_params = {
            'ratingKey': str(rating_key),

            'key': item.key,

            'identifier':
                'com.plexapp.plugins.library',

            'time': position_ms,

            'duration': duration_ms,

            'state': state
        }

        # Tell Plex this playback is not continuing
        # after a true stop.
        if state == 'stopped':
            timeline_params[
                'continuing'
            ] = 0

        timeline_headers = {
            'X-Plex-Client-Identifier':
                client_id,

            'X-Plex-Session-Identifier':
                session_id,

            'X-Plex-Product':
                'PeakDecline',

            'X-Plex-Device':
                'Web',

            'X-Plex-Device-Name':
                'PeakDecline Watch Together',

            'X-Plex-Platform':
                'Web',

            'X-Plex-Version':
                '1.0',

            'X-Plex-Provides':
                'player'
        }

        try:
            plex.query(
                '/:/timeline',
                method=plex._session.post,
                params=timeline_params,
                headers=timeline_headers
            )

        except Exception as timeline_error:
            # Resume progress is more important than
            # Dashboard presence, so don't fail the
            # whole request if Plex rejects only the
            # timeline heartbeat.
            print(
                'Plex timeline update failed: '
                f'{timeline_error}'
            )

        return jsonify({
            'success': True
        })

    except Exception as e:
        print(
            f'Error updating Plex progress: {e}'
        )

        return jsonify({
            'error':
                'Could not update Plex progress'
        }), 500

@main_bp.route(
    '/api/plex/metadata/<rating_key>'
)
@login_required
def get_plex_metadata(rating_key):
    plex = get_plex_server()

    if not plex:
        return jsonify({
            'error': 'Plex unavailable'
        }), 500

    try:
        item = plex.fetchItem(
            int(rating_key)
        )

        if not item.media:
            return jsonify({
                'audio': [],
                'subtitles': []
            })

        media = item.media[0]

        if not media.parts:
            return jsonify({
                'audio': [],
                'subtitles': []
            })

        # Must match set_room_media():
        # mediaIndex=0 / partIndex=0
        part = media.parts[0]


        audio_streams = []

        for stream in part.audioStreams():
            audio_streams.append({
                'id': stream.id,

                'language':
                    stream.language
                    or 'Unknown',

                'language_code':
                    getattr(
                        stream,
                        'languageCode',
                        None
                    ),

                'title':
                    stream.title
                    or stream.displayTitle
                    or 'Unknown',

                'codec':
                    getattr(
                        stream,
                        'codec',
                        None
                    ),

                'channels':
                    getattr(
                        stream,
                        'channels',
                        None
                    ),

                'selected':
                    bool(
                        getattr(
                            stream,
                            'selected',
                            False
                        )
                    )
            })


        subtitle_streams = [
            {
                'id': '',
                'language': 'None',
                'language_code': None,
                'title': 'Off',
                'selected': False
            }
        ]


        for stream in part.subtitleStreams():
            subtitle_streams.append({
                'id': stream.id,

                'language':
                    stream.language
                    or 'Unknown',

                'language_code':
                    getattr(
                        stream,
                        'languageCode',
                        None
                    ),

                'title':
                    stream.title
                    or stream.displayTitle
                    or 'Unknown',

                'codec':
                    getattr(
                        stream,
                        'codec',
                        None
                    ),

                'selected':
                    bool(
                        getattr(
                            stream,
                            'selected',
                            False
                        )
                    )
            })


        return jsonify({
            'audio': audio_streams,
            'subtitles': subtitle_streams
        })


    except Exception as e:
        print(
            f'Error fetching metadata: {e}'
        )

        return jsonify({
            'error':
                'Could not fetch Plex metadata'
        }), 500

@main_bp.route(
    '/api/room/<room_id>/next-episode/<rating_key>',
    methods=['GET']
)
@login_required
def get_room_next_episode(room_id, rating_key):
    room = Room.query.get(room_id)

    if not room:
        return jsonify({'error': 'Room not found'}), 404

    # Only the current host controls automatic episode changes.
    if str(room.host_id) != str(current_user.id):
        return jsonify({
            'error': 'Only the host can get the next episode'
        }), 403

    # Reject a delayed request if the room already changed media.
    if str(room.current_media_key or '') != str(rating_key):
        return jsonify({
            'error': 'Stale media request'
        }), 409

    plex = get_plex_server()

    if not plex:
        return jsonify({'error': 'Plex unavailable'}), 500

    try:
        current_episode = plex.fetchItem(int(rating_key))

        # Movies and other media simply have no "next episode".
        if getattr(current_episode, 'type', '') != 'episode':
            return jsonify({
                'next_episode': None
            })

        show = current_episode.show()

        episodes = list(show.episodes())

        # Explicit chronological episode order.
        #
        # Using season/episode numbers means the transition from the
        # end of one season to the beginning of the next works too.
        episodes.sort(
            key=lambda episode: (
                int(
                    getattr(
                        episode,
                        'seasonNumber',
                        0
                    ) or 0
                ),
                int(
                    getattr(
                        episode,
                        'index',
                        0
                    ) or 0
                ),
                int(
                    getattr(
                        episode,
                        'ratingKey',
                        0
                    ) or 0
                )
            )
        )

        current_index = next(
            (
                index
                for index, episode in enumerate(episodes)
                if str(episode.ratingKey) == str(rating_key)
            ),
            None
        )

        # Current episode wasn't found or this is the final episode.
        if (
            current_index is None or
            current_index + 1 >= len(episodes)
        ):
            return jsonify({
                'next_episode': None
            })

        next_episode = episodes[current_index + 1]

        return jsonify({
            'next_episode': {
                'key': str(next_episode.ratingKey),
                'type': 'Episode',
                'title': next_episode.title,
                'show_title': getattr(
                    next_episode,
                    'grandparentTitle',
                    getattr(show, 'title', 'Unknown Show')
                ),
                'season_number': int(
                    getattr(
                        next_episode,
                        'seasonNumber',
                        0
                    ) or 0
                ),
                'episode_number': int(
                    getattr(
                        next_episode,
                        'index',
                        0
                    ) or 0
                ),
                'thumb': (
                    getattr(next_episode, 'thumb', None) or
                    getattr(next_episode, 'parentThumb', None) or
                    getattr(next_episode, 'grandparentThumb', None)
                )
            }
        })

    except Exception as e:
        print(f"Error finding next Plex episode: {e}")

        return jsonify({
            'error': 'Could not find next episode'
        }), 500

# --- WATCH PARTY PLAYBACK SOCKET EVENTS ---
def _playback_command(data):
    if not isinstance(data, dict):
        return None
    try:
        room_id = str(int(data.get('room_id')))
        position = float(data.get('current_time', 0))
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(position) or position < 0:
        return None
    if not _is_current_user_room_host(room_id):
        return None
    state = room_states.get(room_id, {})
    if state.get('status') == 'game':
        return None
    if ('media_version' in data and
            data['media_version'] != state.get('media_version', '')):
        return None
    room = db.session.get(Room, int(room_id))
    snapshot = _youtube_room_snapshot(room) if room else None
    if snapshot and not snapshot['complete']:
        position = min(position, max(0, snapshot['prepared_seconds'] - 2))
    return room_id, position


def _broadcast_playback(room_id, event):
    room = db.session.get(Room, int(room_id))
    if room:
        socketio.emit(event, _get_room_state_payload(room), to=f"room_{room_id}")


@socketio.on('user_buffering')
def handle_user_buffering(data):
    command = _playback_command(data)
    if not command:
        return
    room_id, position = command
    state = room_states.get(room_id, {})
    # A stall belongs to one authoritative revision and one playback episode.
    if (state.get('status') != 'playing' or not data.get('buffer_id') or
            data.get('revision') != room_revisions.get(room_id, 0)):
        return
    _save_room_playback_state(room_id, 'buffering', position,
                              buffer_id=data['buffer_id'])
    _broadcast_playback(room_id, 'force_pause')


@socketio.on('buffer_resolved')
def handle_buffer_resolved(data):
    command = _playback_command(data)
    if not command:
        return
    room_id, position = command
    state = room_states.get(room_id, {})
    if (state.get('status') != 'buffering' or not data.get('buffer_id') or
            data.get('buffer_id') != state.get('buffer_id') or
            data.get('revision') != room_revisions.get(room_id, 0)):
        return
    _save_room_playback_state(room_id, 'playing', position)
    _broadcast_playback(room_id, 'force_play')


@socketio.on('user_seek')
def handle_user_seek(data):
    command = _playback_command(data)
    if not command:
        return
    room_id, position = command
    _save_room_playback_state(room_id, 'playing' if data.get('is_playing') is True
                              else 'paused', position)
    _broadcast_playback(room_id, 'force_seek')


@socketio.on('user_pause')
def handle_user_pause(data):
    command = _playback_command(data)
    if not command:
        return
    room_id, position = command
    _save_room_playback_state(room_id, 'paused', position)
    _broadcast_playback(room_id, 'force_pause')


@socketio.on('user_play')
def handle_user_play(data):
    command = _playback_command(data)
    if not command:
        return
    room_id, position = command
    _save_room_playback_state(room_id, 'playing', position)
    _broadcast_playback(room_id, 'force_play')


@socketio.on('host_started_game')
def handle_host_started_game(data):
    room_id = _room_key(data.get('room_id'))
    game_name = data.get('game_name', 'A Game')

    if not _is_current_user_room_host(room_id):
        return

    room = Room.query.get(int(room_id))
    if room:
        room.is_playing = False
        room.current_time = 0.0
        room.last_updated = datetime.utcnow()
        db.session.commit()

    room_states[room_id] = {
        'start_time': _now(),
        'offset': 0.0,
        'status': 'game',
        'game_name': game_name
    }

    socketio.emit('host_started_game', {
        'room_id': room_id,
        'game_name': game_name
    }, to=f"room_{room_id}", include_self=False)


@socketio.on('host_stopped_game')
def handle_host_stopped_game(data):
    room_id = _room_key(data.get('room_id'))

    if not _is_current_user_room_host(room_id):
        return

    # Clear game mode. Do not automatically reload stale Plex state.
    room_states.pop(room_id, None)

    room = Room.query.get(int(room_id))
    if room:
        room.is_playing = False
        room.current_time = 0.0
        room.last_updated = datetime.utcnow()
        db.session.commit()

    socketio.emit('game_stopped', {
        'room_id': room_id
    }, to=f"room_{room_id}")

# --- WATCH PARTY WEBRTC RELAY EVENTS ---
@socketio.on('viewer_joined')
def handle_viewer_joined(room_id):
    room_id = _room_key(room_id)
    if sid_to_room.get(request.sid) != room_id:
        return

    socketio.emit('viewer_joined', request.sid, to=f"room_{room_id}", include_self=False)


@socketio.on('webrtc_offer')
def handle_webrtc_offer(data):
    target = data.get('target')
    room_id = _room_key(data.get('room_id'))

    if not target or sid_to_room.get(request.sid) != room_id:
        return

    data['caller'] = request.sid
    socketio.emit('webrtc_offer', data, to=target)


@socketio.on('webrtc_answer')
def handle_webrtc_answer(data):
    target = data.get('target')
    room_id = _room_key(data.get('room_id'))

    if not target or sid_to_room.get(request.sid) != room_id:
        return

    data['caller'] = request.sid
    socketio.emit('webrtc_answer', data, to=target)


@socketio.on('webrtc_ice_candidate')
def handle_webrtc_ice_candidate(data):
    target = data.get('target')
    room_id = _room_key(data.get('room_id'))

    if not target or sid_to_room.get(request.sid) != room_id:
        return

    data['caller'] = request.sid
    socketio.emit('webrtc_ice_candidate', data, to=target)


# --- ARCADE / EMULATOR ROUTES ---
@main_bp.route('/games')
@login_required
def games():
    return render_template('games.html')


@main_bp.route('/games/derby')
@login_required
def peakdecline_derby():
    return render_template('horse_race.html')


from .netplay import register_routes as register_retro_routes
register_retro_routes(main_bp)
from .gta5 import register_routes as register_gta5_routes
register_gta5_routes(main_bp)


@main_bp.route('/games/catan')
@login_required
def catan_room():
    return render_template('catan.html', player_name=current_user.username, online=True)


@main_bp.route('/arcade/emulator')
@login_required
def emulator():
    static_dir = current_app.static_folder
    roms_dir = os.path.join(static_dir, 'roms')

    library = {
        'snes': [],
        'n64': [],
        'psx': []
    }

    if os.path.exists(roms_dir):
        for root, dirs, files in os.walk(roms_dir):
            for filename in files:
                if filename.startswith('.'):
                    continue

                full_file_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_file_path, static_dir)
                filepath = rel_path.replace('\\', '/')
                lower_path = filepath.lower()

                if 'snes' in lower_path:
                    library['snes'].append({'name': filename, 'path': filepath})
                elif 'n64' in lower_path:
                    library['n64'].append({'name': filename, 'path': filepath})
                elif 'psx' in lower_path or 'ps1' in lower_path:
                    library['psx'].append({'name': filename, 'path': filepath})
                else:
                    ext = filename.split('.')[-1].lower()
                    if ext in ['smc', 'sfc']:
                        library['snes'].append({'name': filename, 'path': filepath})
                    elif ext in ['z64', 'n64', 'v64']:
                        library['n64'].append({'name': filename, 'path': filepath})
                    elif ext in ['bin', 'cue', 'chd']:
                        library['psx'].append({'name': filename, 'path': filepath})

    return render_template('emulator.html', library=library)


@main_bp.route('/api/roms/<system>')
@login_required
def api_get_roms(system):
    static_dir = current_app.static_folder
    roms_dir = os.path.join(static_dir, 'roms')
    games = []

    if os.path.exists(roms_dir):
        for root, dirs, files in os.walk(roms_dir):
            for filename in files:
                if filename.startswith('.'):
                    continue

                rel_path = os.path.relpath(os.path.join(root, filename), static_dir).replace('\\', '/')
                if system.lower() in rel_path.lower():
                    games.append({'name': filename, 'path': rel_path, 'core': system})

    return jsonify(games)
