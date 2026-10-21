"""Isolated real Socket.IO handlers; JSON-lines interface for the JS stress runner.

Never calls create_app(): all database bindings are in memory and no Plex is used.
"""
import contextlib
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
with contextlib.redirect_stdout(sys.stderr):
    from flask import Flask
    from app import db, login_manager, socketio
    from app.models import Room, User
    from app import routes

app = Flask(__name__)
app.config.update(TESTING=True, SECRET_KEY="isolated-test-only",
                  SQLALCHEMY_DATABASE_URI="sqlite://",
                  SQLALCHEMY_BINDS={"channels_db": "sqlite://"})
db.init_app(app)
login_manager.init_app(app)
socketio.init_app(app, async_mode="threading")
app.register_blueprint(routes.main_bp)
clients = {}
tasks = []
clock = [1700000000.0]


def reset():
    for client in clients.values():
        if client.is_connected():
            client.disconnect()
    clients.clear()
    tasks.clear()
    for name in ("room_states", "connected_sids", "online_last_seen", "room_occupancy", "sid_to_room", "live_tv_occupancy"):
        getattr(routes, name).clear()
    routes.online_users.clear()
    routes.room_revisions.clear()
    with app.app_context():
        db.drop_all()
        db.create_all()
        for i in range(15):
            db.session.add(User(id=str(i), username=f"user{i}", email=f"user{i}@example.test"))
        db.session.add(Room(id=1, name="Isolated stress test", host_id="0",
                            current_media_key="fixture", current_media_title="Test fixture",
                            current_media_url="/fixture.m3u8"))
        db.session.commit()
        routes._save_room_playback_state("1", "paused", 0)


def command(data):
    clock[0] = data.get("now", clock[0])
    op = data["op"]
    if op == "reset":
        reset()
    elif op == "join":
        i = str(data["id"])
        http = app.test_client()
        with http.session_transaction() as session:
            session["_user_id"] = i
            session["_fresh"] = True
        clients[i] = socketio.test_client(app, flask_test_client=http)
        clients[i].emit("join_watch_room", {"room_id": "1"})
    elif op == "emit":
        clients[str(data["id"])].emit(data["event"], data["data"])
    elif op == "leave":
        clients.pop(str(data["id"])).disconnect()
    elif op == "tasks":
        queued, tasks[:] = tasks[:], []
        for fn, args in queued:
            fn(*args)
    elif op == "clear_memory":
        routes.room_states.clear()
    elif op == "media":
        with app.app_context():
            room = db.session.get(Room, 1)
            room.current_media_key = data['key']
            room.current_media_url = '/fixture-' + data['key'] + '.m3u8'
            routes._save_room_playback_state('1', 'paused', data['position'], new_media=True)
            routes._broadcast_playback('1', 'media_updated')
    elif op == "state":
        with app.app_context():
            room = db.session.get(Room, 1)
            return {"payload": routes._get_room_state_payload(room),
                    "host": room.host_id if room else None,
                    "users": routes._unique_room_users("1")}
    return {i: c.get_received() for i, c in clients.items() if c.is_connected()}


with patch.object(routes, "_now", lambda: clock[0]), \
     patch.object(socketio, "start_background_task", lambda fn, *args: tasks.append((fn, args))), \
     patch.object(socketio, "sleep", lambda _: None):
    for line in sys.stdin:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = command(json.loads(line))
            print(json.dumps({"result": result}), flush=True)
        except Exception as exc:
            print(json.dumps({"error": repr(exc)}), flush=True)
