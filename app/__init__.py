import os
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from flask_mail import Mail
from flask_socketio import SocketIO

# Initialize extensions
db = SQLAlchemy()
login_manager = LoginManager()
mail = Mail()
socketio = SocketIO(async_mode="threading", cors_allowed_origins="*")

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

    app.config['SECRET_KEY'] = 'dev-key-replace-in-production'
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

    # Email Configuration
    app.config['MAIL_SERVER'] = 'smtp.gmail.com'
    app.config['MAIL_PORT'] = 587
    app.config['MAIL_USE_TLS'] = True
    app.config['MAIL_USERNAME'] = 'peakdecline@gmail.com'
    app.config['MAIL_PASSWORD'] = 'aspt mifz vjux izdw '
    app.config['MAIL_DEFAULT_SENDER'] = 'Peak Decline'

    # --- PLEX CONFIGURATION (NEW) ---
    app.config['PLEX_URL'] = 'http://127.0.0.1:32400'
    app.config['PLEX_TOKEN'] = 'uHmJsmLp1jo-BxJKWQGU'

    # Initialize extensions
    db.init_app(app)
    login_manager.init_app(app)
    mail.init_app(app)
    socketio.init_app(app, cors_allowed_origins="*")

    # Configure Flask-Login
    login_manager.login_view = 'auth.login'
    login_manager.login_message_category = 'info'

    from .routes import main_bp
    from .auth import auth_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp)

    return app