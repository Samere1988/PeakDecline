import os
import time
from flask import Blueprint, render_template, jsonify, request, send_from_directory, current_app
from flask_login import login_required, current_user
from flask_socketio import emit
from . import db, socketio
from .models import Channel
from app.services.streamer import streamer

main_bp = Blueprint('main', __name__)

# --- Global User Tracking (Simple In-Memory) ---
# In a production app, use Redis or a Database for this
online_users = set()
online_last_seen = {}

connected_sids = {}  # sid -> username

@socketio.on("connect")
def sio_connect():
    username = current_user.username if current_user.is_authenticated else "Guest"
    connected_sids[request.sid] = username

    online_users.add(username)
    online_last_seen[username] = time.time()

    socketio.emit("update_users", sorted(list(online_users)))

@socketio.on("disconnect")
def sio_disconnect():
    username = connected_sids.pop(request.sid, None)
    if not username:
        return

    # only remove user if they have no other active sockets (multiple tabs/devices)
    if username not in connected_sids.values():
        online_users.discard(username)
        online_last_seen.pop(username, None)

    socketio.emit("update_users", sorted(list(online_users)))

@socketio.on("chat_message")
def sio_chat_message(message):
    username = connected_sids.get(request.sid) or (
        current_user.username if current_user.is_authenticated else "Guest"
    )

    text = (str(message) if message is not None else "").strip()
    if not text:
        return

    socketio.emit("chat_message", {"user": username, "text": text[:500]})

@socketio.on("request_users")
def sio_request_users():
    emit("update_users", sorted(list(online_users)))


@main_bp.route('/')
def index():
    return render_template('index.html')


@main_bp.route('/live-tv')
@login_required
def live_tv():
    return render_template('live_tv.html')


@main_bp.route('/plex-watch-together')
@login_required
def plex_watch_together():
    return render_template('plex_watch.html')


@main_bp.route('/games')
@login_required
def games():
    return render_template('games.html')


# --- API: Channels & Playback ---

@main_bp.route('/api/channels')
@login_required
def get_channels():
    channels = Channel.query.all()
    channel_list = []
    if channels:
        print(f"DEBUG: First Channel Name: {channels[0].name}")
        print(f"DEBUG: First Channel Logo: {getattr(channels[0], 'logo', 'ATTRIBUTE MISSING')}")
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

    # 1. Update Database
    Channel.query.update({Channel.is_playing: '0'})
    channel.is_playing = '1'
    db.session.commit()

    # 2. Start Stream Service
    success, msg = streamer.start_stream(channel.id, channel.url, channel.name)

    # 3. Notify Everyone
    if success:
        socketio.emit('channel_changed', {
            'channel_id': channel.id,
            'name': channel.name
        })
        return jsonify({'status': 'success', 'message': msg})

    return jsonify({'error': msg}), 500


@main_bp.route('/api/status')
@login_required
def api_status():
    # Helper for the frontend to know what's playing on load
    active_channel = Channel.query.filter(
        (Channel.is_playing == '1') | (Channel.is_playing == 'true')
    ).first()

    return jsonify({
        "is_streaming": active_channel is not None,
        "current_channel_id": active_channel.id if active_channel else None,
        "current_channel_name": active_channel.name if active_channel else None
    })


# --- API: User Tracking & Heartbeats ---

@main_bp.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    if current_user.is_authenticated:
        username = current_user.username
        online_users.add(username)
        online_last_seen[username] = time.time()
    return jsonify({'status': 'alive'})


@main_bp.route('/api/online_users')
def get_online_users():
    # Clean up old users (timeout after 15 seconds)
    now = time.time()
    cutoff = now - 15

    # Create a list of users to remove
    to_remove = [u for u, ts in online_last_seen.items() if ts < cutoff]

    for user in to_remove:
        if user in online_users:
            online_users.remove(user)
        del online_last_seen[user]

    return jsonify(sorted(list(online_users)))


@main_bp.route('/stream/<path:filename>')
def serve_stream(filename):
    # FIX: Use 'current_app.root_path' to find the 'app' folder explicitly
    # This ensures we look in .../PeakDecline/app/static/stream
    stream_directory = os.path.join(current_app.root_path, 'static', 'stream')

    # DEBUG: Print where Flask is looking (check your console if 404 persists)
    print(f"DEBUG REQUEST: Reading from -> {stream_directory}")

    # Determine MIME type
    mimetype = 'video/mp2t'
    if filename.endswith('.m3u8'):
        mimetype = 'application/vnd.apple.mpegurl'

    return send_from_directory(
        stream_directory,
        filename,
        mimetype=mimetype,
        max_age=0
    )


import os
from flask import send_from_directory, current_app


@main_bp.route('/static/<path:filename>')
def custom_static_handler(filename):
    # This forces Flask to look in the exact folder we want
    static_dir = os.path.join(current_app.root_path, 'static')

    # DEBUG: Print exactly what file is being requested to your console
    print(f" DEBUG: Looking for -> {static_dir}/{filename}")

    return send_from_directory(static_dir, filename)