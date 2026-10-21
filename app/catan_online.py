"""Isolated game rooms. SQLite transactions serialize moves across workers.

Only this module opens catan.sqlite3; no watch-room or streaming state is touched.
Socket messages are invalidations only. Private snapshots use authenticated HTTP.
"""
import hmac
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request, session
from flask_login import current_user
from . import catan_rules as rules
from . import catan_cities_knights as cities_knights
from .catan_maps import EXTENDED

class ClosedRoom(Exception):
    pass


bp = Blueprint('catan_online', __name__, url_prefix='/api/catan')


def db_path():
    return current_app.config.get('CATAN_DATABASE', str(Path(current_app.instance_path)/'catan.sqlite3'))


@contextmanager
def database(write=False):
    path=db_path(); Path(path).parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(path,timeout=5)
    db.row_factory=sqlite3.Row
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE IF NOT EXISTS catan_rooms (id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated REAL NOT NULL, data TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS catan_commands (user_id TEXT NOT NULL, command_id TEXT NOT NULL, room_id TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(user_id, command_id))')
        db.execute('CREATE INDEX IF NOT EXISTS catan_command_time ON catan_commands(user_id, created)')
        db.execute('CREATE TABLE IF NOT EXISTS catan_results (match_id TEXT NOT NULL, user_id TEXT NOT NULL, won INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(match_id,user_id))')
        if write: db.execute('BEGIN IMMEDIATE')
        yield db
        if write: db.commit()
    except Exception:
        db.rollback(); raise
    finally: db.close()


def uid(): return str(current_user.get_id())


def load(db,room_id):
    row=db.execute('SELECT * FROM catan_rooms WHERE id=?',(room_id,)).fetchone()
    if row is None: raise rules.Invalid('Room not found.')
    room=json.loads(row['data']); room['version']=row['version']
    if room['status']=='closed': raise ClosedRoom()
    return room


def save(db,room):
    if not room.get('testOwner') and room.get('game'):
        match_id = room.setdefault('matchId', secrets.token_hex(16))
        for player in room.get('participants', []):
            winner = room['game'].get('winner')
            won = int(winner is not None and winner == player['seat'])
            db.execute('INSERT INTO catan_results VALUES (?,?,?) ON CONFLICT(match_id,user_id) DO UPDATE SET won=MAX(won,excluded.won)', (match_id,player['id'],won))
    room['version']+=1; room['updated']=time.time()
    db.execute('INSERT INTO catan_rooms VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, updated=excluded.updated, data=excluded.data',
               (room['id'],room['version'],room['updated'],json.dumps(room,separators=(',',':'))))


def expire_rooms(db):
    now=time.time()
    for row in db.execute("SELECT data FROM catan_rooms").fetchall():
        room=json.loads(row['data'])
        if room['status']=='closed': continue
        humans=[m for m in room['members'] if not m.get('testPlayer')]
        last_seen=max((m['seen'] for m in humans),default=room.get('emptySince',room['updated']))
        if now-last_seen>=60:
            room['status']='closed'
            save(db,room)


def controlled_seat(room):
    if room.get('testOwner')==uid(): return room.get('testSeat',0)
    m=member(room)
    return m['seat'] if m else None


def member(room): return next((m for m in room['members'] if m['id']==uid()),None)


def snapshot(room):
    m=member(room)
    rules.require(m is not None,'Join this room first.')
    result={k:room[k] for k in ('id','name','host','version','status','public','chat')}
    from .models import User
    profiles={u.id:u for u in User.query.filter(User.id.in_([p['id'] for p in room['members']])).all()} if 'sqlalchemy' in current_app.extensions else {}
    result['mode']=room.get('mode','base')
    result['map']=room.get('map','base')
    result['geometry']=(dict(EXTENDED, ports=room.get('previewPorts', EXTENDED['ports']))
                        if result['map']=='base-56' else None)
    result['tradeVersion']=2
    result['gameRevision']=room.get('gameRevision',0)
    result['preview']=room.get('preview')
    result['previewPorts']=room.get('previewPorts')
    result['members']=[dict(id=p['id'],name=profiles[p['id']].username if p['id'] in profiles else p['name'],avatar=profiles[p['id']].avatar_url if p['id'] in profiles else '/static/img/avatar-default.svg',seat=p['seat'],color=p.get('color',p['seat']),ready=p['ready'],online=time.time()-p['seen']<45) for p in room['members']]
    result['testMode']=room.get('testOwner')==uid()
    result['me']=uid(); result['seat']=controlled_seat(room)
    if room['game']:
        engine=cities_knights if room.get('mode')=='cities-knights' else rules
        result['game']=engine.view(room['game'],result['seat'])
    else:
        result['game']=None
    result['canClaimHost']=not any(p['id']==room['host'] and time.time()-p['seen']<120 for p in room['members'])
    return result


def announce(room):
    sio=current_app.extensions.get('socketio')
    if sio:
        sio.emit('changed',dict(id=room['id'],version=room['version']),to='catan:'+room['id'],namespace='/catan')


@bp.before_request
def protect():
    if not current_user.is_authenticated: return jsonify(error='Sign in to play.'),401
    if request.method=='POST':
        token=session.get('catan_csrf')
        if not token or not hmac.compare_digest(token,request.headers.get('X-Catan-CSRF','')):
            return jsonify(error='Refresh the game page before continuing.'),403
        if request.content_length and request.content_length>12000: return jsonify(error='Request too large.'),413
    # Commit expiration before processing a heartbeat or command so stale rooms cannot revive.
    with database(True) as db: expire_rooms(db)


@bp.errorhandler(ClosedRoom)
def closed(error): return jsonify(error='This room closed after everyone was away for one minute.',closed=True),410


@bp.errorhandler(rules.Invalid)
def invalid(error): return jsonify(error=str(error)),400


@bp.errorhandler(sqlite3.OperationalError)
def busy(error):
    current_app.logger.warning('CATAN database operation failed: %s',error)
    return jsonify(error='The game is busy. Please retry.'),503


@bp.get('/lobby')
def lobby():
    session.setdefault('catan_csrf',secrets.token_urlsafe(32))
    rooms=[]
    with database() as db:
        for row in db.execute('SELECT data FROM catan_rooms WHERE updated>? ORDER BY updated DESC LIMIT 200',(time.time()-86400*7,)):
            r=json.loads(row['data']); mine=any(m['id']==uid() for m in r['members'])
            if r['status']!='closed' and (mine or (r['public'] and r['status'] in ('lobby','playing'))):
                rooms.append(room_summary(r))
    return jsonify(csrf=session['catan_csrf'],rooms=rooms,user=uid(),testRooms=True)


def room_summary(room):
    from .models import User
    profiles={u.id:u for u in User.query.filter(User.id.in_([p['id'] for p in room['members']])).all()} if 'sqlalchemy' in current_app.extensions else {}
    people=[dict(name=profiles[m['id']].username if m['id'] in profiles else m['name'],avatar=profiles[m['id']].avatar_url if m['id'] in profiles else '/static/img/avatar-default.svg',seat=m['seat'],color=m.get('color',m['seat']),ready=m['ready'],online=time.time()-m['seen']<45) for m in room['members']]
    return dict(id=room['id'],name=room['name'],mode=room.get('mode','base'),map=room.get('map','base'),status=room['status'],seats=sum(m['seat'] is not None for m in people),
                spectators=sum(m['seat'] is None for m in people),members=people,mine=member(room) is not None,
                host=next((m['name'] for m in room['members'] if m['id']==room['host']),'No host'))


@bp.get('/rooms/<room_id>/info')
def room_info(room_id):
    # Possession of an unlisted room's invite code permits viewing its roster,
    # but never hands, deck order or the private game snapshot.
    with database() as db:
        return jsonify(room_summary(load(db,room_id)))


@bp.post('/rooms')
def create_room():
    data=request.get_json(silent=True) or {}
    rules.require(isinstance(data,dict),'Invalid room settings.')
    mode=data.get('mode','base')
    rules.require(mode=='base' or mode=='cities-knights','Choose a valid game mode.')
    map_id=data.get('map','base')
    rules.require(map_id in ('base','base-56'), 'Choose a valid map.')
    name=str(data.get('name','New game')).strip()[:60] or 'New game'
    with database(True) as db:
        active=0
        for row in db.execute('SELECT data FROM catan_rooms WHERE updated>?',(time.time()-86400,)):
            r=json.loads(row['data'])
            if r['host']==uid() and r['status'] not in ('finished','closed'): active+=1
        rules.require(active<5,'You already host five active rooms.')
        preview_game=rules.create(['Red','Blue','Orange','Green','Purple'] if map_id=='base-56' else ['Red','Blue','Orange','Green'],
                                  map_id=map_id)
        room=dict(id=secrets.token_urlsafe(12),name=name,mode=mode,map=map_id,host=uid(),version=0,gameRevision=0,status='lobby',public=data.get('public') is True,
                  members=[dict(id=uid(),name=current_user.username,seat=0,ready=False,seen=time.time())],game=None,chat=[],
                  preview=preview_game['tiles'],previewPorts=preview_game['ports'])
        if data.get('testMode') is True:
            room.update(testOwner=uid(),testSeat=0,public=False)
            room['members'][0]['ready']=True
            labels=['Red','Blue','Orange','Green','Purple','White']
            room['members'] += [dict(id='test:'+room['id']+':'+str(i),name='Test '+labels[i],seat=i,ready=True,seen=time.time(),testPlayer=True)
                                for i in range(1,5 if map_id=='base-56' else 3)]
        save(db,room)
        # Retain closed records briefly for a clear expired-room response.
        for row in db.execute('SELECT id,data FROM catan_rooms WHERE updated<?',(time.time()-86400*7,)).fetchall():
            if json.loads(row['data'])['status'] in ('lobby','finished','closed'):
                db.execute('DELETE FROM catan_commands WHERE room_id=?',(row['id'],)); db.execute('DELETE FROM catan_rooms WHERE id=?',(row['id'],))
    return jsonify(snapshot(room)),201


@bp.get('/rooms/<room_id>')
def get_room(room_id):
    with database() as db:
        room=load(db,room_id); rules.require(member(room) is not None,'Join this room first.')
    # Heartbeats are throttled to avoid writes for every state check.
    if time.time()-member(room)['seen']>15:
        with database(True) as db:
            room=load(db,room_id); m=member(room); rules.require(m is not None,'You left this room.')
            m['seen']=time.time()
            db.execute('UPDATE catan_rooms SET data=? WHERE id=?',(json.dumps(room),room_id))
    if request.args.get('version')==str(room['version']): return '',204
    return jsonify(snapshot(room))


@bp.post('/rooms/<room_id>/actions')
def room_action(room_id):
    data=request.get_json(silent=True)
    rules.require(isinstance(data,dict),'Invalid command.')
    command=data.get('command'); rules.require(isinstance(command,str) and 8<=len(command)<=80,'Missing command identifier.')
    kind=data.get('type'); rules.require(isinstance(kind,str),'Missing action.')
    with database(True) as db:
        room=load(db,room_id); m=member(room)
        duplicate=db.execute('SELECT room_id FROM catan_commands WHERE user_id=? AND command_id=?',(uid(),command)).fetchone()
        if duplicate:
            rules.require(duplicate['room_id']==room_id,'Command belongs to another room.')
            return jsonify(snapshot(room)) if m else jsonify(left=True)
        recent=db.execute('SELECT count(*) FROM catan_commands WHERE user_id=? AND created>?',(uid(),time.time()-10)).fetchone()[0]
        rules.require(recent<40,'Too many actions. Wait a few seconds.')
        if room.get('testOwner'):
            rules.require(room['testOwner']==uid(),'This private test room is controlled by its creator.')
        if kind=='join':
            if m is None:
                rules.require(len(room['members'])<32,'Room spectator limit reached.')
                occupied={p['seat'] for p in room['members']}; capacity=6 if room.get('map')=='base-56' else 4
                seat=next((i for i in range(capacity) if i not in occupied),None)
                if data.get('spectator') is True: seat=None
                else: rules.require(room['status']=='lobby' and seat is not None,'No player seat is available. Join as a spectator.')
                m=dict(id=uid(),name=current_user.username,seat=seat,ready=False,seen=time.time()); room['members'].append(m)
        else:
            rules.require(m is not None,'Join this room first.')
            # Independent lobby/chat updates may arrive concurrently. Their own
            # predicates are rechecked under this transaction instead of rejecting
            # a ready click merely because another player just readied up.
            game_actions={'build','roll','robber','steal','bank-trade','offer','accept-trade','reject-trade','counter-trade','confirm-trade','embargo','cancel-trade','buy-development','play-development','end','special-build-flag',
                          'defender-reward','discard-progress','play-progress','progress-forced-discard','wedding-gift','spy-take','merchant-take','deserter-pick','deserter-place','harbor-offer','harbor-response',
                          'barbarian-loss','aqueduct','build-wall','improve-city','build-knight','upgrade-knight','activate-knight','move-knight','chase-robber','relocate-knight','tradehouse-exchange'}
            stale=(data.get('gameRevision')!=room.get('gameRevision',0)) if kind in game_actions | {'return-lobby','change-game'} and 'gameRevision' in data else data.get('version')!=room['version']
            if kind not in ('ready','chat','seat','claim-host','discard','accept-trade','reject-trade','counter-trade','embargo') and stale:
                return jsonify(error='The board changed. Your view has been refreshed.',room=snapshot(room)),409
            if kind=='test-seat':
                seat=data.get('seat')
                limit=5 if room.get('map')=='base-56' else 3
                rules.require(room.get('testOwner')==uid() and type(seat) is int and 0<=seat<limit,'Invalid test seat.')
                room['testSeat']=seat
            elif kind=='ready':
                rules.require(room['status']=='lobby' and m['seat'] is not None,'Only seated players can ready up.')
                m['ready']=not m['ready']
            elif kind=='reshuffle-map':
                rules.require(room['host']==uid() and room['status']=='lobby','Only the host can reshuffle before starting.')
                preview=rules.create(['Red','Blue','Orange','Green','Purple'] if room.get('map')=='base-56'
                                     else ['Red','Blue','Orange','Green'],map_id=room.get('map','base'))
                room['preview']=preview['tiles']; room['previewPorts']=preview['ports']
            elif kind=='change-game':
                rules.require(room['host']==uid() and room['status']=='lobby','Only the host can choose the next game in the lobby.')
                mode,map_id=data.get('mode'),data.get('map')
                rules.require(mode in ('base','cities-knights') and map_id in ('base','base-56'),'Choose a valid game and map.')
                rules.require(not room.get('testOwner') or map_id==room.get('map','base'),'Test rooms keep their original map size.')
                room['mode']=mode; room['map']=map_id
                capacity=6 if map_id=='base-56' else 4
                for p in room['members']:
                    if p['seat'] is not None and p['seat']>=capacity: p['seat']=None
                    p['color']=p['seat']; p['ready']=bool(room.get('testOwner'))
                preview=rules.create(['Red','Blue','Orange','Green','Purple'] if map_id=='base-56' else ['Red','Blue','Orange','Green'],map_id=map_id)
                room['preview']=preview['tiles']; room['previewPorts']=preview['ports']
                room['gameRevision']=room.get('gameRevision',0)+1
            elif kind=='seat':
                rules.require(not room.get('testOwner'),'Test rooms have three fixed player seats.')
                seat=data.get('seat')
                capacity=6 if room.get('map')=='base-56' else 4
                rules.require(room['status']=='lobby' and (seat is None or type(seat) is int and 0<=seat<capacity),'Invalid seat.')
                rules.require(seat is None or not any(p['seat']==seat and p['id']!=uid() for p in room['members']),'That seat is taken.')
                m['seat']=seat; m['color']=seat; m['ready']=False
            elif kind=='start':
                seated=sorted((p for p in room['members'] if p['seat'] is not None),key=lambda p:p['seat'])
                rules.require(room['host']==uid() and room['status']=='lobby','Only the host can start.')
                minimum,maximum=(3,6) if room.get('map')=='base-56' else (3,4)
                rules.require(minimum<=len(seated)<=maximum and all(p['ready'] for p in seated),
                              'At least three players must be ready.')
                chosen_colors=[p['seat'] for p in seated]
                for i,p in enumerate(seated): p['color']=p['seat']; p['seat']=i
                engine=cities_knights if room.get('mode')=='cities-knights' else rules
                room['game']=engine.create([p['name'] for p in seated],map_id=room.get('map','base'))
                room['game']['startSeat']=secrets.randbelow(len(seated))
                room['game']['current']=room['game']['startSeat']
                room['matchId']=secrets.token_hex(16)
                room['participants']=[dict(id=p['id'],seat=p['seat']) for p in seated if not p.get('testPlayer')]
                room['status']='playing'
                if room.get('preview'):
                    room['game']['tiles']=room['preview']
                    room['game']['robber']=next(t['id'] for t in room['preview'] if t['type']=='desert')
                if room.get('previewPorts'):
                    room['game']['ports']=room['previewPorts']
                room['gameRevision']=room.get('gameRevision',0)+1
                for p,color in zip(room['game']['players'],chosen_colors): p['color']=color
            elif kind=='chat':
                message=data.get('message'); rules.require(isinstance(message,str) and message.strip(),'Enter a message.')
                room['chat']=(room['chat']+[dict(id=uid(),name=current_user.username,avatar=getattr(current_user,'avatar_url','/static/img/avatar-default.svg'),text=message.strip()[:500])])[-60:]
            elif kind=='claim-host':
                rules.require(not any(p['id']==room['host'] and time.time()-p['seen']<120 for p in room['members']),'The host is still connected.')
                room['host']=uid()
            elif kind=='leave':
                # A seated resignation ends the match rather than silently taking over their hand.
                if room['status']=='playing' and m['seat'] is not None:
                    room['status']='finished'; room['game']['phase']='finished'; room['game']['log'].append(m['name']+' resigned. Match ended; a rematch is available.')
                    room['gameRevision']=room.get('gameRevision',0)+1
                room['members'].remove(m)
                if room['host']==uid(): room['host']=room['members'][0]['id'] if room['members'] else None
                if room.get('testOwner')==uid(): room['members']=[]
                if not room['members']: room['status']='finished'; room['emptySince']=time.time()
            elif kind=='end-abandoned':
                rules.require(room['host']==uid() and room['status']=='playing','Only the host can close an abandoned match.')
                rules.require(any(p['seat'] is not None and time.time()-p['seen']>120 for p in room['members']),'Allow disconnected players two minutes to return.')
                room['status']='finished'; room['game']['phase']='finished'; room['game']['log'].append('Host closed the match after a player disconnected.')
                room['gameRevision']=room.get('gameRevision',0)+1
            elif kind in ('rematch','return-lobby'):
                rules.require(room['host']==uid() and room['status'] in (('finished',) if kind=='rematch' else ('playing','finished')),'Only the host can return the game to the lobby.')
                room['status']='lobby'; room['game']=None
                room['gameRevision']=room.get('gameRevision',0)+1
                room.pop('matchId',None); room.pop('participants',None)
                for p in room['members']:
                    p['ready']=bool(room.get('testOwner'))
                    if p['seat'] is not None: p['seat']=p.get('color',p['seat'])
            else:
                rules.require(room['status']=='playing' and m['seat'] is not None,'Only seated players can act in a running game.')
                engine=cities_knights if room.get('mode')=='cities-knights' else rules
                engine.action(room['game'],controlled_seat(room),data)
                room['gameRevision']=room.get('gameRevision',0)+1
                if room['game']['phase']=='finished': room['status']='finished'
        if m in room['members']: m['seen']=time.time()
        save(db,room)
        db.execute('INSERT INTO catan_commands VALUES (?,?,?,?)',(uid(),command,room_id,time.time()))
    announce(room)
    return jsonify(left=True) if kind=='leave' else jsonify(snapshot(room))


def register(app,socketio):
    app.register_blueprint(bp)
    # Dedicated namespace: these listeners never join or emit to watch/live rooms.
    from flask_socketio import join_room
    @socketio.on('connect',namespace='/catan')
    def connect(auth=None):
        if not current_user.is_authenticated: return False
        origin=request.headers.get('Origin')
        if origin and origin.rstrip('/')!=request.host_url.rstrip('/'): return False

    @socketio.on('watch',namespace='/catan')
    def watch(data):
        if not current_user.is_authenticated or not isinstance(data,dict): return
        room_id=data.get('id')
        if not isinstance(room_id,str) or len(room_id)>40: return
        try:
            with database() as db:
                room=load(db,room_id)
                if member(room): join_room('catan:'+room_id)
        except (rules.Invalid,ClosedRoom): pass
