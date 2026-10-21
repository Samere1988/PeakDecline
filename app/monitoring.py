"""Authorize monitoring access using the existing PeakDecline account."""
from flask import Blueprint, abort, current_app, redirect
from flask_login import current_user, login_required

monitoring_bp = Blueprint("monitoring", __name__, url_prefix="/monitoring")


def is_monitoring_owner():
    return (current_user.is_authenticated and current_user.is_active
            and current_user.username.casefold() == "samer"
            and str(current_user.id) == current_app.config["MONITORING_OWNER_ID"])


@monitoring_bp.get("/auth")
def auth_check():
    if not current_user.is_authenticated:
        return "", 401, {"Cache-Control": "no-store"}
    if not is_monitoring_owner():
        return "", 403, {"Cache-Control": "no-store"}
    return "", 204, {"Cache-Control": "no-store"}


@monitoring_bp.get("/homepage")
@login_required
def homepage():
    if not is_monitoring_owner():
        abort(403)
    return redirect("https://dashboard.peakdecline.com/")


@monitoring_bp.get("/kuma")
@login_required
def kuma():
    if not is_monitoring_owner():
        abort(403)
    return redirect("https://status.peakdecline.com/dashboard")


def register(app):
    app.register_blueprint(monitoring_bp)
    app.context_processor(lambda: {"is_monitoring_owner": is_monitoring_owner})


# Only these fixed commands are exposed; API credentials never reach the browser.
import hmac
import secrets
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
import requests
import yaml
from flask import jsonify, request, session

_SEARCH_APPS = {
    "sonarr": (8989, "MissingEpisodeSearch"),
    "radarr": (7878, "MissingMoviesSearch"),
    "bazarr": (6767, None),
}
_SEARCH_LOCKS = {name: threading.Lock() for name in _SEARCH_APPS}
_LAST_SEARCH = {}


def _action_owner():
    if not current_user.is_authenticated:
        abort(401)
    if not is_monitoring_owner():
        abort(403)


@monitoring_bp.get("/actions/token")
def action_token():
    _action_owner()
    token = session.setdefault("monitoring_actions_csrf", secrets.token_urlsafe(32))
    return jsonify(csrf=token), 200, {"Cache-Control": "no-store"}


@monitoring_bp.post("/actions/search/<app_name>")
def search_missing(app_name):
    _action_owner()
    if app_name not in _SEARCH_APPS:
        abort(404)
    if request.headers.get("Origin") != "https://dashboard.peakdecline.com":
        abort(403)
    csrf = session.get("monitoring_actions_csrf")
    if not csrf or not hmac.compare_digest(csrf, request.headers.get("X-CSRF-Token", "")):
        abort(403)
    lock = _SEARCH_LOCKS[app_name]
    if not lock.acquire(blocking=False):
        return jsonify(error="A search request is already being submitted."), 409
    try:
        now = time.monotonic()
        if now - _LAST_SEARCH.get(app_name, float("-inf")) < 60:
            return jsonify(error="A search was just requested. Please wait a minute."), 429
        if app_name == "bazarr":
            return _search_bazarr(now)
        port, command = _SEARCH_APPS[app_name]
        key = ET.parse(Path("/home/samer/servers/arr") / app_name / "config.xml").findtext("ApiKey")
        headers = {"X-Api-Key": key}
        url = f"http://127.0.0.1:{port}/api/v3/command"
        running = requests.get(url, headers=headers, timeout=10)
        running.raise_for_status()
        for existing in running.json():
            if existing.get("name") == command and existing.get("status") in ("queued", "started"):
                return jsonify(message="A search for monitored missing items is already running.", id=existing["id"])
        payload = {"name": command}
        if app_name == "sonarr":
            payload["monitored"] = True
        # Mark before submitting: a timeout may still mean the command was accepted.
        _LAST_SEARCH[app_name] = now
        response = requests.post(url, headers=headers, json=payload, timeout=15)
        response.raise_for_status()
        data = response.json()
        return jsonify(message="Search queued for all monitored missing items.", id=data["id"]), 202
    except (requests.RequestException, OSError, ET.ParseError, ValueError, KeyError, TypeError):
        return jsonify(error="Could not confirm the search. Check the app before retrying."), 502
    finally:
        lock.release()


def _search_bazarr(now):
    tasks = {
        "wanted_search_missing_subtitles_series": "TV",
        "wanted_search_missing_subtitles_movies": "Movies",
    }
    try:
        config = yaml.safe_load(Path("/home/samer/servers/arr/bazarr/config/config.yaml").read_text())
        headers = {"X-API-KEY": config["auth"]["apikey"]}
        url = "http://127.0.0.1:6767/api/system/tasks"
        response = requests.get(url, headers=headers, timeout=5)
        response.raise_for_status()
        current = {task["job_id"]: task for task in response.json()["data"]}
        # Validate both task IDs before submitting either search.
        if any(task_id not in current for task_id in tasks):
            raise ValueError("Missing Bazarr search task")
        results = []
        queued = False
        for task_id, label in tasks.items():
            if current[task_id]["job_running"]:
                results.append(f"{label}: search already running.")
                continue
            _LAST_SEARCH["bazarr"] = now
            try:
                response = requests.post(url, headers=headers, data={"taskid": task_id}, timeout=5)
                response.raise_for_status()
                results.append(f"{label}: search queued.")
                queued = True
            except requests.RequestException:
                results.append(f"{label}: could not confirm search; check Bazarr before retrying.")
                return jsonify(error=" ".join(results)), 502
        return jsonify(message=" ".join(results)), 202 if queued else 200
    except (requests.RequestException, OSError, ValueError, KeyError, TypeError, yaml.YAMLError):
        return jsonify(error="Could not confirm the subtitle searches. Check Bazarr before retrying."), 502
