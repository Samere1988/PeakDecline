"""Private Windows test downloads, using the existing owner account boundary."""
import json
import re
from pathlib import Path

from flask import Blueprint, abort, current_app, redirect, render_template, send_file, url_for
from flask_login import current_user

from .monitoring import is_monitoring_owner

downloads_bp = Blueprint("launcher_downloads", __name__, url_prefix="/launcher-preview")


@downloads_bp.before_request
def require_owner():
    if not current_user.is_authenticated:
        return redirect(url_for("auth.login", next="/launcher-preview/"))
    if not is_monitoring_owner():
        abort(404)


@downloads_bp.after_request
def private_response(response):
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Accel-Buffering"] = "no"
    response.vary.add("Cookie")
    return response


def release():
    root = Path(current_app.instance_path) / "launcher-downloads"
    try:
        data = json.loads((root / "release.json").read_text())
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,100}\.(?:zip|exe)", data["filename"]):
            return None
        if not re.fullmatch(r"[a-z0-9-]{1,80}", data["id"]):
            return None
        if not re.fullmatch(r"[a-f0-9]{64}", data["sha256"]):
            return None
        archive = root / data["filename"]
        if archive.is_symlink() or not archive.is_file() or archive.stat().st_size != data["bytes"]:
            return None
        if not isinstance(data["games"], list) or not data["games"]:
            return None
        data["size_label"] = f'{data["bytes"] / 1_000_000_000:.2f} GB'
        data["is_installer"] = data["filename"].endswith(".exe")
        return data, archive
    except (OSError, ValueError, KeyError, TypeError):
        current_app.logger.warning("Private launcher release is unavailable")
        return None


@downloads_bp.get("/")
def index():
    available = release()
    return render_template("launcher_downloads.html", release=available[0] if available else None)


@downloads_bp.get("/download/<release_id>")
def download(release_id):
    available = release()
    if available is None or available[0]["id"] != release_id:
        abort(404)
    metadata, archive = available
    media_type = "application/octet-stream" if metadata["is_installer"] else "application/zip"
    return send_file(archive, as_attachment=True, download_name=metadata["filename"],
                     mimetype=media_type, conditional=True, etag=metadata["sha256"], max_age=0)


def register(app):
    app.register_blueprint(downloads_bp)
