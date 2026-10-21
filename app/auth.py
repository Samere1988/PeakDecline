import uuid
from flask import Blueprint, render_template, redirect, url_for, flash, request, session
from flask_login import login_user, logout_user, login_required, current_user
from flask_mail import Message
from .models import User, db
from . import mail
from .session_security import password_version, reset_token as make_reset_token, reset_user

auth_bp = Blueprint('auth', __name__)


def normalize_email(email):
    """
    Store and compare emails in lowercase so login/reset/register are not case-sensitive.
    """
    return (email or "").strip().lower()


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():

    if request.method == 'POST':
        email = normalize_email(request.form.get('email'))
        password = request.form.get('password')


        user = User.query.filter_by(email=email).first()

        # Fallback for old users whose email may already be saved with uppercase letters.
        # Once they log in successfully, we convert their saved email to lowercase.
        if not user:
            user = User.query.filter(db.func.lower(User.email) == email).first()


        if user and user.is_active and user.check_password(password):

            # Normalize existing saved email after successful login.
            if user.email != email:
                user.email = email
                db.session.commit()

            # Auto-upgrade hash logic remains the same.
            if not user.password_hash or not user.password_hash.startswith('scrypt'):
                user.set_password(password)
                db.session.commit()

            login_user(user)
            session.permanent = True
            session["password_version"] = password_version(user)

            destination = request.form.get("next", "")
            if destination not in ("/monitoring/homepage", "/monitoring/kuma", "/launcher-preview/"):
                destination = url_for("main.index")
            return redirect(destination)

        flash('Invalid email or password', 'error')

    return render_template('security/login.html')


def send_reset_email(user):
    """Sends a real email using your Gmail configuration."""
    msg = Message(
        'Password Reset Request - PeakDecline',
        sender='peakdecline@gmail.com',
        recipients=[user.email]
    )

    link = url_for('auth.reset_token', token=make_reset_token(user), _external=True, _scheme='https')

    msg.body = f'''To reset your password, visit the following link:
{link}

If you did not make this request, please ignore this email and no changes will be made.
'''
    mail.send(msg)


@auth_bp.route('/reset_password', methods=['GET', 'POST'])
def reset_password():
    if request.method == 'POST':
        email = normalize_email(request.form.get('email'))

        user = User.query.filter_by(email=email).first()

        # Fallback for old uppercase/mixed-case saved emails.
        if not user:
            user = User.query.filter(db.func.lower(User.email) == email).first()

        if user:
            # Normalize stored email before sending reset email.
            if user.email != email:
                user.email = email
                db.session.commit()

            send_reset_email(user)
            flash('An email has been sent with instructions to reset your password.', 'info')
            return redirect(url_for('auth.login'))

        flash('No account found with that email address.', 'error')

    return render_template('security/reset_request.html')


@auth_bp.route('/reset_password/<token>', methods=['GET', 'POST'])
def reset_token(token):
    from flask import abort
    user = reset_user(token)
    if user is None:
        abort(400, description="This reset link is invalid or expired. Request a new one.")
    normalized_email = normalize_email(user.email)

    if request.method == 'POST':
        password = request.form.get('password')
        confirm_password = request.form.get('confirm_password')

        if password != confirm_password:
            flash('Passwords must match.', 'error')
            return render_template('security/reset_password.html', email=normalized_email)

        if not 8 <= len(password or "") <= 256:
            flash('Use a password between 8 and 256 characters.', 'error')
            return render_template('security/reset_password.html', email=normalized_email)

        # Normalize stored email while updating password.
        if user.email != normalized_email:
            user.email = normalized_email

        user.set_password(password)
        db.session.commit()

        flash('Your password has been updated! You can now log in.', 'success')
        return redirect(url_for('auth.login'))

    return render_template('security/reset_password.html', email=normalized_email)


@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = (request.form.get('username') or "").strip()
        email = normalize_email(request.form.get('email'))
        password = request.form.get('password')

        if User.query.filter_by(username=username).first():
            flash('Username already exists', 'error')
        elif User.query.filter_by(email=email).first() or User.query.filter(db.func.lower(User.email) == email).first():
            flash('Email already exists', 'error')
        else:
            new_user = User(
                id=str(uuid.uuid4()),
                username=username,
                email=email
            )

            new_user.set_password(password)
            db.session.add(new_user)
            db.session.commit()

            flash('Registration successful!', 'success')
            return redirect(url_for('auth.login'))

    return render_template('security/register.html')


@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))


@auth_bp.route('/profile', methods=['GET', 'POST'])
@login_required
def profile():
    import hmac
    import secrets
    from pathlib import Path
    from io import BytesIO
    from PIL import Image, ImageOps, UnidentifiedImageError
    from flask import current_app
    from sqlalchemy.exc import IntegrityError
    session.setdefault('profile_csrf', secrets.token_urlsafe(32))
    if request.method == 'POST':
        if request.content_length and request.content_length > 6 * 1024 * 1024:
            return 'Choose a picture smaller than 5 MB.', 413
        if not hmac.compare_digest(session['profile_csrf'], request.form.get('csrf', '')):
            return 'Refresh your profile before saving.', 403
        action = request.form.get('action')
        try:
            if action == 'password':
                password = request.form.get('password', '')
                if not current_user.check_password(request.form.get('current_password', '')):
                    raise ValueError('Your current password is incorrect.')
                if len(password) < 8 or len(password) > 256:
                    raise ValueError('Use a password between 8 and 256 characters.')
                if password != request.form.get('confirm_password'):
                    raise ValueError('New passwords must match.')
                current_user.set_password(password)
            elif action == 'details':
                username = request.form.get('username', '').strip()
                if not 2 <= len(username) <= 64 or any(ord(c) < 32 for c in username):
                    raise ValueError('Use a username between 2 and 64 characters.')
                duplicate = User.query.filter(db.func.lower(User.username) == username.lower(), User.id != current_user.id).first()
                if duplicate:
                    raise ValueError('That username is already taken.')
                upload = request.files.get('picture')
                if upload and upload.filename:
                    raw = upload.read(5 * 1024 * 1024 + 1)
                    if len(raw) > 5 * 1024 * 1024:
                        raise ValueError('Choose a picture smaller than 5 MB.')
                    try:
                        with Image.open(BytesIO(raw)) as picture:
                            if picture.format not in ('JPEG', 'PNG', 'GIF', 'WEBP'):
                                raise ValueError('Choose a JPEG, PNG, GIF or WebP image.')
                            if picture.width * picture.height > 16000000:
                                raise ValueError('Choose an image smaller than 16 megapixels.')
                            picture = ImageOps.fit(ImageOps.exif_transpose(picture).convert('RGB'), (256, 256))
                            folder = Path(current_app.instance_path) / 'avatars'
                            folder.mkdir(exist_ok=True)
                            filename = secrets.token_hex(16) + '.jpg'
                            picture.save(folder / filename, 'JPEG', quality=88)
                            current_user.avatar = filename
                    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
                        raise ValueError('Choose a valid JPEG, PNG, GIF or WebP image.')
                if request.form.get('remove_picture'):
                    current_user.avatar = None
                current_user.username = username
            else:
                raise ValueError('Choose a valid profile action.')
            db.session.commit()
            session['password_version'] = password_version(current_user)
            return redirect(url_for('auth.profile'))
        except (ValueError, IntegrityError) as error:
            db.session.rollback()
            flash(str(error) if isinstance(error, ValueError) else 'That username is already taken.', 'error')
    from .catan_online import database
    with database() as connection:
        stats = connection.execute('SELECT COUNT(*) AS played, COALESCE(SUM(won),0) AS won FROM catan_results WHERE user_id=?', (str(current_user.id),)).fetchone()
    return render_template('profile.html', stats=stats)


@auth_bp.get('/profile/pictures/<filename>')
def avatar(filename):
    import re
    from flask import current_app, send_from_directory, abort
    from pathlib import Path
    if not re.fullmatch(r'[a-f0-9]{32}\.jpg', filename):
        abort(404)
    return send_from_directory(Path(current_app.instance_path) / 'avatars', filename, max_age=86400)
