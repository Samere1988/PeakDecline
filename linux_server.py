"""Run the restored application behind nginx on the local interface."""
from app import create_app, db, socketio

app = create_app()
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    socketio.run(app, host='127.0.0.1', port=8000, debug=False,
                 use_reloader=False)
