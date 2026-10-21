"""Authenticated, bounded input relay shared by registered browser games.

The relay orders inputs; game simulation remains on each client. Room state is
process-local, like the existing MK64 service. Use one Socket.IO worker.
"""
import base64
import secrets
import json
import os
from threading import RLock, BoundedSemaphore
from time import monotonic
from urllib.parse import urlsplit
from flask import request
from flask_login import current_user
from flask_socketio import join_room, leave_room
from .catalog import GAMES, PROTOCOL
from .telemetry import validate as validate_diagnostics, record as record_diagnostics
from .authoritative import AuthorityRelay, BACKEND as AUTHORITY_BACKEND
from .synchronized import InputHistory, BACKEND as SYNC_BACKEND, MAX_FRAMES
from .party_history import PartyHistory
from .native import NativeRelay, BACKEND as NATIVE_BACKEND
from .cmr2 import CMR2Relay, BACKEND as CMR2_BACKEND
from .mk64_authority import Worker as KartWorker, BACKEND as KART_BACKEND
from . import spectator_streams
SOLO_BACKEND = "solo-media-v1"
MEDIA_BACKENDS = ('recomp-ring-lockstep-v1', 'rollback-v1')

NAMESPACE = '/retro'
WINDOW = 16
MK64_HISTORY = 1200
MK64_RECONNECT_SECONDS = 15


def rollback_ice_servers(app):
    """Only configured ICE endpoints reach clients; never invent TURN secrets."""
    raw = app.config.get('NETPLAY_ICE_SERVERS', os.environ.get('NETPLAY_ICE_SERVERS'))
    if raw is None:
        return [dict(urls='stun:stun.l.google.com:19302'), dict(urls='stun:stun1.l.google.com:19302')]
    try:
        servers = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(servers, list) or len(servers) > 8:
            return []
        result = []
        for server in servers:
            if not isinstance(server, dict) or set(server) - {'urls', 'username', 'credential'}:
                return []
            urls = server.get('urls')
            urls = [urls] if isinstance(urls, str) else urls
            if not isinstance(urls, list) or not 1 <= len(urls) <= 4 or any(
                not isinstance(url, str) or len(url) > 512 or not url.startswith(('stun:', 'stuns:', 'turn:', 'turns:'))
                or any(char.isspace() for char in url) for url in urls):
                return []
            clean = dict(urls=urls)
            for key in ('username', 'credential'):
                if key in server:
                    if not isinstance(server[key], str) or len(server[key]) > 1024:
                        return []
                    clean[key] = server[key]
            result.append(clean)
        return result
    except (ValueError, TypeError):
        return []


def register(app, socketio):
    rooms, membership = {}, {}
    if socketio.async_mode == 'gevent':
        from gevent.lock import RLock as GreenletRLock
        lock = GreenletRLock()
        from gevent.lock import BoundedSemaphore as KartSemaphore
    else:
        lock = RLock()
        KartSemaphore = BoundedSemaphore

    kart_limit = max(1, min(8, int(app.config.get('MK64_AUTHORITY_ROOMS', 4))))
    kart_slots = KartSemaphore(kart_limit)

    spectator_streams.register(app, socketio, rooms, membership, lock, rollback_ice_servers)

    def party(room):
        return room['game']['id'] in ('marioparty', 'marioparty2') and room['game']['backend'] == 'recomp-ring-lockstep-v1'

    def retained_lockstep(room):
        return room['game']['id'] in ('mk64', 'marioparty', 'marioparty2') and room['game']['backend'] == 'recomp-ring-lockstep-v1'

    def lockstep_paused(room):
        return retained_lockstep(room) and any(not room['members'][sid]['connected'] or room['members'][sid].get('recovering') for sid in room['sids'])

    def emit(event, data, code=None):
        socketio.emit(event, data, namespace=NAMESPACE, to='retro:' + code if code else request.sid)

    def error(message):
        emit('room_error', {'message': message})

    def state(code, room):
        members = room['members']
        return dict(schemaVersion=1, code=code, name=room['name'], game=room['game'],
                    settings=room['settings'],
                    phase=room['phase'], epoch=room['epoch'], host=room['host'], seed=room.get('seed', 1),
                    paused=bool(room['phase']=='running' and (lockstep_paused(room) or
                                (room['game']['backend']==AUTHORITY_BACKEND and room['sids']
                                 and not members[room['sids'][0]]['connected']))),
                    players=len(room['sids']), maxPlayers=room['game']['maxPlayers'],
                    playing=len(room['sids']), ready=sum(m['ready'] for m in members.values()),
                    members=[dict(id=sid, **member) for sid, member in members.items()])

    def preparation(code, room):
        result = state(code, room)
        if 'initialSave' in room:
            result['initialSave'] = room['initialSave']
        return result

    def listing():
        return [state(code, room) for code, room in rooms.items()]

    def publish(code=None):
        if code in rooms:
            emit('room_update', state(code, rooms[code]), code)
        socketio.emit('rooms', listing(), namespace=NAMESPACE)

    def compatible(data, game):
        return (isinstance(data, dict) and all(data.get(k) == game[k] for k in
                ('id', 'protocol', 'build', 'inputSchema', 'backend')) and
                data.get('rollback') == game.get('rollback') and
                data.get('authoritative') == game.get('authoritative') and game['available'])

    def member(role):
        return dict(name=str(getattr(current_user, 'username', current_user.get_id()))[:40],
                    avatar=getattr(current_user, 'avatar_url', ''), role=role,
                    ready=False, loaded=False, slot=None, connected=True)

    def reseat(room):
        for person in room['members'].values():
            person['slot'] = None
        for slot, sid in enumerate(room['sids']):
            room['members'][sid]['slot'] = slot

    def close_kart(room):
        worker = room.pop('kart_worker', None)
        if worker:
            worker.close()
        room.pop('kart_baseline', None)
        room.pop('kart_latest', None)
        room.pop('kart_anchors', None)

    def kart_send(room, sid):
        person = room['members'].get(sid)
        if (not person or not person['connected'] or not person['loaded'] or
                room['phase'] != 'running' or person.get('kart_pending') is not None):
            return
        latest = room.get('kart_latest')
        if not latest:
            return
        packet = None
        if not person.get('kart_baseline'):
            if latest.get('base', 0) == 0:
                packet = room.get('kart_baseline')
        elif person.get('kart_anchor', 0) == latest.get('base', 0):
            packet = latest
        else:
            packet = next((p for p in room.get('kart_anchors', {}).values()
                           if p['base'] == person.get('kart_anchor', 0)), None)
        if packet is None:
            packet = person.pop('kart_bootstrap', None)
            if packet is None:
                if not person.get('kart_bootstrap_requested'):
                    person['kart_bootstrap_requested'] = room['kart_worker'].send(dict(type='bootstrap', target=sid))
                return
        if packet['sequence'] <= person.get('kart_acked', -1):
            return
        person['kart_pending'] = packet['sequence']
        person['kart_pending_anchor'] = packet['sequence'] if packet['type'] in ('baseline', 'anchor') else None
        socketio.emit('kart_snapshot', packet, namespace=NAMESPACE, to=sid)

    def kart_event(code, room, worker, meta, payload):
        with lock:
            current = rooms.get(code) is room and room.get('kart_worker') is worker
            kind = meta.get('type')
            if not current and kind != 'save':
                return
            if kind == 'failure':
                return stop(code, 'The Mario Kart simulation stopped. Return to lobbies to restart.')
            if kind == 'save':
                if worker.save_conflict:
                    return
                try:
                    raw = base64.b64decode(meta['data'], validate=True)
                    if len(raw) != 512:
                        raise ValueError('Invalid EEPROM')
                    from .saves import commit_authority_save
                    revision = commit_authority_save(app, worker.save_owner, 'mk64',
                        worker.save_revision, {'eeprom.bin': meta['data']})
                    if revision is None:
                        worker.save_conflict = True
                        if current: emit('kart_save_status', dict(epoch=room['epoch'], message='Account save changed in another session. This race will not overwrite it.'), code)
                    else:
                        worker.save_revision = revision
                except Exception:
                    app.logger.exception('Mario Kart authority save failed')
                    if current: emit('kart_save_status', dict(epoch=room['epoch'], message='Account save could not be written.'), code)
                return
            if kind not in ('baseline', 'anchor', 'state') or meta.get('epoch') != room['epoch']:
                return
            packet = dict(meta, payload=payload)
            if kind == 'anchor':
                anchors = room.setdefault('kart_anchors', {})
                anchors[meta['sequence']] = packet
                while len(anchors) > 8:
                    anchors.pop(next(iter(anchors)))
            elif kind == 'baseline' and meta.get('target'):
                person = room['members'].get(meta['target'])
                if person and person['connected']:
                    person['kart_bootstrap'] = packet
                    person['kart_bootstrap_requested'] = False
            else:
                room['kart_baseline' if kind == 'baseline' else 'kart_latest'] = packet
            if kind == 'state':
                room['completed'] = meta['frame']
                if room['phase'] == 'loading':
                    maybe_start(code)
            for sid in room['members']:
                kart_send(room, sid)

    @socketio.on('kart_ack', namespace=NAMESPACE)
    def kart_ack(data):
        with lock:
            room = rooms.get(membership.get(request.sid))
            if (not room or room['game']['backend'] != KART_BACKEND or not isinstance(data, dict)
                    or data.get('epoch') != room['epoch'] or type(data.get('sequence')) is not int):
                return
            person = room['members'][request.sid]
            if data['sequence'] != person.get('kart_pending'):
                return
            person['kart_pending'] = None
            person['kart_acked'] = data['sequence']
            person['kart_baseline'] = True
            if person.get('kart_pending_anchor') is not None:
                person['kart_anchor'] = person.pop('kart_pending_anchor')
            kart_send(room, request.sid)

    @socketio.on('kart_input', namespace=NAMESPACE)
    def kart_input(data):
        with lock:
            room = rooms.get(membership.get(request.sid))
            if (not room or room['game']['backend'] != KART_BACKEND or room['phase'] != 'running'
                    or request.sid not in room['sids'] or not room['members'][request.sid]['loaded']
                    or not isinstance(data, dict) or type(data.get('epoch')) is not int or data['epoch'] != room['epoch']
                    or type(data.get('frame')) is not int or not room['completed'] < data['frame'] <= room['completed']+40
                    or not GAMES['mk64'].valid_input(data.get('pad'))):
                return
            person = room['members'][request.sid]
            now = monotonic()
            if now-person.get('kart_rate_at', 0) >= 1:
                person.update(kart_rate_at=now, kart_rate=0)
            person['kart_rate'] = person.get('kart_rate', 0)+1
            if person['kart_rate'] > 120:
                return
            room['kart_worker'].send(dict(type='input', slot=person['slot'], epoch=room['epoch'], frame=data['frame'], pad=data['pad']))

    def stop(code, message):
        room = rooms.get(code)
        if room:
            close_kart(room)
            record_diagnostics('desync' if 'desynchron' in str(message).lower() or 'no longer match' in str(message).lower() else 'ended',code,room,reason=str(message)[:240])
            room['phase'] = 'ended'
            room['inputs'].clear()
            room['hashes'].clear()
            room.pop('frame_history', None)
            if room.get('party_history'):
                room.pop('party_history').close()
            if room.get('sync'):
                room['sync'].close()
            if not room['members'][room['host']]['connected']:
                room['host'] = next((sid for sid, person in room['members'].items() if person['connected']), room['host'])
            emit('stopped', {'message': message, 'epoch': room['epoch']}, code)
            publish(code)

    def remove(sid, code=None):
        code = membership.pop(sid, code)
        room = rooms.get(code)
        if not room:
            return
        if room['game']['backend'] == CMR2_BACKEND and room['phase'] == 'running' and sid in room['sids']:
            person = room['members'][sid]
            person['connected'] = False
            room['credentials'].pop(sid, None)
            socketio.server.leave_room(sid, 'retro:' + code, namespace=NAMESPACE)
            deliveries = room['native'].leave(room['sids'].index(sid))
            for seat, event in deliveries:
                socketio.emit('cmr2_event', dict(epoch=room['epoch'], **event), namespace=NAMESPACE, to=room['sids'][seat])
            if not any(p['connected'] for p in room['members'].values()):
                del rooms[code]
            else:
                if room['host'] == sid:
                    room['host'] = next(key for key, value in room['members'].items() if value['connected'])
                emit('cmr2_state', dict(epoch=room['epoch'], **room['native'].state()), code)
            publish(code)
            return
        if room['game']['backend'] == KART_BACKEND and room['phase'] == 'running' and sid in room['sids']:
            detach(code, room, sid)
            socketio.server.leave_room(sid, 'retro:' + code, namespace=NAMESPACE)
            return
        person = room['members'].pop(sid)
        room['credentials'].pop(sid, None)
        socketio.server.leave_room(sid, 'retro:' + code, namespace=NAMESPACE)
        if sid in room['sids']:
            room['sids'].remove(sid)
        if not any(p['connected'] for p in room['members'].values()):
            close_kart(room)
            del rooms[code]
        else:
            if room['host'] == sid:
                room['host'] = next(peer for peer, person in room['members'].items() if person['connected'])
            if person['role'] == 'player' and room['phase'] in ('loading', 'running'):
                if room['game']['backend'] == 'rollback-v1':
                    reset_lobby(code, room, dict(reason='player_left', epoch=room['epoch'], frame=room['completed']))
                else:
                    stop(code, 'A player left. Return to lobbies to start another game.')
            elif room['phase'] == 'lobby':
                reseat(room)
            maybe_start(code)
        publish(code)

    @socketio.on('connect', namespace=NAMESPACE)
    def connect(auth=None):
        origin = request.headers.get('Origin')
        return bool(current_user.is_authenticated and
                    (not origin or urlsplit(origin).netloc.lower() == request.host.lower()))

    @socketio.on('list', namespace=NAMESPACE)
    def list_rooms(data=None):
        with lock:
            emit('rooms', listing())

    @socketio.on('diagnostics', namespace=NAMESPACE)
    def diagnostics(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if not room or room['phase'] not in ('loading','running'):
                return
            person = room['members'][request.sid]
            now = monotonic()
            if now - person.get('diagnosticAt', -100) < 5:
                return
            if not isinstance(data,dict) or type(data.get('epoch')) is not int or data['epoch'] != room['epoch']:
                return
            values = validate_diagnostics(data)
            if values is None:
                return
            person['diagnosticAt'] = now
            record_diagnostics('sample',code,room,request.sid,
                gameFps=round(values['frames']*1000/values['windowMs'],2),
                displayCallbackFps=round(values['displayFrames']*1000/values['windowMs'],2),
                targetFps=room['game']['tickRate'], **values)

    @socketio.on('latency_probe', namespace=NAMESPACE)
    def latency_probe():
        return True

    @socketio.on('create', namespace=NAMESPACE)
    def create(data):
        game = GAMES.get(data.get('gameId')) if isinstance(data, dict) and isinstance(data.get('gameId'), str) else None
        # Fingerprinting can yield to the file-I/O pool. Keep it outside the
        # shared room lock so other rooms can relay their controller inputs.
        descriptor = game.descriptor(app) if game else None
        with lock:
            if not socketio.server.manager.is_connected(request.sid, NAMESPACE):
                return
            if request.sid in membership:
                return error('Leave your current room first.')
            if not isinstance(data, dict):
                return error('Choose a game and enter a room name.')
            game = GAMES.get(data.get('gameId')) if isinstance(data.get('gameId'), str) else None
            if not game:
                return error('That game is unavailable.')
            if not compatible(data.get('compatibility'), descriptor):
                return error('This game build changed or is unavailable. Reload the page.')
            name = data.get('name')
            if not isinstance(name, str) or not name.strip():
                return error('Enter a room name.')
            if len(rooms) >= 128:
                return error('Rooms are full. Try again shortly.')
            try:
                settings = game.validate_settings(data.get('settings'))
            except ValueError as exc:
                return error(str(exc))
            code = secrets.token_hex(4).upper()
            while code in rooms:
                code = secrets.token_hex(4).upper()
            rooms[code] = dict(name=name.strip()[:60], game=descriptor, settings=settings, host=request.sid,
                members={request.sid: member('player')}, sids=[request.sid], phase='lobby',
                epoch=0, inputs={}, hashes={}, completed=0, credentials={request.sid: dict(user=str(current_user.get_id()), token=secrets.token_urlsafe(32))})
            reseat(rooms[code])
            membership[request.sid] = code
            join_room('retro:' + code)
            emit('room', dict(state(code, rooms[code]), memberId=request.sid, resumeToken=rooms[code]['credentials'][request.sid]['token']))
            publish(code)

    @socketio.on('join', namespace=NAMESPACE)
    def join(data):
        with lock:
            if request.sid in membership:
                return error('Leave your current room first.')
            code = data.get('code') if isinstance(data, dict) else None
            room = rooms.get(code) if isinstance(code, str) else None
            if not room or len(room['members']) >= 20:
                return error('That room is unavailable.')
            if not compatible(data.get('compatibility'), room['game']):
                return error('Your game build does not match this room. Reload the page.')
            room['members'][request.sid] = member('spectator')
            if room['phase'] in ('loading', 'running'):
                room['members'][request.sid]['lateSpectator'] = True
                if room['game']['backend'] in MEDIA_BACKENDS:
                    room['members'][request.sid]['watchMode'] = 'media'
            room['credentials'][request.sid] = dict(user=str(current_user.get_id()), token=secrets.token_urlsafe(32))
            membership[request.sid] = code
            join_room('retro:' + code)
            emit('room', dict(state(code, room), memberId=request.sid, resumeToken=room['credentials'][request.sid]['token']))
            if room['phase'] in ('loading', 'running'):
                emit('prepare', preparation(code, room))
            publish(code)

    @socketio.on('role', namespace=NAMESPACE)
    def role(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            value = data.get('role') if isinstance(data, dict) else None
            if not room or room['phase'] != 'lobby' or value not in ('player', 'spectator'):
                return
            person = room['members'][request.sid]
            if value == person['role']:
                return
            if value == 'player':
                if len(room['sids']) >= room['game']['maxPlayers']:
                    return error('All player seats are taken. You can spectate.')
                room['sids'].append(request.sid)
            else:
                room['sids'].remove(request.sid)
            person.update(role=value, ready=False)
            reseat(room)
            publish(code)

    @socketio.on('ready', namespace=NAMESPACE)
    def ready(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if (not room or room['phase'] != 'lobby' or request.sid not in room['sids'] or
                    not isinstance(data, dict) or type(data.get('ready')) is not bool):
                return
            room['members'][request.sid]['ready'] = data['ready']
            publish(code)

    def loading_timeout(code, epoch, seconds=90):
        socketio.sleep(seconds)
        with lock:
            room = rooms.get(code)
            if room and room['epoch'] == epoch and room['phase'] == 'loading':
                if retained_lockstep(room):
                    for sid, person in list(room['members'].items()):
                        if person['role'] == 'spectator' and not person['loaded']:
                            socketio.emit('stopped', dict(epoch=epoch, message='Your spectator game could not load in time. Rejoin another lobby.'), namespace=NAMESPACE, to=sid)
                            remove(sid, code)
                    room = rooms.get(code)
                    if not room or room['phase'] != 'loading':
                        return
                stop(code, 'A player could not load the game. Return to lobbies and try again.')

    def prepare(code, room):
        close_kart(room)
        # A deliberate whole-session restart may rebuild the controller list.
        # During normal play, disconnected seats stay fixed in the native game.
        for sid, person in list(room['members'].items()):
            if not person['connected']:
                room['members'].pop(sid)
                room['credentials'].pop(sid, None)
                if sid in room['sids']:
                    room['sids'].remove(sid)
        reseat(room)
        if room.get('sync'):
            room['sync'].close()
        room.pop('sync', None)
        if room['game']['id'] in ('perfectdark', 'mk64', 'fzerox', 'smash64', 'marioparty', 'marioparty2'):
            from .saves import read_account_save
            owner = room['credentials'][room['sids'][0]]['user']
            room['initialSave'] = read_account_save(app, owner, room['game']['id'])
        room['seed'] = secrets.randbelow(0xffffffff) + 1
        room.update(phase='loading', inputs={}, hashes={}, completed=0)
        room.pop('frame_history', None)
        if room.get('party_history'):
            room.pop('party_history').close()
        room['party_recoveries'] = {}
        if party(room):
            room['party_history'] = PartyHistory(len(room['sids']))
        if retained_lockstep(room):
            room['frame_history'] = {}
        room.pop('rollback_peers', None)
        room.pop('spectatorStreams', None)
        room.pop('authority_relay', None)
        room.pop('native', None)
        room['media'] = NativeRelay(len(room['sids']))
        for sid, person in room['members'].items():
            person['loaded'] = False
            person.pop('lateSpectator', None)
            person.pop('watchMode', None)
            if person['role'] == 'spectator' and room['game']['backend'] in spectator_streams.BACKENDS:
                person['watchMode'] = 'media'
            person.pop('mediaSent', None)
            person.pop('mediaAck', None)
            person.pop('diagnosticAt', None)
            person.pop('recovering', None)
            record_diagnostics('loading',code,room,sid)
        if room['game']['backend'] == KART_BACKEND:
            if sum('kart_worker' in other for other in rooms.values()) >= kart_limit:
                return stop(code, 'Mario Kart servers are full. Try again shortly.')
            room['kart_save_owner'] = room['credentials'][room['sids'][0]]['user']
            room['kart_save_revision'] = room['initialSave']['revision']
            room['kart_save_conflict'] = False
            for person in room['members'].values():
                for key in ('kart_pending', 'kart_acked', 'kart_baseline', 'kart_anchor', 'kart_bootstrap', 'kart_bootstrap_requested', 'kart_pending_anchor'):
                    person.pop(key, None)
            worker = KartWorker(app, socketio, GAMES['mk64'], len(room['sids']), room['epoch'], room['initialSave'],
                lambda meta, payload: kart_event(code, room, worker, meta, payload))
            worker.gate = kart_slots
            worker.save_owner = room['kart_save_owner']
            worker.save_revision = room['kart_save_revision']
            worker.save_conflict = False
            room['kart_worker'] = worker
            socketio.start_background_task(worker.launch)
        emit('prepare', preparation(code, room), code)
        publish(code)
        socketio.start_background_task(loading_timeout, code, room['epoch'],
                                      300 if room['game']['backend'] in (NATIVE_BACKEND, SOLO_BACKEND, CMR2_BACKEND) else 90)

    @socketio.on('start_game', namespace=NAMESPACE)
    def start(data=None):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if not room or room['phase'] != 'lobby':
                return
            if room['host'] != request.sid:
                return error('Only the host can start the game.')
            if len(room['sids']) < 1 or not all(room['members'][sid]['ready'] for sid in room['sids']):
                return error('At least one player must join, and every player must be ready.')
            game = GAMES[room['game']['id']]
        descriptor = game.descriptor(app)
        with lock:
            if rooms.get(code) is not room or membership.get(request.sid) != code or room['phase'] != 'lobby':
                return
            if room['host'] != request.sid or not room['sids'] or not all(room['members'][sid]['ready'] for sid in room['sids']):
                return error('The room changed while starting. Check the players and try again.')
            if descriptor != room['game']:
                return error('The game build changed. Create a new room after reloading.')
            prepare(code, room)

    def maybe_start(code):
        room = rooms.get(code)
        if room and room['phase'] == 'loading' and (room['game']['backend'] != KART_BACKEND or room.get('kart_latest')) and all(p['loaded'] for p in room['members'].values() if not p.get('lateSpectator') and (room['game']['backend'] != KART_BACKEND or p['role'] == 'player')):
            room['phase'] = 'running'
            if room['game']['backend'] in (NATIVE_BACKEND, SOLO_BACKEND, CMR2_BACKEND):
                room['native'] = CMR2Relay(len(room['sids'])) if room['game']['backend'] == CMR2_BACKEND else NativeRelay(len(room['sids']))
            record_diagnostics('started',code,room)
            if room['game']['backend'] == AUTHORITY_BACKEND:
                room['authority_relay'] = AuthorityRelay(len(room['sids']), room['game']['tickRate'], room['game']['authoritative'])
            if room['game']['backend'] == SYNC_BACKEND:
                room['sync'] = InputHistory(len(room['sids']))
            emit('start', state(code, room), code)
            if room['game']['backend'] == KART_BACKEND:
                room['kart_worker'].send(dict(type='start'))
                for sid in room['members']:
                    kart_send(room, sid)
            publish(code)
            if room['game']['backend'] == SYNC_BACKEND:
                socketio.start_background_task(sync_idle, code, room['epoch'])

    @socketio.on('loaded', namespace=NAMESPACE)
    def loaded(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if (not room or room['phase'] not in ('loading', 'running') or not isinstance(data, dict) or
                    data.get('epoch') != room['epoch'] or not compatible(data.get('compatibility'), room['game'])):
                return
            person = room['members'][request.sid]
            if person['loaded']:
                return
            record_diagnostics('loaded',code,room,request.sid)
            if room['phase'] == 'running' and room['game']['backend'] == KART_BACKEND:
                person['loaded'] = True
                emit('start', state(code, room))
                kart_send(room, request.sid)
                return
            if room['phase'] == 'running' and party(room) and person.get('recovering'):
                person['loaded'] = True
                emit('start', state(code, room))
                return
            if room['phase'] == 'running' and person.get('watchMode') == 'media':
                person['loaded'] = True
                emit('start', state(code, room))
                return
            if room['phase'] == 'running' and room['game']['backend'] in (SYNC_BACKEND, NATIVE_BACKEND, SOLO_BACKEND, CMR2_BACKEND):
                person['loaded'] = True
                emit('start', state(code, room))
                return
            if room['phase'] == 'running':
                if (person['role'] != 'spectator' and not person.get('resuming')) or room['game']['backend'] != AUTHORITY_BACKEND:
                    return
                baseline = room['authority_relay'].bootstrap()
                if baseline is None:
                    emit('stopped', dict(epoch=room['epoch'], message='The current game state is unavailable. Try joining again.'))
                    return remove(request.sid)
                person['loaded'] = True
                emit('start', state(code, room))
                emit('world_bootstrap', dict(epoch=room['epoch'], **baseline))
                person.pop('resuming',None)
            else:
                person['loaded'] = True
                maybe_start(code)

    def native_room(data):
        code = membership.get(request.sid)
        room = rooms.get(code)
        if (not room or room['phase'] != 'running' or not room.get('native') or
                not isinstance(data, dict) or type(data.get('epoch')) is not int or data['epoch'] != room['epoch']):
            return code, None
        return code, room

    @socketio.on('cmr2_command', namespace=NAMESPACE)
    def cmr2_command(data):
        with lock:
            code, room = native_room(data)
            if not room or room['game']['backend'] != CMR2_BACKEND or request.sid not in room['sids']:
                return dict(ok=False, message='CMR2 room is unavailable.')
            try:
                deliveries = room['native'].command(room['sids'].index(request.sid), data)
            except ValueError as exc:
                return dict(ok=False, message=str(exc))
            for seat, event in deliveries:
                socketio.emit('cmr2_event', dict(epoch=room['epoch'], **event), namespace=NAMESPACE, to=room['sids'][seat])
            snapshot = dict(epoch=room['epoch'], **room['native'].state())
            emit('cmr2_state', snapshot, code)
            return dict(ok=True, **snapshot)

    @socketio.on('cmr2_packet', namespace=NAMESPACE)
    def cmr2_packet(data):
        with lock:
            code, room = native_room(data)
            if not room or room['game']['backend'] != CMR2_BACKEND or request.sid not in room['sids']:
                return
            try:
                deliveries = room['native'].packet(room['sids'].index(request.sid), data)
            except ValueError as exc:
                return error(str(exc))
            for seat, event in deliveries:
                event['from'] = event.pop('from_')
                socketio.emit('cmr2_event', dict(epoch=room['epoch'], **event), namespace=NAMESPACE, to=room['sids'][seat])

    @socketio.on('diablo_packet', namespace=NAMESPACE)
    def diablo_packet(data):
        with lock:
            code, room = native_room(data)
            if not room or room['game']['backend'] != NATIVE_BACKEND or request.sid not in room['sids']:
                return
            try:
                deliveries = room['native'].receive(room['sids'].index(request.sid), data.get('packet'))
            except ValueError as exc:
                return stop(code, str(exc))
            for seat, packet in deliveries:
                socketio.emit('diablo_packet', dict(epoch=room['epoch'], packet=packet),
                              namespace=NAMESPACE, to=room['sids'][seat])

    @socketio.on('cmr2_media', namespace=NAMESPACE)
    @socketio.on('solo_media', namespace=NAMESPACE)
    @socketio.on('diablo_media', namespace=NAMESPACE)
    def diablo_media(data):
        with lock:
            code, room = native_room(data)
            if not room or not room['sids'] or request.sid != room['sids'][room['native'].coordinator if room['game']['backend'] == CMR2_BACKEND else 0]:
                return
            kind, payload = data.get('kind'), data.get('payload')
            if kind not in ('video', 'audio') or not isinstance(payload, bytes):
                return
            if kind == 'video':
                if not 12 <= len(payload) <= 192 * 1024 or payload[:4] != b'RIFF' or payload[8:12] != b'WEBP':
                    return
                if not room['native'].allow('video-frames', 1, 24, 3):
                    return
            else:
                if not 2 <= len(payload) <= 8192 or len(payload) % 2:
                    return
                if not room['native'].allow('audio-bytes', len(payload), 32000, 16000):
                    return
            for sid, person in room['members'].items():
                if person['role'] == 'spectator' and person['loaded'] and not spectator_streams.streaming(room, sid):
                    sent = person.get('mediaSent', 0)
                    if sent - person.get('mediaAck', 0) >= 8:
                        continue
                    person['mediaSent'] = sent + 1
                    socketio.emit('cmr2_media' if room['game']['backend'] == CMR2_BACKEND else 'solo_media' if room['game']['backend'] == SOLO_BACKEND else 'diablo_media', dict(epoch=room['epoch'], kind=kind, payload=payload, sequence=sent + 1),
                                  namespace=NAMESPACE, to=sid)

    @socketio.on('cmr2_media_ack', namespace=NAMESPACE)
    @socketio.on('solo_media_ack', namespace=NAMESPACE)
    @socketio.on('diablo_media_ack', namespace=NAMESPACE)
    def diablo_media_ack(data):
        with lock:
            _, room = native_room(data)
            if not room:
                return
            person = room['members'][request.sid]
            sequence = data.get('sequence')
            if (person['role'] == 'spectator' and type(sequence) is int and
                    person.get('mediaAck', 0) < sequence <= person.get('mediaSent', 0)):
                person['mediaAck'] = sequence

    @socketio.on('restart_game', namespace=NAMESPACE)
    def restart(data=None):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if room and room['phase'] == 'running' and room['host'] == request.sid:
                room['epoch'] += 1
                prepare(code, room)

    def reset_lobby(code, room, interruption=None):
        close_kart(room)
        if room.get('party_history'):
            room.pop('party_history').close()
        room.pop('party_recoveries', None)
        if room.get('sync'):
            room['sync'].close()
        for key in ('sync', 'native', 'media', 'spectatorStreams', 'authority_relay', 'rollback_peers', 'frame_history', 'initialSave'):
            room.pop(key, None)
        for sid, person in list(room['members'].items()):
            if not person['connected']:
                room['members'].pop(sid)
                room['credentials'].pop(sid, None)
                membership.pop(sid, None)
                if sid in room['sids']:
                    room['sids'].remove(sid)
                continue
            person.update(ready=False, loaded=False)
            for key in ('lateSpectator', 'watchMode', 'mediaSent', 'mediaAck', 'resuming', 'diagnosticAt', 'recovering'):
                person.pop(key, None)
        room.update(phase='lobby', epoch=room['epoch'] + 1, inputs={}, hashes={}, completed=0)
        reseat(room)
        returned = state(code, room)
        if interruption is not None:
            returned['interruption'] = interruption
        emit('lobby_returned', returned, code)
        publish(code)

    @socketio.on('return_lobby', namespace=NAMESPACE)
    def return_lobby(data=None):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if not room or room['host'] != request.sid:
                return error('Only the host can return everyone to the lobby.')
            if room['phase'] == 'lobby':
                return
            reset_lobby(code, room)

    @socketio.on('change_game', namespace=NAMESPACE)
    def change_game(data):
        game = GAMES.get(data.get('gameId')) if isinstance(data, dict) and isinstance(data.get('gameId'), str) else None
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if not room or room['host'] != request.sid or room['phase'] != 'lobby':
                return error('Only the host can choose a game in the lobby.')
            epoch = room['epoch']
        descriptor = game.descriptor(app) if game else None
        with lock:
            if rooms.get(code) is not room or membership.get(request.sid) != code or room['host'] != request.sid or room['phase'] != 'lobby' or room['epoch'] != epoch:
                return error('The room changed. Try choosing the game again.')
            if not game or not compatible(data.get('compatibility'), descriptor):
                return error('This game is unavailable or has changed. Reload the page.')
            try:
                settings = game.validate_settings(data.get('settings'))
            except ValueError as exc:
                return error(str(exc))
            room.update(game=descriptor, settings=settings, epoch=epoch + 1)
            for sid in room['sids'][descriptor['maxPlayers']:]:
                room['members'][sid]['role'] = 'spectator'
            room['sids'] = room['sids'][:descriptor['maxPlayers']]
            for person in room['members'].values():
                person.update(ready=False, loaded=False)
            reseat(room)
            publish(code)

    @socketio.on('spectator_media', namespace=NAMESPACE)
    def spectator_media(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if (not room or room['phase'] != 'running' or room['game']['backend'] not in spectator_streams.BACKENDS
                    or request.sid != spectator_streams.publisher(room) or not isinstance(data, dict)
                    or type(data.get('epoch')) is not int or data['epoch'] != room['epoch']):
                return
            kind, payload = data.get('kind'), data.get('payload')
            if not isinstance(payload, bytes):
                return
            if kind == 'video':
                if not 12 <= len(payload) <= 192 * 1024 or payload[:4] != b'RIFF' or payload[8:12] != b'WEBP' or not room['media'].allow('video', 1, 24, 3):
                    return
            elif kind == 'audio':
                if not 2 <= len(payload) <= 8192 or len(payload) % 2 or not room['media'].allow('audio', len(payload), 32000, 16000):
                    return
            else:
                return
            for sid, person in room['members'].items():
                if not spectator_streams.viewer(room, person) or spectator_streams.streaming(room, sid):
                    continue
                sent = person.get('mediaSent', 0)
                if sent - person.get('mediaAck', 0) >= 8:
                    continue
                person['mediaSent'] = sent + 1
                socketio.emit('spectator_media', dict(epoch=room['epoch'], kind=kind, payload=payload, sequence=sent + 1), namespace=NAMESPACE, to=sid)

    @socketio.on('spectator_media_ack', namespace=NAMESPACE)
    def spectator_media_ack(data):
        with lock:
            room = rooms.get(membership.get(request.sid))
            if not room or room['phase'] != 'running' or not isinstance(data, dict) or data.get('epoch') != room['epoch']:
                return
            person = room['members'][request.sid]
            sequence = data.get('sequence')
            if spectator_streams.viewer(room, person) and type(sequence) is int and person.get('mediaAck', 0) < sequence <= person.get('mediaSent', 0):
                person['mediaAck'] = sequence

    def rollback_player(data):
        code = membership.get(request.sid)
        room = rooms.get(code)
        if (not room or room['phase'] != 'running' or room['game']['backend'] != 'rollback-v1' or
                room['game']['rollback'].get('peerInputs') is not True or request.sid not in room['sids'] or
                not isinstance(data, dict) or type(data.get('epoch')) is not int or data['epoch'] != room['epoch']):
            return None
        return room

    @socketio.on('rollback_connect', namespace=NAMESPACE)
    def rollback_connect(data):
        with lock:
            room = rollback_player(data)
            if not room:
                return
            peers = room.setdefault('rollback_peers', set())
            slot = room['sids'].index(request.sid)
            first = request.sid not in peers
            peers.add(request.sid)
            emit('rollback_transport', dict(epoch=room['epoch'], slot=slot, players=len(room['sids']),
                peers=[room['sids'].index(sid) for sid in peers], iceServers=rollback_ice_servers(app)))
            if first:
                for sid in peers - {request.sid}:
                    socketio.emit('rollback_peer', dict(epoch=room['epoch'], slot=slot), namespace=NAMESPACE, to=sid)

    @socketio.on('rollback_signal', namespace=NAMESPACE)
    def rollback_signal(data):
        with lock:
            room = rollback_player(data)
            if not room:
                return
            peers = room.get('rollback_peers', set())
            target, kind, value = data.get('to'), data.get('type'), data.get('value')
            source = room['sids'].index(request.sid)
            if (request.sid not in peers or type(target) is not int or not 0 <= target < len(room['sids']) or
                    target == source or room['sids'][target] not in peers):
                return
            generation = data.get('generation', 0)
            if type(generation) is not int or not 0 <= generation <= 4:
                return
            if kind in ('offer', 'answer'):
                if not isinstance(value, str) or not 1 <= len(value) <= 65536 or (kind == 'offer') != (source < target):
                    return
            elif kind == 'candidate':
                if (not isinstance(value, dict) or set(value) - {'candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'} or
                        not isinstance(value.get('candidate'), str) or not 1 <= len(value['candidate']) <= 2048):
                    return
                for key in ('sdpMid', 'usernameFragment'):
                    if value.get(key) is not None and (not isinstance(value[key], str) or len(value[key]) > 256):
                        return
                if value.get('sdpMLineIndex') is not None and (type(value['sdpMLineIndex']) is not int or not 0 <= value['sdpMLineIndex'] <= 65535):
                    return
            elif kind == 'restart':
                # The lower seat owns offers. A higher seat can ask it to
                # replace the failed connection, within a bounded generation.
                if source < target or 'generation' not in data or 'value' not in data or value is not None:
                    return
            else:
                return
            person = room['members'][request.sid]
            now = monotonic()
            if now - person.get('rollbackSignalAt', -100) >= 10:
                person['rollbackSignalAt'], person['rollbackSignals'] = now, 0
            if person.get('rollbackSignals', 0) >= 128:
                return
            person['rollbackSignals'] = person.get('rollbackSignals', 0) + 1
            # Both ends are authenticated room seats; ignore any claimed sender.
            event = dict(epoch=room['epoch'], **{'from': source}, to=target, type=kind, value=value)
            # Omission retains the original generation-zero wire format.
            if 'generation' in data:
                event['generation'] = generation
            socketio.emit('rollback_signal', event,
                          namespace=NAMESPACE, to=room['sids'][target])

    def drain_inputs(code, room):
        if lockstep_paused(room):
            return
        while all(p is not None for p in room['inputs'].get(room['completed'] + 1, [None])):
            frame = room['completed'] + 1
            pads = room['inputs'].pop(frame)
            if party(room):
                try:
                    room['party_history'].append(frame, pads)
                except (OSError, ValueError):
                    return stop(code, 'The match input history could not be saved. Return to lobbies.')
            room['completed'] = frame
            packet = dict(frame=frame, pads=pads, epoch=room['epoch'])
            if retained_lockstep(room):
                history = room['frame_history']
                history[frame] = packet
                if len(history) > MK64_HISTORY:
                    del history[next(iter(history))]
            emit('frameset', packet, code)

    @socketio.on('input', namespace=NAMESPACE)
    def input_frame(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if (not room or room['phase'] != 'running' or request.sid not in room['sids'] or
                    not isinstance(data, dict) or data.get('epoch') != room['epoch']):
                return
            if room['members'][request.sid].get('recovering'):
                return
            frame, pad = data.get('frame'), data.get('pad')
            if room['game']['backend'] not in ('recomp-ring-lockstep-v1', 'rollback-v1'):
                return
            rollback = room['game']['backend'] == 'rollback-v1'
            window = (room['game']['rollback']['maxPrediction'] +
                      max(room['game']['rollback']['inputDelay'],
                          room['game']['rollback'].get('confirmedInputDelay', 0)) + 2) if rollback else WINDOW
            if rollback and room['game']['rollback'].get('peerInputs') is True:
                # Peer inputs may advance before the TCP journal catches up.
                # Clients cap that lead at 120, leaving eight frames of margin.
                window = 128
            if (type(frame) is not int or not room['completed'] < frame <= room['completed'] + window or
                    not GAMES[room['game']['id']].valid_input(pad)):
                return
            slot = room['sids'].index(request.sid)
            row = room['inputs'].setdefault(frame, [None] * len(room['sids']))
            if row[slot] is not None and row[slot] != pad:
                return stop(code, 'Conflicting controller inputs received. Return to lobbies.')
            first = row[slot] is None
            row[slot] = dict(pad)
            if rollback and first:
                # Rollback peers need each input immediately, before the full row.
                # The authenticated membership determines slot, never client data.
                emit('frame_input', dict(frame=frame, slot=slot, pad=dict(pad), epoch=room['epoch']), code)
            drain_inputs(code, room)

    @socketio.on('hash', namespace=NAMESPACE)
    def hash_frame(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if (not room or room['phase'] != 'running' or request.sid not in room['sids'] or
                    not isinstance(data, dict) or data.get('epoch') != room['epoch']):
                return
            if room['members'][request.sid].get('recovering'):
                return
            frame, value = data.get('frame'), data.get('hash')
            if room['game']['backend'] not in ('recomp-ring-lockstep-v1', 'rollback-v1'):
                return
            if (type(frame) is not int or type(value) is not int or not 0 <= value <= 0xffffffff or
                    frame < max(0, room['completed'] - 120) or frame > room['completed']):
                return
            room['hashes'] = {f: h for f, h in room['hashes'].items() if f >= room['completed'] - 120}
            row = room['hashes'].setdefault(frame, {})
            row[request.sid] = value
            if len(row) == len(room['sids']) and len(set(row.values())) != 1:
                if room['game']['backend'] == 'rollback-v1':
                    # No server simulation exists to choose a correct peer state.
                    # Preserve evidence before clearing the old epoch, then keep
                    # the group together in a usable lobby with fresh readiness.
                    checksums = [dict(slot=slot, hash=row[sid]) for slot, sid in enumerate(room['sids'])]
                    record_diagnostics('desync', code, room, frame=frame,
                                       build=room['game']['build'], checksums=checksums)
                    reset_lobby(code, room, dict(reason='desync', epoch=room['epoch'],
                                                frame=frame, checksums=checksums))
                else:
                    stop(code, f'Game desynchronized at frame {frame}. Return to lobbies and try again.')

    def sync_room(data):
        code = membership.get(request.sid)
        room = rooms.get(code)
        if (not room or room['phase'] != 'running' or room['game']['backend'] != SYNC_BACKEND
                or not isinstance(data, dict) or type(data.get('epoch')) is not int
                or data['epoch'] != room['epoch'] or not room['members'][request.sid]['loaded']):
            return None, None
        return code, room

    def sync_broadcast(code, room, packet):
        if packet:
            room['completed'] = room['sync'].frame
            for sid, person in room['members'].items():
                if person['connected'] and person['loaded']:
                    socketio.emit('sync_frames', dict(epoch=room['epoch'], **packet), namespace=NAMESPACE, to=sid)
        if room['sync'].frame >= MAX_FRAMES:
            stop(code, 'This session reached its 24-hour history limit.')

    def sync_drain(code, room):
        sync_broadcast(code, room, room['sync'].drain())

    def sync_idle(code, epoch):
        previous = monotonic()
        while True:
            socketio.sleep(0.05)
            with lock:
                room = rooms.get(code)
                if not room or room['phase'] != 'running' or room['epoch'] != epoch:
                    return
                now = monotonic()
                count = int((now - previous) * 60)
                previous += count / 60
                if now - previous > 0.25:
                    previous = now
                if any(p['connected'] and p['loaded'] for p in room['members'].values()):
                    sync_broadcast(code, room, room['sync'].idle(count))

    @socketio.on('sync_input', namespace=NAMESPACE)
    def sync_input(data):
        with lock:
            code, room = sync_room(data)
            if not room or request.sid not in room['sids']:
                return
            try:
                if room['sync'].input(room['sids'].index(request.sid), data.get('frame'), data.get('command')):
                    sync_drain(code, room)
            except ValueError as exc:
                stop(code, str(exc))

    @socketio.on('sync_pause', namespace=NAMESPACE)
    def sync_pause(data):
        # Hidden browsers may stop animation callbacks. Release only this seat
        # so the original game continues with neutral input for the absent user.
        with lock:
            code, room = sync_room(data)
            if room and request.sid in room['sids']:
                room['sync'].seat(room['sids'].index(request.sid), False)
                sync_drain(code, room)

    @socketio.on('sync_replay', namespace=NAMESPACE)
    def sync_replay(data):
        with lock:
            code, room = sync_room(data)
            if room:
                packet = room['sync'].packet(data.get('start'))
                if packet is not None:
                    emit('sync_history', dict(epoch=room['epoch'], **packet))

    @socketio.on('sync_ready', namespace=NAMESPACE)
    def sync_ready(data):
        with lock:
            code, room = sync_room(data)
            frame = data.get('frame') if isinstance(data,dict) else None
            if not room or type(frame) is not int or not 0 <= frame <= room['sync'].frame:
                return
            if frame < room['sync'].frame - 32:
                emit('sync_history', dict(epoch=room['epoch'], **room['sync'].packet(frame+1)))
                return
            slot = room['sids'].index(request.sid) if request.sid in room['sids'] else None
            if slot is not None and room['sync'].active[slot] is None:
                room['sync'].seat(slot, True)
            emit('sync_live', dict(epoch=room['epoch'], through=room['sync'].frame))

    @socketio.on('sync_hash', namespace=NAMESPACE)
    def sync_hash(data):
        with lock:
            code, room = sync_room(data)
            if not room:
                return
            if request.sid not in room['sids']:
                frame, value = data.get('frame'), data.get('hash')
                expected = room['sync'].hashes.get(frame, {}) if type(frame) is int else {}
                if expected and type(value) is int and value not in expected.values():
                    record_diagnostics('spectator_desync',code,room,request.sid,frame=frame)
                    emit('stopped',dict(epoch=room['epoch'],message='Your spectator game no longer matches. Rejoin to replay the session.'))
                    remove(request.sid)
                return
            if not room['sync'].check_hash(room['sids'].index(request.sid), data.get('frame'), data.get('hash')):
                stop(code, 'Game states no longer match. Return to lobbies to start a fresh session.')

    @socketio.on('fps_command', namespace=NAMESPACE)
    def fps_command(data):
        with lock:
            room = rooms.get(membership.get(request.sid))
            if (not room or room['phase'] != 'running' or request.sid not in room['sids']
                    or room['game']['backend'] != AUTHORITY_BACKEND or not isinstance(data, dict)
                    or type(data.get('epoch')) is not int or data['epoch'] != room['epoch']):
                return
            if not room['members'][room['sids'][0]]['connected']:
                return
            packet = room['authority_relay'].command(room['sids'].index(request.sid), data)
            if packet is not None:
                # Commands go only to the designated simulation authority. A
                # spectator can own the lobby, so authority is player slot zero.
                socketio.emit('fps_command', dict(epoch=room['epoch'], **packet),
                              namespace=NAMESPACE, to=room['sids'][0])

    @socketio.on('world_snapshot', namespace=NAMESPACE)
    def world_snapshot(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if (not room or room['phase'] != 'running' or room['game']['backend'] != AUTHORITY_BACKEND
                    or request.sid != room['sids'][0] or not isinstance(data, dict)
                    or type(data.get('epoch')) is not int or data['epoch'] != room['epoch']):
                return
            first = room['authority_relay'].tick < 0
            snapshot = room['authority_relay'].snapshot(data)
            if snapshot is not None:
                room['completed'] = snapshot['tick']
                for sid, person in room['members'].items():
                    if person['loaded'] and person['connected']:
                        socketio.emit('world_snapshot', dict(epoch=room['epoch'], **snapshot), namespace=NAMESPACE, to=sid)
                if first:
                    publish(code)

    @socketio.on('world_resync', namespace=NAMESPACE)
    def world_resync(data):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if (not room or room['phase']!='running' or room['game']['backend']!=AUTHORITY_BACKEND
                    or not room['members'][request.sid]['loaded'] or not isinstance(data,dict)
                    or type(data.get('epoch')) is not int or data['epoch']!=room['epoch']):
                return
            credential=room['credentials'][request.sid]
            now=monotonic()
            if now-credential.get('lastResync',-1e9)<0.2:
                return
            packet=room['authority_relay'].recovery(data.get('afterEvent'))
            if packet is not None:
                credential['lastResync']=now
                emit('world_recovery',dict(epoch=room['epoch'],**packet))

    @socketio.on('failed', namespace=NAMESPACE)
    def failed(data=None):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if room and isinstance(data, dict) and data.get('epoch') == room['epoch']:
                record_diagnostics('client_failure',code,room,request.sid,reason=str(data.get('message','Client could not continue'))[:240])
                if room['phase'] == 'running' and room['game']['backend'] in (CMR2_BACKEND, KART_BACKEND):
                    # A local graphics/runtime failure is a departure, not a
                    # failure of the other independently simulated cars.
                    remove(request.sid)
                elif room['phase'] == 'running' and (room['game']['backend'] == SYNC_BACKEND or
                        (party(room) and room['members'][request.sid].get('recovering'))):
                    detach(code, room, request.sid)
                    leave_room('retro:' + code)
                elif room['phase'] == 'loading' and request.sid not in room['sids'] and (room['game']['backend'] == KART_BACKEND or retained_lockstep(room) or room['members'][request.sid].get('lateSpectator')):
                    remove(request.sid)
                elif room['phase'] == 'loading' or request.sid in room['sids']:
                    if room['game']['backend'] == 'rollback-v1' and room['phase'] in ('loading', 'running'):
                        reset_lobby(code, room, dict(reason='runtime_failure', epoch=room['epoch'], frame=room['completed']))
                    elif room['phase'] != 'lobby':
                        stop(code, 'A participant could not continue the game. Return to lobbies.')
                else:
                    remove(request.sid)

    @socketio.on('leave', namespace=NAMESPACE)
    def leave(data=None):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if (room and room['phase'] == 'running' and room['game']['backend'] in (AUTHORITY_BACKEND, SYNC_BACKEND, KART_BACKEND)
                    and request.sid in (room['sids'] if room['game']['backend'] in (SYNC_BACKEND, KART_BACKEND) else room['sids'][1:])):
                # An absent controller gets neutral input; its seat must not be
                # removed or renumbered underneath the running simulation.
                detach(code, room, request.sid)
                room['credentials'].pop(request.sid, None)
                leave_room('retro:' + code)
                if room['game']['backend'] == KART_BACKEND and not any(p['connected'] for p in room['members'].values()):
                    close_kart(room)
                    del rooms[code]
                    publish()
            else:
                remove(request.sid)

    def expire_mk64(code, sid, disconnected_at):
        socketio.sleep(MK64_RECONNECT_SECONDS)
        with lock:
            room = rooms.get(code)
            person = room['members'].get(sid) if room else None
            if (not room or not person or person['connected'] or
                    person.get('disconnectedAt') != disconnected_at or room['phase'] != 'running'):
                return
            if not any(p['connected'] for p in room['members'].values()):
                del rooms[code]
                publish()
            elif person['role'] == 'player':
                stop(code, 'A player could not reconnect within 15 seconds. Return to lobbies.')
            else:
                remove(sid, code)

    def expire_disconnected(code, sid, disconnected_at):
        socketio.sleep(120)
        with lock:
            room = rooms.get(code)
            person = room['members'].get(sid) if room else None
            if (room and person and not person['connected'] and person.get('disconnectedAt') == disconnected_at
                    and room['phase'] == 'running'):
                if not any(p['connected'] for p in room['members'].values()):
                    close_kart(room)
                    del rooms[code]; publish()
                elif room['sids'][0] == sid and room['game']['backend'] == AUTHORITY_BACKEND:
                    stop(code, 'The host did not reconnect. The game session has ended.')
                elif person['role'] == 'spectator':
                    remove(sid,code)

    def detach(code, room, sid):
        membership.pop(sid, None)
        person = room['members'][sid]
        person['connected'] = False
        person['disconnectedAt'] = monotonic()
        if room['game']['backend'] == KART_BACKEND and sid in room['sids']:
            room['kart_worker'].send(dict(type='depart', slot=room['sids'].index(sid)))
        if retained_lockstep(room):
            if sid in room['sids']:
                emit('transport_paused', dict(epoch=room['epoch']), code)
            if room['game']['id'] == 'mk64':
                socketio.start_background_task(expire_mk64, code, sid, person['disconnectedAt'])
            else:
                # Mario Party preserves a paused match as long as someone stays.
                # Give a connected player lobby controls if the host loses transport.
                if room['host'] == sid:
                    room['host'] = next((peer for peer in room['sids']
                                         if room['members'][peer]['connected']), room['host'])
                socketio.start_background_task(expire_disconnected, code, sid, person['disconnectedAt'])
            publish(code)
            return
        if room['game']['backend'] == SYNC_BACKEND and sid in room['sids']:
            room['sync'].seat(room['sids'].index(sid), False)
            sync_drain(code, room)
        if room['game']['backend'] == AUTHORITY_BACKEND and room['sids'][0] == sid:
            emit('transport_paused', dict(epoch=room['epoch']), code)
        if room['host'] == sid and (room['game']['backend'] in (SYNC_BACKEND, KART_BACKEND) or room['sids'][0] != sid):
            room['host'] = next((peer for peer in room['sids']
                                 if room['members'][peer]['connected']),
                                next((peer for peer, member in room['members'].items() if member['connected']), room['sids'][0]))
        socketio.start_background_task(expire_disconnected, code, sid, person['disconnectedAt'])
        publish(code)

    def party_recovery(data):
        code = membership.get(request.sid)
        room = rooms.get(code)
        if (not room or room['phase'] != 'running' or not party(room) or
                not isinstance(data, dict) or type(data.get('epoch')) is not int or data['epoch'] != room['epoch']):
            return code, None, None
        recovery = room.get('party_recoveries', {}).get(request.sid)
        return code, room, recovery

    @socketio.on('party_replay', namespace=NAMESPACE)
    def party_replay(data):
        with lock:
            code, room, recovery = party_recovery(data)
            if not recovery or not room['members'][request.sid]['loaded']:
                return
            start = data.get('start')
            if type(start) is not int or start != recovery['next']:
                return error('Unexpected Mario Party replay position.')
            packet = room['party_history'].packet(start, room['epoch'])
            if packet is not None:
                recovery['next'] += len(packet['frames'])
                emit('party_history', packet)

    @socketio.on('party_replay_ready', namespace=NAMESPACE)
    def party_replay_ready(data):
        with lock:
            code, room, recovery = party_recovery(data)
            if (not recovery or not room['members'][request.sid]['loaded'] or
                    type(data.get('frame')) is not int or data['frame'] != recovery['through'] or
                    recovery['next'] != recovery['through'] + 1):
                return
            value = data.get('hash')
            expected = recovery['checkpointHash']
            if expected is not None and (type(value) is not int or value != expected):
                # Keep the established players and their match paused; a bad replay
                # must not release the barrier or tear down the group.
                socketio.emit('stopped', dict(epoch=room['epoch'], message='Recovered game state did not match. Reload to retry.'), namespace=NAMESPACE, to=request.sid)
                detach(code, room, request.sid)
                leave_room('retro:' + code)
                return
            room['members'][request.sid].pop('recovering', None)
            room['party_recoveries'].pop(request.sid)
            emit('party_live', dict(epoch=room['epoch'], completed=room['completed'], paused=lockstep_paused(room)))
            if not lockstep_paused(room):
                emit('transport_resumed', dict(epoch=room['epoch']), code)
                drain_inputs(code, room)
            publish(code)

    @socketio.on('resume', namespace=NAMESPACE)
    def resume(data):
        with lock:
            if request.sid in membership or not isinstance(data, dict):
                return
            code = data.get('code')
            room = rooms.get(code) if isinstance(code,str) else None
            if (not room or room['phase'] != 'running' or (room['game']['backend'] not in (AUTHORITY_BACKEND, SYNC_BACKEND, KART_BACKEND) and not retained_lockstep(room))
                    or not compatible(data.get('compatibility'), room['game']) or not isinstance(data.get('token'),str)):
                return error('This game session cannot be resumed.')
            old = next((sid for sid, credential in room['credentials'].items()
                        if credential['user'] == str(current_user.get_id()) and secrets.compare_digest(credential['token'],data['token'])), None)
            fresh_party = party(room) and data.get('retained') is False
            fresh_kart = room['game']['backend'] == KART_BACKEND
            if old is None or (room['members'][old]['connected'] and not (fresh_party or fresh_kart)):
                return error('This seat is already connected or the resume key is invalid.')
            if fresh_party and old not in room['sids']:
                return error('Only a player seat can replay this match.')
            if (fresh_party or fresh_kart) and room['members'][old]['connected']:
                # Reload can beat the old socket's disconnect notification.
                socketio.emit('stopped', dict(epoch=room['epoch'], message='Your seat was resumed in another tab.'), namespace=NAMESPACE, to=old)
                detach(code, room, old)
                socketio.server.leave_room(old, 'retro:' + code, namespace=NAMESPACE)
            if retained_lockstep(room) and not fresh_party:
                frame = data.get('frame')
                if (data.get('retained') is not True or type(data.get('epoch')) is not int or
                        data['epoch'] != room['epoch'] or type(frame) is not int or not 0 <= frame <= room['completed']):
                    return error('The original game state is required to reconnect.')
                if room['game']['id'] == 'mk64' and monotonic() - room['members'][old]['disconnectedAt'] >= MK64_RECONNECT_SECONDS:
                    return error('The reconnect window expired. Return to lobbies.')
                history = room['frame_history']
                if frame < room['completed'] and (not history or frame + 1 < next(iter(history))):
                    return error('Your game is too far behind to reconnect. Return to lobbies.')
            # Keeping the same WASM engine avoids pretending a host reload can
            # reconstruct an authority without a complete game-specific codec.
            if room['game']['backend'] == AUTHORITY_BACKEND and old == room['sids'][0] and data.get('retained') is not True:
                return error('The host must reconnect from the original game tab.')
            if room['game']['backend'] == AUTHORITY_BACKEND and data.get('retained') is not True and room['authority_relay'].bootstrap() is None:
                return error('The current game checkpoint is not ready yet.')
            person = room['members'][old]
            room['members'] = {request.sid if sid == old else sid: value for sid,value in room['members'].items()}
            room['sids'] = [request.sid if sid == old else sid for sid in room['sids']]
            credential = room['credentials'].pop(old)
            room['credentials'][request.sid] = credential
            person['connected'] = True; person.pop('disconnectedAt',None)
            record_diagnostics('reconnected',code,room,request.sid)
            if room['host'] == old:
                room['host'] = request.sid
            membership[request.sid] = code
            join_room('retro:' + code)
            if retained_lockstep(room):
                for values in room['hashes'].values():
                    if old in values:
                        values[request.sid] = values.pop(old)
                if fresh_party:
                    # Future, uncommitted inputs from the lost tab may be discarded.
                    seat = room['sids'].index(request.sid)
                    for row in room['inputs'].values():
                        row[seat] = None
                    person.update(loaded=False, recovering=True)
                    checkpoints = [(f, next(iter(row.values()))) for f, row in room['hashes'].items()
                                   if row and len(set(row.values())) == 1 and f % 60 == 59 and f <= room['completed']]
                    checkpoint = max(checkpoints, default=(0, None))
                    recovery = dict(through=room['completed'], checkpointFrame=checkpoint[0], checkpointHash=checkpoint[1], next=1)
                    room['party_recoveries'].pop(old, None)
                    room['party_recoveries'][request.sid] = recovery
                    emit('room', dict(state(code, room), memberId=request.sid, resumeToken=credential['token']))
                    emit('prepare', dict(preparation(code, room), recovery={k: recovery[k] for k in ('through', 'checkpointFrame')}))
                    publish(code)
                    return
                if old in room.get('party_recoveries', {}):
                    room['party_recoveries'][request.sid] = room['party_recoveries'].pop(old)
                emit('resumed', dict(state(code, room), memberId=request.sid, resumeToken=credential['token'],
                    completed=room['completed'], frames=[packet for number, packet in history.items() if number > frame]))
                if not lockstep_paused(room):
                    emit('transport_resumed', dict(epoch=room['epoch']), code)
                    drain_inputs(code, room)
                publish(code)
                return
            if room['game']['backend'] == KART_BACKEND:
                person['loaded'] = False
                for key in ('kart_pending', 'kart_acked', 'kart_baseline', 'kart_anchor', 'kart_bootstrap', 'kart_bootstrap_requested', 'kart_pending_anchor'):
                    person.pop(key, None)
                emit('room', dict(state(code, room), memberId=request.sid, resumeToken=credential['token']))
                emit('prepare', preparation(code, room))
                publish(code)
                return
            if room['game']['backend'] == SYNC_BACKEND:
                if data.get('retained') is True:
                    person['loaded'] = True
                    emit('sync_resumed', dict(state(code,room), memberId=request.sid, resumeToken=credential['token']))
                else:
                    person['loaded'] = False
                    emit('room',dict(state(code,room),memberId=request.sid,resumeToken=credential['token']))
                    emit('prepare',preparation(code,room))
                publish(code)
                return
            relay = room['authority_relay']
            if data.get('retained') is True:
                person['loaded'] = True
                emit('resumed', dict(state(code,room), memberId=request.sid, received=relay.received,
                                     resumeToken=credential['token'], baseline=relay.bootstrap()))
            else:
                person['loaded'] = False
                emit('room',dict(state(code,room),memberId=request.sid,resumeToken=credential['token']))
                person['resuming'] = True
                emit('prepare',dict(preparation(code,room),resumeSequence=relay.received[person['slot']] if person['slot'] is not None else 0))
            if request.sid == room['sids'][0]:
                for queue in relay.pending:
                    for packet in queue:
                        socketio.emit('fps_command',dict(epoch=room['epoch'],**packet),namespace=NAMESPACE,to=request.sid)
                emit('transport_resumed',dict(epoch=room['epoch'],received=relay.received,baseline=relay.bootstrap(),members=state(code,room)['members']),code)
            publish(code)

    @socketio.on('disconnect', namespace=NAMESPACE)
    def disconnect(reason=None):
        with lock:
            code = membership.get(request.sid)
            room = rooms.get(code)
            if room:
                record_diagnostics('disconnected',code,room,request.sid)
            if room and room['phase'] == 'running' and (room['game']['backend'] in (AUTHORITY_BACKEND, SYNC_BACKEND, KART_BACKEND) or retained_lockstep(room)):
                detach(code, room, request.sid)
            else:
                remove(request.sid)
