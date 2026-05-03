import os
import time
import requests
from datetime import datetime
from urllib.parse import urlencode, unquote

from flask import Blueprint, render_template, jsonify, send_from_directory, current_app, url_for, Response, request
from flask_login import login_required, current_user
from flask_socketio import emit, join_room

from . import db, socketio
from .models import Channel, Room
from app.utils import get_plex_server
from app.services.streamer import streamer

main_bp = Blueprint('main', __name__)

# In-memory live state used for fast Socket.IO sync.
# The Room database row is also updated on important state changes so refresh/rejoin works.
room_states = {}

# Grace periods prevent rooms/host ownership from changing during a normal browser refresh.
ROOM_EMPTY_GRACE_SECONDS = 60
HOST_TRANSFER_GRACE_SECONDS = 25

# --- Global User Tracking ---
online_users = set()
online_last_seen = {}
connected_sids = {}
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


def _room_key(room_id):
    return str(room_id)


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
    socketio.emit(
        "room_users_update",
        _unique_room_users(room_id),
        to=f"room_{_room_key(room_id)}"
    )


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
        "status": status,
        "is_playing": status == "playing",
        "current_time": current_time,
        "start_time": start_time,
        "offset": offset,
        "server_epoch": _now(),
    }


def _save_room_playback_state(room_id, status, offset=None, start_time=None):
    """Keep memory and database playback state aligned."""
    room_id = _room_key(room_id)
    start_time = float(start_time if start_time is not None else _now())
    offset = float(offset or 0.0)

    room_states[room_id] = {
        "start_time": start_time,
        "offset": offset,
        "status": status,
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
def sio_disconnect():
    # 1. Standard User Tracking Cleanup
    username = connected_sids.pop(request.sid, None)
    if username and username not in connected_sids.values():
        online_users.discard(username)
        online_last_seen.pop(username, None)
    socketio.emit("update_users", sorted(list(online_users)))

    # 2. Room Occupancy Cleanup
    room_id = sid_to_room.pop(request.sid, None)
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
        socketio.emit("chat_message", {"user": username, "text": text[:500]}, to=f"room_{_room_key(room_id)}")
    else:
        socketio.emit("chat_message", {"user": username, "text": text[:500]})


@socketio.on("request_users")
def sio_request_users():
    emit("update_users", sorted(list(online_users)))


# --- STANDARD ROUTES ---
@main_bp.route('/')
def index():
    return render_template('index.html')


@main_bp.route('/live-tv')
@login_required
def live_tv():
    return render_template('live_tv.html')


@main_bp.route('/plex-watch-together')
@login_required
def plex_landing():
    rooms = Room.query.order_by(Room.id.desc()).all()
    return render_template('plex_landing.html', rooms=rooms)


# --- API: CHANNELS & PLAYBACK ---
@main_bp.route('/api/channels')
@login_required
def get_channels():
    channels = Channel.query.all()
    channel_list = []
    for channel in channels:
        channel_list.append({
            'id': channel.id,
            'name': channel.name,
            'url': channel.url,
            'Favorites': str(channel.favorites).lower() in ['1', 'true', 'yes'],
            'is_playing': str(channel.is_playing).lower() in ['1', 'true', 'yes'],
            'logo': channel.logo
        })
    return jsonify(channel_list)


@main_bp.route('/api/play/<int:channel_id>', methods=['POST'])
@login_required
def play_channel(channel_id):
    channel = Channel.query.get_or_404(channel_id)
    Channel.query.update({Channel.is_playing: '0'})
    channel.is_playing = '1'
    db.session.commit()

    success, msg = streamer.start_stream(channel.id, channel.url, channel.name)
    if success:
        socketio.emit('channel_changed', {'channel_id': channel.id, 'name': channel.name})
        return jsonify({'status': 'success', 'message': msg})

    return jsonify({'error': msg}), 500


@main_bp.route('/api/status')
@login_required
def api_status():
    active_channel = Channel.query.filter(
        (Channel.is_playing == '1') | (Channel.is_playing == 'true')
    ).first()

    return jsonify({
        "is_streaming": active_channel is not None,
        "current_channel_id": active_channel.id if active_channel else None,
        "current_channel_name": active_channel.name if active_channel else None,
        "current_channel_logo": active_channel.logo if active_channel else None,
    })


# --- API: USER TRACKING ---
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
@main_bp.route('/stream/<path:filename>')
def serve_stream(filename):
    stream_directory = os.path.join(current_app.root_path, 'static', 'stream')
    mimetype = 'video/mp2t'
    if filename.endswith('.m3u8'):
        mimetype = 'application/vnd.apple.mpegurl'
    return send_from_directory(stream_directory, filename, mimetype=mimetype, max_age=0)


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

        output.append({
            'title': item.title,
            'year': item.year,
            'thumb': item.thumb,
            'key': item.ratingKey,
            'type': item.type.capitalize()
        })

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

        results.append({
            'title': title,
            'year': getattr(item, 'year', ''),
            'thumb': item.thumb if item.thumb else parent.thumb,
            'key': item.ratingKey,
            'type': item.type.capitalize(),
            'parent_title': parent.title
        })

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


@main_bp.route('/api/room/<room_id>/set_media', methods=['POST'])
@login_required
def set_room_media(room_id):
    data = request.json or {}
    rating_key = data.get('rating_key')

    if not rating_key:
        return jsonify({'error': 'Missing rating_key'}), 400

    room = Room.query.get(room_id)
    if not room:
        return jsonify({'error': 'Room not found'}), 404

    if str(room.host_id) != str(current_user.id):
        return jsonify({'error': 'Only the host can change media'}), 403

    view_offset = float(data.get('view_offset', 0) or 0)
    audio_id = data.get('audio_stream_id')
    subtitle_id = data.get('subtitle_stream_id')

    plex = get_plex_server()
    if not plex:
        return jsonify({'error': 'Plex unavailable'}), 500

    try:
        item = plex.fetchItem(int(rating_key))

        changes_made = False
        for part in item.iterParts():
            if audio_id:
                target_stream = next((s for s in part.audioStreams() if str(s.id) == str(audio_id)), None)
                if target_stream:
                    part.setSelectedAudioStream(target_stream)
                    changes_made = True

            if subtitle_id:
                target_stream = next((s for s in part.subtitleStreams() if str(s.id) == str(subtitle_id)), None)
                if target_stream:
                    part.setSelectedSubtitleStream(target_stream)
                    changes_made = True
            elif subtitle_id == "":
                plex.query(f'/library/parts/{part.id}?subtitleStreamID=0&allParts=1', method=plex._session.put)
                changes_made = True

        if changes_made:
            time.sleep(0.5)
            item.reload()

        unique_ts = int(_now())
        session_id = f"room-{room_id}-{unique_ts}"
        client_id = f"peak-decline-room-{room_id}-{unique_ts}"

        params = {
            'path': item.key,
            'mediaIndex': 0,
            'partIndex': 0,
            'protocol': 'hls',
            'fastSeek': 1,
            'directPlay': 0,
            'directStream': 0,
            'autoSelectAudio': 0,
            'subtitleSize': 100,
            'audioBoost': 100,
            'maxVideoBitrate': 8000,
            'workaround': 'nvidia-shallow',
            'copyts': 1,
            'session': session_id,
            'X-Plex-Token': plex._token,
            'X-Plex-Client-Identifier': client_id,
            'X-Plex-Product': 'PeakDecline',
            'X-Plex-Device': 'Web'
        }

        if view_offset > 0:
            params['viewOffset'] = view_offset
        if audio_id:
            params['audioStreamID'] = audio_id
        if subtitle_id:
            params['subtitleStreamID'] = subtitle_id
        elif subtitle_id == "":
            params['subtitleStreamID'] = 0

        endpoint = "/video/:/transcode/universal/start.m3u8"
        base_url = "/plex-transcode"
        full_url = f"{base_url}{endpoint}?{urlencode(params)}"

        if item.type == 'episode':
            show_title = getattr(item, 'grandparentTitle', 'Unknown Show')
            title_str = f"{show_title}, S{item.seasonNumber}:E{item.index} - {item.title}"
        else:
            title_str = f"{item.title} ({item.year})"

        room.current_media_key = str(rating_key)
        room.current_media_url = full_url
        room.current_media_title = title_str
        room.is_playing = True
        room.current_time = view_offset
        room.last_updated = datetime.utcnow()
        db.session.commit()

        current_epoch = _now()
        room_states[_room_key(room.id)] = {
            'start_time': current_epoch,
            'offset': view_offset,
            'status': 'playing'
        }

        socketio.emit('media_updated', {
            'room_id': room.id,
            'url': full_url,
            'title': room.current_media_title,
            'rating_key': str(rating_key),
            'start_time': view_offset,
            'offset': view_offset,
            'status': 'playing',
            'is_playing': True,
            'server_epoch': current_epoch
        }, to=f"room_{_room_key(room.id)}")

        return jsonify({'success': True, 'url': full_url})

    except Exception as e:
        print(f"Error setting media: {e}")
        return jsonify({'error': str(e)}), 500


@main_bp.route('/api/plex/metadata/<rating_key>')
@login_required
def get_plex_metadata(rating_key):
    plex = get_plex_server()
    try:
        item = plex.fetchItem(int(rating_key))
        audio_streams = []
        for stream in item.audioStreams():
            audio_streams.append({
                'id': stream.id,
                'language': stream.language or 'Unknown',
                'title': stream.title or stream.displayTitle or 'Unknown',
                'selected': stream.selected
            })

        subtitle_streams = [{'id': '', 'language': 'None', 'title': 'Off', 'selected': True}]
        for stream in item.subtitleStreams():
            subtitle_streams.append({
                'id': stream.id,
                'language': stream.language or 'Unknown',
                'title': stream.title or stream.displayTitle or 'Unknown',
                'selected': stream.selected
            })

        return jsonify({'audio': audio_streams, 'subtitles': subtitle_streams})
    except Exception as e:
        print(f"Error fetching metadata: {e}")
        return jsonify({'error': str(e)}), 500


# --- WATCH PARTY PLAYBACK SOCKET EVENTS ---
@socketio.on('user_buffering')
def handle_user_buffering(data):
    room_id = _room_key(data.get('room_id'))
    current_time = float(data.get('current_time', 0) or 0)
    username = current_user.username if current_user.is_authenticated else "Guest"

    # Current frontend only sends this from host. Keep backend protected too.
    if not _is_current_user_room_host(room_id):
        return

    _save_room_playback_state(room_id, 'paused', current_time)
    socketio.emit('force_pause', {'user': username, 'offset': current_time}, to=f"room_{room_id}")


@socketio.on('buffer_resolved')
def handle_buffer_resolved(data):
    room_id = _room_key(data.get('room_id'))
    current_time = float(data.get('current_time', 0) or 0)

    if not _is_current_user_room_host(room_id):
        return

    state = _save_room_playback_state(room_id, 'playing', current_time)
    socketio.emit('force_play', {
        'start_time': state['start_time'],
        'server_epoch': state['start_time'],
        'offset': current_time
    }, to=f"room_{room_id}")


@socketio.on('user_pause')
def handle_user_pause(data):
    room_id = _room_key(data.get('room_id'))
    username = current_user.username if current_user.is_authenticated else "Guest"
    current_time = float(data.get('current_time', 0) or 0)

    if not _is_current_user_room_host(room_id):
        return

    _save_room_playback_state(room_id, 'paused', current_time)
    socketio.emit('force_pause', {
        'user': username,
        'offset': current_time
    }, to=f"room_{room_id}")


@socketio.on('user_play')
def handle_user_play(data):
    room_id = _room_key(data.get('room_id'))
    current_time = float(data.get('current_time', 0) or 0)

    if not _is_current_user_room_host(room_id):
        return

    state = _save_room_playback_state(room_id, 'playing', current_time)
    socketio.emit('force_play', {
        'start_time': state['start_time'],
        'server_epoch': state['start_time'],
        'offset': current_time
    }, to=f"room_{room_id}")


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