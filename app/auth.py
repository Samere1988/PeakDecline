from flask import Blueprint, render_template, redirect, url_for, flash, request
from flask_login import login_user, logout_user, login_required, current_user
from flask_mail import Message
from .models import User, db
from . import mail

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    print(f"DEBUG: Request Method is {request.method}")
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        print(f"DEBUG: Attempting login for email: {email}")

        # Query the database using the email column
        user = User.query.filter_by(email=email).first()
        print(f"DEBUG: User object found: {user}")

        if user and user.check_password(password):
            print("DEBUG: Password check passed!")
            print(f"DEBUG: Password match for {user.email}!")
            # Auto-upgrade hash logic remains the same
            if not user.password_hash or not user.password_hash.startswith('scrypt'):
                user.set_password(password)
                db.session.commit()

            login_user(user)
            print(f"DEBUG: User logged in: {current_user.is_authenticated}")
            next_page = request.args.get('next')
            return redirect(url_for('main.index'))

        flash('Invalid email or password', 'error')

    return render_template('security/login.html')


def send_reset_email(user):
    """Sends a real email using your Gmail configuration."""
    msg = Message('Password Reset Request - PeakDecline',
                  sender='peakdecline@gmail.com',
                  recipients=[user.email])

    # This generates the absolute URL the user clicks in their email
    # It points to the reset_token route we created
    link = url_for('auth.reset_token', email=user.email, _external=True)

    msg.body = f'''To reset your password, visit the following link:
{link}

If you did not make this request, please ignore this email and no changes will be made.
'''
    mail.send(msg)

@auth_bp.route('/reset_password', methods=['GET', 'POST'])
def reset_password():
    if request.method == 'POST':
        email = request.form.get('email')
        user = User.query.filter_by(email=email).first()
        if user:
            send_reset_email(user)
            flash('An email has been sent with instructions to reset your password.', 'info')
            # Instead of redirecting to the reset page, we go back to login
            # forcing the user to actually go to their email inbox.
            return redirect(url_for('auth.login'))
        else:
            flash('No account found with that email address.', 'error')
    return render_template('security/reset_request.html')


@auth_bp.route('/reset_password/<email>', methods=['GET', 'POST'])
def reset_token(email):
    # This page is ONLY reached when the user clicks the link in their email
    user = User.query.filter_by(email=email).first_or_404()

    if request.method == 'POST':
        password = request.form.get('password')
        confirm_password = request.form.get('confirm_password')

        if password != confirm_password:
            flash('Passwords must match.', 'error')
            return render_template('security/reset_password.html', email=email)

        user.set_password(password)
        db.session.commit()
        flash('Your password has been updated! You can now log in.', 'success')
        return redirect(url_for('auth.login'))

    return render_template('security/reset_password.html', email=email)


@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')

        if User.query.filter_by(username=username).first():
            flash('Username already exists', 'error')
        else:
            new_user = User(username=username, email=email)
            new_user.set_password(password)
            db.session.add(new_user)
            db.session.commit()
            flash('Registration successful!', 'success')
            return redirect(url_for('auth.login'))

    # Updated path to look in templates/security/
    return render_template('security/register.html')


@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))