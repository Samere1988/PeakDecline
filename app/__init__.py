import os
from datetime import timedelta
from dotenv import load_dotenv
from flask import Flask, session
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, current_user
from flask_mail import Mail
from flask_socketio import SocketIO

# Secrets live in the untracked project-root .env; real environment variables win.
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))

# Initialize extensions
db = SQLAlchemy()
login_manager = LoginManager()
mail = Mail()
# --- UPDATED: Swapped from 'threading' to 'gevent' for scalability ---
socketio = SocketIO(async_mode="gevent", cors_allowed_origins="*")

def create_app():
    app = Flask(__name__,
                template_folder='../templates',
                static_folder='../static')

    # Environment Configuration
    env = os.getenv('FLASK_ENV', 'production')

    try:
        os.makedirs(app.instance_path)
    except OSError:
        pass

    # Database Paths
    users_db = 'sqlite:///' + os.path.join(app.instance_path, 'users.db')
    channels_db = 'sqlite:///' + os.path.join(app.instance_path, 'channels.db')

    # 1. Main Database Configuration
    app.config['SQLALCHEMY_DATABASE_URI'] = users_db

    # 2. Secondary Database Configuration
    app.config['SQLALCHEMY_BINDS'] = {
        'channels_db': channels_db
    }

    from .session_security import configure as configure_session_security
    configure_session_security(app)
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
    app.config['SESSION_REFRESH_EACH_REQUEST'] = True
    app.config['LIVE_TV_EMPTY_GRACE_SECONDS'] = 60

    # Email Configuration
    app.config['MAIL_SERVER'] = 'smtp.gmail.com'
    app.config['MAIL_PORT'] = 587
    app.config['MAIL_USE_TLS'] = True
    app.config['MAIL_USERNAME'] = os.getenv('MAIL_USERNAME', 'peakdecline@gmail.com')
    app.config['MAIL_PASSWORD'] = os.getenv('MAIL_PASSWORD')
    app.config['MAIL_DEFAULT_SENDER'] = 'Peak Decline'

    # --- PLEX CONFIGURATION (NEW) ---
    app.config['PLEX_URL'] = os.getenv('PLEX_URL', 'http://127.0.0.1:32400')
    app.config['PLEX_TOKEN'] = os.getenv('PLEX_TOKEN')

    # Initialize extensions
    db.init_app(app)
    login_manager.init_app(app)
    mail.init_app(app)
    # --- UPDATED: Ensure gevent is passed during init_app as well ---
    socketio.init_app(app, async_mode="gevent", cors_allowed_origins="*")

    # Configure Flask-Login
    login_manager.login_view = 'auth.login'
    login_manager.login_message_category = 'info'

    @app.before_request
    def retain_login_session():
        # Also upgrade existing logins to a cookie that survives browser closure.
        if current_user.is_authenticated and not session.permanent:
            session.permanent = True

    from .routes import main_bp
    from .auth import auth_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp)

    from .monitoring import register as register_monitoring
    register_monitoring(app)

    from .launcher_downloads import register as register_launcher_downloads
    register_launcher_downloads(app)

    from .catan_online import register as register_catan
    register_catan(app, socketio)
    from .netplay import register as register_retro_netplay
    register_retro_netplay(app, socketio)

    # Add usage storage without altering the existing imported channels table.
    from .models import ChannelPlayCount
    with app.app_context():
        # Serialize this additive SQLite migration across simultaneous workers.
        with db.engine.connect() as connection:
            connection.exec_driver_sql('BEGIN IMMEDIATE')
            columns = connection.exec_driver_sql('PRAGMA table_info(user)').fetchall()
            if columns and 'avatar' not in {column[1] for column in columns}:
                connection.exec_driver_sql('ALTER TABLE user ADD COLUMN avatar VARCHAR(80)')
            connection.commit()
        ChannelPlayCount.__table__.create(db.engines['channels_db'], checkfirst=True)

    return app
