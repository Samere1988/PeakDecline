"""Account-scoped save snapshots with transactional compare-and-swap updates."""
import base64
import hashlib
from contextlib import closing
import json
import re
import secrets
import sqlite3
from pathlib import Path
from flask import abort, current_app, jsonify, request, session
from flask_login import current_user, login_required

LIMIT = 16 * 1024 * 1024


def register_save_routes(bp):
    @bp.route('/games/saves/<game_id>', methods=['GET', 'PUT'])
    @bp.route('/games/retro/saves/<game_id>', methods=['GET', 'PUT'])
    @login_required
    def retro_save(game_id):
        patterns = {'oot': r'(global|file[1-3])\.sav', 'devilutionx': r'(single|multi)_[0-9]+\.sv', 'perfectdark': r'eeprom\.bin', 'sm64': r'sm64_save_file\.bin', 'zelda3': r'(sram\.dat|save[0-9]+\.sav)', 'sonic1': r'(SData|SGame|UData)\.bin', 'sonic2': r'(SData|SGame|UData)\.bin', 'driver2': r'(config|progress)\.dat'}
        patterns.update({'cmr2': r'(pps/[A-Za-z0-9 _.-]{1,48}\.pps|Configuration/(GameInfo|Controller)\.rcf)', 'gta5': r'(/userdata/Documents/[A-Za-z0-9 _./()-]{1,240}|timestamps.json)',
                         'derby': r'progress.json', 'mk64': r'eeprom.bin',
                         'fzerox': r'sram.bin', 'smash64': r'ssb64_save.bin',
                         'marioparty': r'marioparty.eep', 'marioparty2': r'marioparty.eep'})
        if re.fullmatch(r'emulator-[0-9a-f]{64}', game_id):
            roms = Path(current_app.static_folder) / 'roms'
            known = any('emulator-' + hashlib.sha256(p.relative_to(Path(current_app.static_folder)).as_posix().encode()).hexdigest() == game_id
                        for p in roms.rglob('*') if p.is_file())
            if known:
                patterns[game_id] = r'(battery.sav|state.bin)'
        if game_id not in patterns:
            abort(404)
        account = str(current_user.get_id())
        if session.get('retro_save_account') != account:
            session['retro_save_account'] = account
            session['retro_save_csrf'] = secrets.token_urlsafe(32)
        token = session['retro_save_csrf']
        if request.method == 'PUT':
            if not secrets.compare_digest(request.headers.get('X-CSRF-Token', ''), token):
                abort(403)
            if request.content_length is None or request.content_length > (48 * 1024 * 1024 if game_id == 'gta5' or game_id.startswith('emulator-') else LIMIT):
                abort(413)
            data = request.get_json()
            if not isinstance(data, dict) or type(data.get('revision')) is not int or not isinstance(data.get('files'), dict):
                abort(400)
            if len(data['files']) > 100:
                abort(400)
            for name, value in data['files'].items():
                if not isinstance(name, str) or '..' in name.split('/') or not re.fullmatch(patterns[game_id], name) or not isinstance(value, str):
                    abort(400)
                try:
                    raw = base64.b64decode(value, validate=True)
                    if ((game_id == 'perfectdark' and len(raw) != 2048) or
                        (game_id == 'sm64' and len(raw) != 512) or
                        (game_id == 'zelda3' and name == 'sram.dat' and len(raw) != 8192)):
                        abort(400)
                    sizes = {'mk64': 512, 'marioparty': 512, 'marioparty2': 512}
                    if game_id in sizes and len(raw) != sizes[game_id]:
                        abort(400)
                    if game_id == 'derby':
                        progress = json.loads(raw)
                        if not isinstance(progress, dict) or set(progress) != {'credits', 'races', 'wins'} or any(type(v) is not int or not 0 <= v <= 2**53 - 1 for v in progress.values()) or progress['wins'] > progress['races']:
                            abort(400)
                    if game_id == 'oot':
                        save = json.loads(raw)
                        if not isinstance(save, dict) or type(save.get('version')) is not int:
                            abort(400)
                except (ValueError, UnicodeError):
                    abort(400)
        path = Path(current_app.config.get('RETRO_SAVE_DATABASE', Path(current_app.instance_path) / 'retro-saves.sqlite3'))
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path, timeout=10)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS saves (account TEXT, game TEXT, revision INTEGER NOT NULL, files TEXT NOT NULL, PRIMARY KEY(account, game))')
            if request.method == 'PUT':
                db.execute('BEGIN IMMEDIATE')
            key = (str(current_user.get_id()), game_id)
            row = db.execute('SELECT revision, files FROM saves WHERE account=? AND game=?', key).fetchone()
            revision, files = (row[0], json.loads(row[1])) if row else (0, {})
            if request.method == 'PUT':
                if data['revision'] != revision:
                    response = jsonify(error='Save changed on another PC. Reopen the game before continuing.')
                    response.status_code = 409
                    response.headers['Cache-Control'] = 'private, no-store'
                    return response
                db.execute('CREATE TABLE IF NOT EXISTS save_history (account TEXT, game TEXT, revision INTEGER, files TEXT, PRIMARY KEY(account,game,revision))')
                if revision:
                    db.execute('INSERT OR IGNORE INTO save_history VALUES (?,?,?,?)', (*key, revision, json.dumps(files)))
                    db.execute('DELETE FROM save_history WHERE account=? AND game=? AND revision < ?', (*key, revision - 4))
                revision += 1
                files = data['files']
                db.execute('INSERT OR REPLACE INTO saves VALUES (?, ?, ?, ?)', (*key, revision, json.dumps(files)))
        response = jsonify(revision=revision, files=files, csrf=token)
        response.headers['Cache-Control'] = 'private, no-store'
        return response


def read_account_save(app, account, game):
    """Read an immutable room starting snapshot; never expose it in room listings."""
    path = Path(app.config.get('RETRO_SAVE_DATABASE', Path(app.instance_path) / 'retro-saves.sqlite3'))
    if not path.exists():
        return dict(revision=0, files={})
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='saves'").fetchone():
            return dict(revision=0, files={})
        row = db.execute('SELECT revision, files FROM saves WHERE account=? AND game=?', (str(account), game)).fetchone()
    return dict(revision=row[0], files=json.loads(row[1])) if row else dict(revision=0, files={})


def commit_authority_save(app, account, game, revision, files):
    """Compare-and-swap a server simulation save using the room's original owner."""
    path = Path(app.config.get('RETRO_SAVE_DATABASE', Path(app.instance_path) / 'retro-saves.sqlite3'))
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS saves (account TEXT, game TEXT, revision INTEGER NOT NULL, files TEXT NOT NULL, PRIMARY KEY(account, game))')
        db.execute('BEGIN IMMEDIATE')
        key = (str(account), game)
        row = db.execute('SELECT revision, files FROM saves WHERE account=? AND game=?', key).fetchone()
        if (row[0] if row else 0) != revision:
            return None
        db.execute('CREATE TABLE IF NOT EXISTS save_history (account TEXT, game TEXT, revision INTEGER, files TEXT, PRIMARY KEY(account,game,revision))')
        if row:
            db.execute('INSERT OR IGNORE INTO save_history VALUES (?,?,?,?)', (*key, *row))
            db.execute('DELETE FROM save_history WHERE account=? AND game=? AND revision < ?', (*key, revision-4))
        db.execute('INSERT OR REPLACE INTO saves VALUES (?,?,?,?)', (*key, revision+1, json.dumps(files)))
        return revision+1
