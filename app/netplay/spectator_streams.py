"""Room-scoped WebRTC rendezvous; game media goes directly to viewers.

The relay remains available until a viewer reports decoded video, and resumes
if its short lease expires. No media connection can grant a controller seat.
"""
from time import monotonic
from flask import request

BACKENDS = ('recomp-ring-lockstep-v1', 'rollback-v1', 'solo-media-v1',
            'devilution-native-v1', 'cmr2-server-relay-v1')
NAMESPACE = '/retro'


def viewer(room, person):
    return (person['role'] == 'spectator' and person['connected'] and person['loaded']
            and (room['game']['backend'] not in BACKENDS[:2] or person.get('watchMode') == 'media'))


def publisher(room):
    seat = room['native'].coordinator if room['game']['backend'] == BACKENDS[-1] and room.get('native') else 0
    if type(seat) is int and 0 <= seat < len(room['sids']):
        sid = room['sids'][seat]
        if room['members'][sid]['connected']:
            return sid


def streaming(room, sid):
    stream = room.get('spectatorStreams', {}).get(sid, {})
    return stream.get('source') == publisher(room) and stream.get('until', 0) > monotonic()


def register(app, socketio, rooms, membership, lock, ice_servers):
    def room_for(data):
        room = rooms.get(membership.get(request.sid))
        if (room and room['phase'] == 'running' and room['game']['backend'] in BACKENDS
                and isinstance(data, dict) and type(data.get('epoch')) is int
                and data['epoch'] == room['epoch']):
            return room

    def emit(event, room, sid, **data):
        socketio.emit(event, dict(epoch=room['epoch'], **data), namespace=NAMESPACE, to=sid)

    def allow(room, key, rate, burst):
        return room['media'].allow((request.sid, key), 1, rate, burst)

    def announce(room, sid, stream):
        source = publisher(room)
        if not source:
            return
        if stream['source'] != source:
            stream.update(source=source, until=0)
        common = dict(token=stream['token'], iceServers=ice_servers(app))
        emit('spectator_transport', room, sid, peer=source, publisher=False, **common)
        emit('spectator_transport', room, source, peer=sid, publisher=True, **common)

    @socketio.on('spectator_connect', namespace=NAMESPACE)
    def connect(data):
        with lock:
            room = room_for(data)
            if not room or not allow(room, 'connect', 1, 2):
                return
            streams = room.setdefault('spectatorStreams', {})
            # Remove departed viewers; reconnecting sockets have new identities.
            for sid in list(streams):
                if sid not in room['members'] or not viewer(room, room['members'][sid]):
                    del streams[sid]
            if request.sid == publisher(room):
                for sid, stream in streams.items():
                    announce(room, sid, stream)
            elif viewer(room, room['members'][request.sid]):
                token = data.get('token')
                if not isinstance(token, str) or not 1 <= len(token) <= 64 or not token.isascii() or not all(c.isalnum() or c == '-' for c in token):
                    return
                stream = streams.get(request.sid)
                if not stream or stream['token'] != token:
                    stream = streams[request.sid] = dict(token=token, source=publisher(room), until=0)
                announce(room, request.sid, stream)

    @socketio.on('spectator_signal', namespace=NAMESPACE)
    def signal(data):
        with lock:
            room = room_for(data)
            if not room:
                return
            source, target = publisher(room), data.get('to')
            if not isinstance(target, str) or target not in room['members'] or target == request.sid:
                return
            sid = target if request.sid == source else request.sid
            stream = room.get('spectatorStreams', {}).get(sid)
            if (not stream or stream['token'] != data.get('token') or stream['source'] != source
                    or not viewer(room, room['members'][sid])
                    or (request.sid != source and target != source)):
                return
            kind, value = data.get('type'), data.get('value')
            if kind in ('offer', 'answer'):
                if (kind == 'offer') != (request.sid == source) or not isinstance(value, str) or not 1 <= len(value) <= 65536:
                    return
            elif kind == 'candidate':
                if (not isinstance(value, dict) or set(value) - {'candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'}
                        or not isinstance(value.get('candidate'), str) or not 1 <= len(value['candidate']) <= 2048):
                    return
                for key in ('sdpMid', 'usernameFragment'):
                    if value.get(key) is not None and (not isinstance(value[key], str) or len(value[key]) > 256):
                        return
                if value.get('sdpMLineIndex') is not None and (type(value['sdpMLineIndex']) is not int or not 0 <= value['sdpMLineIndex'] <= 65535):
                    return
            else:
                return
            if allow(room, 'signals', 32 if request.sid == source else 12, 128):
                emit('spectator_signal', room, target, **{'from': request.sid}, token=stream['token'], type=kind, value=value)

    @socketio.on('spectator_stream_state', namespace=NAMESPACE)
    def status(data):
        with lock:
            room = room_for(data)
            if not room or type(data.get('active')) is not bool or not allow(room, 'state', 2, 4):
                return
            stream = room.get('spectatorStreams', {}).get(request.sid)
            if (not stream or stream['token'] != data.get('token') or not viewer(room, room['members'][request.sid])
                    or stream['source'] != publisher(room)):
                return
            stream['until'] = monotonic() + 5 if data['active'] else 0
            emit('spectator_stream_state', room, stream['source'], peer=request.sid,
                 token=stream['token'], active=data['active'])
