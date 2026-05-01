from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
from . import db, login_manager

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(user_id)

# --- USER MODEL (The Real One) ---
class User(db.Model, UserMixin):
    __tablename__ = 'user'
    # Adding this prevents the "already defined" error if imports loop
    __table_args__ = {'extend_existing': True}

    # Note: You defined this as String(36).
    # If you use Integers for users, change this to db.Integer
    id = db.Column(db.String(36), primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(128))
    is_active = db.Column(db.Boolean, default=True)
    is_superuser = db.Column(db.Boolean, default=False)
    is_verified = db.Column(db.Boolean, default=False)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        if not self.password_hash:
            return False
        try:
            return check_password_hash(self.password_hash, password)
        except ValueError:
            return False

# --- CHANNEL MODEL ---
class Channel(db.Model):
    __bind_key__ = 'channels_db'
    __tablename__ = 'channels'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    url = db.Column(db.String(255), nullable=False)
    favorites = db.Column('Favorites', db.String(255), nullable=True)
    brand = db.Column(db.String(120), nullable=True)
    is_playing = db.Column(db.String(255), nullable=True)
    logo = db.Column(db.String(500))

# --- ROOM MODEL ---
class Room(db.Model):

    __tablename__ = 'room'
    __table_args__ = {'extend_existing': True}

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    host_id = db.Column(db.String(36), db.ForeignKey('user.id'), nullable=False)

    # Playback State
    current_media_key = db.Column(db.String(200), nullable=True)
    current_media_title = db.Column(db.String(200), nullable=True)
    current_media_url = db.Column(db.String(500), nullable=True)

    is_playing = db.Column(db.Boolean, default=False)
    current_time = db.Column(db.Float, default=0.0)
    last_updated = db.Column(db.DateTime, default=datetime.utcnow)

    host = db.relationship('User', foreign_keys=[host_id])

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'host': self.host.username,
            'media_title': self.current_media_title,
            'is_playing': self.is_playing,
        }