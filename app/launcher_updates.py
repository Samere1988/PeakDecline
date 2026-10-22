"""Private installed-client updates, separate from browser session authentication."""
import hashlib
import hmac
import json
from pathlib import Path
import re

from flask import Blueprint, abort, current_app, request, send_file

updates_bp = Blueprint('launcher_updates', __name__, url_prefix='/launcher-updates')


def update_root():
    return Path(current_app.instance_path) / 'launcher-updates'


@updates_bp.before_request
def authenticate():
    supplied = request.headers.get('Authorization', '')
    if not supplied.startswith('Bearer ') or len(supplied) > 256:
        abort(404)
    try:
        expected = (update_root() / 'credential.sha256').read_text().strip()
    except OSError:
        abort(404)
    actual = hashlib.sha256(supplied[7:].encode()).hexdigest()
    if not re.fullmatch('[a-f0-9]{64}', expected) or not hmac.compare_digest(actual, expected):
        abort(404)


@updates_bp.after_request
def privacy(response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Accel-Buffering'] = 'no'
    response.vary.add('Authorization')
    return response


def regular(path):
    root = update_root().resolve()
    if not path.resolve().is_relative_to(root):
        abort(404)
    if any(parent.is_symlink() for parent in (path, *path.parents) if parent != root.parent):
        abort(404)
    if not path.is_file():
        abort(404)
    return path


@updates_bp.get('/latest')
def latest():
    path = regular(update_root() / 'latest.json')
    if path.stat().st_size > 8 * 1024 * 1024:
        abort(404)
    return send_file(path, mimetype='application/json', conditional=True, max_age=0)


@updates_bp.get('/objects/<digest>')
def object_download(digest):
    if not re.fullmatch('[a-f0-9]{64}', digest):
        abort(404)
    path = regular(update_root() / 'objects' / digest)
    return send_file(path, mimetype='application/octet-stream', conditional=True,
                     etag=digest, max_age=0)


def register(app):
    app.register_blueprint(updates_bp)
