"""Authenticated hosting for the preserved PlayGTA5 browser runtime."""
import gzip
import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path

from flask import abort, current_app, make_response, render_template, request, send_file
from flask_login import current_user, login_required

PREFIX = '/games/gta5'
MAX_BATCH = 64 * 1024 * 1024


def root():
    return Path(current_app.instance_path) / 'gta5' / 'game'


def ready():
    return (root().parent / 'verified.json').is_file() and (root() / 'index.html').is_file()


def private(response):
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    response.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
    response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
    response.headers['Cache-Control'] = 'private, no-cache'
    response.headers['Vary'] = 'Cookie'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def safe_file(directory, name):
    directory = directory.resolve()
    path = (directory / name).resolve()
    if not path.is_relative_to(directory) or not path.is_file():
        abort(404)
    return path


@lru_cache(maxsize=16)
def source_text(path, mtime):
    return Path(path).read_text(encoding='utf-8')


def client_source(path):
    code = source_text(str(path), path.stat().st_mtime_ns)
    # The captured build assumes it owns the origin root. Scope every URL to
    # this game, without modifying the checksum-verified files on disk.
    code = re.sub(r'''(?<=["'])/(?:b/|data/|log(?=["'?])|shot(?=["'?])|__support/)''',
                  lambda match: PREFIX + match.group(), code)
    account = hashlib.sha256(str(current_user.get_id()).encode()).hexdigest()[:24]
    code = code.replace('gta5-userdata', 'peak-gta5-userdata-' + account)
    if path.name == 'index.html':
        code = re.sub(r'<title>.*?</title>', '<title>GTA V · PeakDecline</title>', code, count=1)
        code = code.replace('<body>', '<body><a data-gta-exit href="/games/gta5" style="position:fixed;top:12px;left:12px;z-index:10000;color:white;background:#171923;padding:8px 12px;border-radius:6px;font:14px system-ui;text-decoration:none">← Exit game</a>', 1)
    if path.name == 'index.html':
        bootstrap = ('<script src="/static/js/account_sync.js?v=1"></script>'
                     '<script id="peak-gta-save-config" data-database="peak-gta5-userdata-' + account + '" src="/static/js/gta5_saves.js?v=1"></script>')
        code = code.replace('<script type="module">', bootstrap + '<script type="module">\nawait window.peakGtaSaveReady;', 1)
    if path.name == 'io_worker.js':
        marker = "log('[io] userdata ' +"
        code = code.replace(marker, "{ const channel = new BroadcastChannel('peak-gta5-userdata-" + account + "-changed'); channel.postMessage('saved'); channel.close(); }\n\t\t" + marker, 1)
    return code


def register_routes(bp):
    @bp.route(PREFIX)
    @login_required
    def gta5():
        return private(make_response(render_template('gta5.html', available=ready())))

    @bp.route(PREFIX + '/play')
    @login_required
    def gta5_play():
        if not ready():
            abort(503, 'GTA V is being installed. Please try again later.')
        response = make_response(client_source(root() / 'index.html'))
        response.mimetype = 'text/html'
        return private(response)

    @bp.route(PREFIX + '/b/<path:name>')
    @login_required
    def gta5_build(name):
        if not ready():
            abort(503)
        path = safe_file(root() / 'b', name)
        if path.suffix == '.js':
            response = make_response(client_source(path))
            response.mimetype = 'text/javascript'
        else:
            response = send_file(path, conditional=True, mimetype='application/wasm' if path.suffix == '.wasm' else None)
        return private(response)

    @bp.route(PREFIX + '/data/<path:name>')
    @login_required
    def gta5_data(name):
        if not ready():
            abort(503)
        return private(send_file(safe_file(root() / 'data', name), conditional=True))

    @bp.route(PREFIX + '/data/batch', methods=['POST'])
    @login_required
    def gta5_batch():
        if not ready():
            abort(503)
        if request.content_length is None or request.content_length > 1024 * 1024:
            abort(413)
        try:
            runs = json.loads(request.get_data())
            if not isinstance(runs, list) or not 1 <= len(runs) <= 1000:
                raise ValueError()
            selected, total = [], 0
            for run in runs:
                if not isinstance(run, list) or len(run) != 3:
                    raise ValueError()
                name, start, end = run
                if not isinstance(name, str) or type(start) is not int or type(end) is not int or start < 0 or end < start:
                    raise ValueError()
                path = safe_file(root() / 'data', name)
                length = max(0, min(end + 1, path.stat().st_size) - start)
                total += length
                if total > MAX_BATCH:
                    abort(413)
                selected.append((path, start, length))
            chunks = []
            for path, start, length in selected:
                if not length:
                    chunks.append(b'')
                    continue
                with path.open('rb') as source:
                    source.seek(start)
                    chunks.append(source.read(length))
        except (ValueError, TypeError, OSError):
            abort(400, 'Invalid batch request')
        body = b''.join(chunks)
        compressed = request.args.get('gz') == '1'
        if compressed:
            body = gzip.compress(body, compresslevel=1)
        response = make_response(body)
        response.mimetype = 'application/octet-stream'
        response.headers['X-Run-Lengths'] = ','.join(str(len(chunk)) for chunk in chunks)
        if compressed:
            response.headers['Content-Encoding'] = 'gzip'
        return private(response)

    @bp.route(PREFIX + '/log', methods=['POST'])
    @login_required
    def gta5_log():
        # The original client can post diagnostics. Do not persist player data.
        return private(make_response('', 204))
