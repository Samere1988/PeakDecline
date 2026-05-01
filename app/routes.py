import os
import time
import requests
from urllib.parse import urlencode, unquote, quote
from flask import Blueprint, render_template, jsonify, send_from_directory, current_app, url_for, Response, request
from flask_login import login_required, current_user
from flask_socketio import emit, join_room, leave_room
from . import db, socketio
from .models import Channel, Room
from app.utils import get_plex_server
from app.services.streamer import streamer

main_bp = Blueprint('main', __name__)
room_states = {}  # e.g., { "room_id": {"start_time": 168000000.0, "offset": 0, "status": "playing"} }


# --- HELPER: Get Public IP ---
def get_public_ip():
    try:
        return requests.get('https://api.ipify.org', timeout=5).text.strip()
    except Exception as e:
        print(f"Error fetching Public IP: {e}")
        return None


# --- Global User Tracking ---
online_users = set()
online_last_seen = {}
connected_sids = {}
room_occupancy = {}  # Fixed: Will map room_id -> {sid: username}
sid_to_room = {}


@socketio.on("connect")
def sio_connect():
    username = current_user.username if current_user.is_authenticated else "Guest"
    connected_sids[request.sid] = username
    online_users.add(username)
    online_last_seen[username] = time.time()
    socketio.emit("update_users", sorted(list(online_users)))


@socketio.on("join_watch_room")
def on_join_watch_room(data):
    room_id = str(data.get('room_id'))
    if not room_id: return

    # Put the socket in a dedicated broadcast room
    join_room(f"room_{room_id}")

    # Track the username for the viewer list
    username = current_user.username if current_user.is_authenticated else "Guest"

    # Track the occupancy using a dictionary mapping sid -> username
    sid_to_room[request.sid] = room_id
    if room_id not in room_occupancy:
        room_occupancy[room_id] = {}
    room_occupancy[room_id][request.sid] = username

    # Broadcast the updated viewer list to this specific room
    socketio.emit("room_users_update", list(room_occupancy[room_id].values()), to=f"room_{room_id}")


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
    if room_id and room_id in room_occupancy:
        leaving_username = room_occupancy[room_id].pop(request.sid, None)

        # 3. IF THE ROOM IS EMPTY -> DELETE IT
        if len(room_occupancy[room_id]) == 0:
            del room_occupancy[room_id]
            room_to_delete = Room.query.get(int(room_id))
            if room_to_delete:
                db.session.delete(room_to_delete)
                db.session.commit()
        else:
            # 4. IF THE HOST LEFT -> TRANSFER TO NEXT OLDEST VIEWER
            room = Room.query.get(int(room_id))
            if room and room.host.username == leaving_username:
                from app.models import User  # Import here to avoid circular dependencies

                # Because dictionaries preserve order, the 1st person in the list is the oldest remaining!
                new_host_username = list(room_occupancy[room_id].values())[0]
                new_host_user = User.query.filter_by(username=new_host_username).first()

                if new_host_user:
                    room.host_id = new_host_user.id
                    db.session.commit()
                    socketio.emit("host_changed", {"new_host": new_host_username}, to=f"room_{room_id}")

            # Broadcast the updated viewer list
            socketio.emit("room_users_update", list(room_occupancy[room_id].values()), to=f"room_{room_id}")


@socketio.on("transfer_host")
def handle_transfer_host(data):
    room_id = str(data.get('room_id'))
    new_host_username = data.get('new_host')

    room = Room.query.get(int(room_id))
    # Security Check: Ensure the person asking is the actual host
    if room and current_user.is_authenticated and room.host_id == current_user.id:
        from app.models import User
        new_user = User.query.filter_by(username=new_host_username).first()
        if new_user:
            room.host_id = new_user.id
            db.session.commit()

            # Announce the new host and force a viewer list refresh to move the Crown
            socketio.emit("host_changed", {"new_host": new_host_username}, to=f"room_{room_id}")
            socketio.emit("room_users_update", list(room_occupancy[room_id].values()), to=f"room_{room_id}")


@socketio.on("chat_message")
def sio_chat_message(message):
    username = connected_sids.get(request.sid) or (
        current_user.username if current_user.is_authenticated else "Guest"
    )

    # Handle the JSON dictionary properly instead of stringifying the whole object
    if isinstance(message, dict):
        text = message.get("text", "").strip()
        room_id = message.get("room_id")
    else:
        text = str(message).strip()
        room_id = None

    if not text: return

    # Send the chat ONLY to the room they are in
    if room_id:
        socketio.emit("chat_message", {"user": username, "text": text[:500]}, to=f"room_{room_id}")
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
        "current_channel_name": active_channel.name if active_channel else None
    })


# --- API: USER TRACKING ---

@main_bp.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    if current_user.is_authenticated:
        username = current_user.username
        online_users.add(username)
        online_last_seen[username] = time.time()
    return jsonify({'status': 'alive'})


@main_bp.route('/api/online_users')
def get_online_users():
    now = time.time()
    cutoff = now - 15
    to_remove = [u for u, ts in online_last_seen.items() if ts < cutoff]
    for user in to_remove:
        if user in online_users:
            online_users.remove(user)
        del online_last_seen[user]
    return jsonify(sorted(list(online_users)))


# --- STATIC & STREAM SERVING ---

@main_bp.route('/stream/<path:filename>')
def serve_stream(filename):
    stream_directory = os.path.join(current_app.root_path, 'static', 'stream')
    mimetype = 'video/mp2t'
    if filename.endswith('.m3u8'): mimetype = 'application/vnd.apple.mpegurl'
    return send_from_directory(stream_directory, filename, mimetype=mimetype, max_age=0)


@main_bp.route('/static/<path:filename>')
def custom_static_handler(filename):
    static_dir = os.path.join(current_app.root_path, 'static')
    return send_from_directory(static_dir, filename)


# --- PLEX WATCH PARTY ROUTES ---

@main_bp.route('/create-room', methods=['POST'])
@login_required
def create_room():
    data = request.get_json()
    room_name = data.get('name')
    if not room_name: return jsonify({'error': 'Room name is required'}), 400
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
    if not query: return jsonify([])
    plex = get_plex_server()
    if not plex: return jsonify({'error': 'Could not connect to Plex Server'}), 500

    rating_key = None
    if 'key=' in query:
        try:
            clean = unquote(query)
            start = clean.find('key=') + 4
            end = clean.find('&', start)
            val = clean[start:] if end == -1 else clean[start:end]
            rating_key = val.split('/')[-1] if '/' in val else val
        except:
            pass
    elif query.isdigit():
        rating_key = query

    try:
        if rating_key:
            try:
                results = [plex.fetchItem(int(rating_key))]
            except:
                results = plex.search(query)
        else:
            results = plex.search(query)
    except:
        return jsonify({'error': 'Search failed'}), 500

    output = []
    for item in results:
        if item.type not in ['movie', 'show', 'season', 'episode']: continue
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
    if not rating_key: return jsonify([])
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
        if item.type == 'season': title = f"Season {item.index}"
        if item.type == 'episode': title = f"S{item.seasonNumber}:E{item.index} - {item.title}"
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
    if not thumb_path: return "Missing path", 400
    plex = get_plex_server()
    try:
        img_url = plex.transcodeImage(thumb_path, height=450, width=300, minSize=1, upscale=1)
        resp = requests.get(img_url, stream=True)
        return Response(resp.content, status=resp.status_code,
                        content_type=resp.headers.get('content-type', 'image/jpeg'))
    except:
        return "Error", 500


# --- THE STABLE SET MEDIA ROUTE ---
@main_bp.route('/api/room/<room_id>/set_media', methods=['POST'])
@login_required
def set_room_media(room_id):
    data = request.json
    rating_key = data.get('rating_key')

    # Ensure view_offset is handled as a float for precision
    view_offset = float(data.get('view_offset', 0))
    audio_id = data.get('audio_stream_id')
    subtitle_id = data.get('subtitle_stream_id')

    room = Room.query.get(room_id)
    if not room: return jsonify({'error': 'Room not found'}), 404

    plex = get_plex_server()
    if not plex: return jsonify({'error': 'Plex unavailable'}), 500

    try:
        item = plex.fetchItem(int(rating_key))

        # Stream Switching (PlexAPI)
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

        unique_ts = int(time.time())
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

        if audio_id: params['audioStreamID'] = audio_id
        if subtitle_id:
            params['subtitleStreamID'] = subtitle_id
        elif subtitle_id == "":
            params['subtitleStreamID'] = 0

        query_string = urlencode(params)

        endpoint = "/video/:/transcode/universal/start.m3u8"
        public_ip = get_public_ip()
        base_url = f"http://{public_ip}:32400" if public_ip else plex._baseurl
        full_url = f"{base_url}{endpoint}?{query_string}"

        if item.type == 'episode':
            title_str = f"S{item.seasonNumber}:E{item.index} - {item.title}"
        else:
            title_str = f"{item.title} ({item.year})"

        room.current_media_key = str(rating_key)
        room.current_media_url = full_url
        room.current_media_title = title_str
        room.is_playing = True

        db.session.commit()

        # --- NEW ABSOLUTE TIME LOGIC ---
        current_epoch = time.time()

        # Track the room's playback state globally
        room_states[str(room.id)] = {
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
            'server_epoch': current_epoch  # Pass the absolute time to the frontend
        })

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
        subtitle_streams = []
        subtitle_streams.append({'id': '', 'language': 'None', 'title': 'Off', 'selected': True})
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


@socketio.on('user_buffering')
def handle_user_buffering(data):
    room_id = data.get('room_id')
    username = current_user.username if current_user.is_authenticated else "Guest"

    if room_id:
        # Pause the whole room
        room_states[room_id] = {'status': 'paused'}
        socketio.emit('force_pause', {'user': username}, to=f"room_{room_id}")

        # CHAT SPAM COMMENTED OUT:
        # socketio.emit('chat_message', {'user': 'System', 'text': f'Paused for {username} to buffer...'})


@socketio.on('buffer_resolved')
def handle_buffer_resolved(data):
    room_id = data.get('room_id')
    current_time = data.get('current_time', 0)

    if room_id:
        # Reset the absolute start time so the clock starts ticking from now!
        room_states[room_id] = {
            'start_time': time.time(),
            'offset': current_time,
            'status': 'playing'
        }
        # Tell everyone to play, giving them the new absolute time clock
        socketio.emit('force_play', {
            'start_time': room_states[room_id]['start_time'],
            'offset': current_time
        }, to=f"room_{room_id}")


@socketio.on('user_pause')
def handle_user_pause(data):
    room_id = str(data.get('room_id'))
    username = current_user.username if current_user.is_authenticated else "Guest"

    if room_id:
        # Mark the room as paused and tell everyone to stop
        room_states[room_id] = {'status': 'paused'}
        socketio.emit('force_pause', {'user': username}, to=f"room_{room_id}")


@socketio.on('user_play')
def handle_user_play(data):
    room_id = str(data.get('room_id'))
    current_time = float(data.get('current_time', 0))

    if room_id:
        # Reset the absolute start time clock and tell everyone to resume!
        room_states[room_id] = {
            'start_time': time.time(),
            'offset': current_time,
            'status': 'playing'
        }
        socketio.emit('force_play', {
            'start_time': room_states[room_id]['start_time'],
            'offset': current_time
        }, to=f"room_{room_id}")


@main_bp.route('/games')
@login_required
def games():
    # This now serves the Arcade Landing Page
    return render_template('games.html')

@main_bp.route('/games/derby')
@login_required
def peakdecline_derby():
    # This serves the actual horse race game
    return render_template('horse_race.html')


import os
from flask import current_app, render_template

import os
from flask import current_app, render_template


@main_bp.route('/arcade/emulator')
@login_required
def emulator():
    # 1. Use Flask's built-in static folder locator
    static_dir = current_app.static_folder
    roms_dir = os.path.join(static_dir, 'roms')

    library = {
        'snes': [],
        'n64': [],
        'psx': []
    }

    # Check if the folder actually exists where Flask thinks it does
    if os.path.exists(roms_dir):
        for root, dirs, files in os.walk(roms_dir):
            for filename in files:

                # Skip hidden system files
                if filename.startswith('.'):
                    continue

                full_file_path = os.path.join(root, filename)

                # Create the clean relative path for the HTML to use (e.g., 'roms/N64/mario.z64')
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