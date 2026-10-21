"""Shared, signed PeakDecline sessions and expiring account-reset tokens."""
import hashlib
import hmac
import json
from pathlib import Path
from flask import current_app, session
from flask_login import current_user, logout_user
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired


def password_version(user):
    return hashlib.sha256((user.password_hash or "").encode()).hexdigest()


def configure(app):
    config = json.loads((Path(app.instance_path) / "session-security.json").read_text())
    if len(config["secret_key"]) < 32:
        raise ValueError("A private production session key is required")
    app.config.update(
        SECRET_KEY=config["secret_key"],
        MONITORING_OWNER_ID=config["monitoring_owner_id"],
        SESSION_COOKIE_NAME="__Secure-peakdecline_session",
        SESSION_COOKIE_DOMAIN="peakdecline.com",
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
    )

    @app.before_request
    def validate_password_version():
        if current_user.is_authenticated and (
            not current_user.is_active or
            not hmac.compare_digest(session.get("password_version", ""), password_version(current_user))
        ):
            logout_user()
            session.pop("password_version", None)


def reset_token(user):
    signer = URLSafeTimedSerializer(current_app.secret_key, salt="password-reset-v1")
    return signer.dumps({"id": str(user.id), "version": password_version(user)})


def reset_user(token):
    from .models import User, db
    try:
        data = URLSafeTimedSerializer(current_app.secret_key, salt="password-reset-v1").loads(token, max_age=1800)
        if not isinstance(data, dict):
            return None
        user = db.session.get(User, data.get("id"))
        if user and user.is_active and hmac.compare_digest(data.get("version", ""), password_version(user)):
            return user
    except (BadSignature, SignatureExpired, TypeError, ValueError):
        pass
    return None
