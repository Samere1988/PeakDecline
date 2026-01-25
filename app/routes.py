import os
import time
from flask import Blueprint, render_template, jsonify, request, send_from_directory, current_app
from flask_login import login_required, current_user
from . import db, socketio
from .models import Channel
from app.services.streamer import streamer

main_bp = Blueprint('main', __name__)

# --- Global User Tracking (Simple In-Memory) ---
# In a production app, use Redis or a Database for this
online_users = set()
online_last_seen = {}


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

    for channel in channels:
        channel_list.append({
            'id': channel.id,
            'name': channel.name,
            'url': channel.url,
            'Favorites': str(channel.favorites).lower() in ['1', 'true', 'yes'],
            'is_playing': str(channel.is_playing).lower() in ['1', 'true', 'yes']
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
        "current_channel_id": active_channel.id if active_channel else None
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