"""Exercise the real app factory/routes with temporary databases only."""
from pathlib import Path
import sys
import json
import tempfile
from unittest.mock import patch
from flask import Flask

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
original_init = Flask.__init__

with tempfile.TemporaryDirectory() as directory:
    def isolated_init(self, *args, **kwargs):
        kwargs['instance_path'] = directory
        (Path(directory) / 'session-security.json').write_text(json.dumps({
            'secret_key': 'retro-preflight-temporary-secret-only',
            'monitoring_owner_id': 'retro-preflight'}))
        original_init(self, *args, **kwargs)
    with patch.object(Flask, '__init__', isolated_init):
        from app import create_app, db
        application = create_app()
    application.config.update(TESTING=True, SERVER_NAME='peakdecline.com', PREFERRED_URL_SCHEME='https')
    assert Path(application.instance_path) == Path(directory)
    with application.app_context():
        assert all(str(engine.url.database).startswith(directory) for engine in db.engines.values())
        db.create_all()
        from app.models import User
        user = User(id='retro-preflight', username='Retro preflight', email='retro-preflight@example.invalid')
        db.session.add(user)
        db.session.commit()
        user_id = str(user.id)
        from app.session_security import password_version
        version = password_version(user)
    client = application.test_client()
    with client.session_transaction() as session:
        session['_user_id'] = user_id
        session['_fresh'] = True
        session['password_version'] = version
    for url in ('/', '/games', '/games/retro'):
        response = client.get(url)
        assert response.status_code == 200, (url, response.status_code)
        if url == '/games':
            assert '/games/retro' in response.text
        if url == '/':
            assert '/games/retro' not in response.text
        print(url, response.status_code)
    with application.app_context():
        db.session.remove()
        for engine in db.engines.values():
            engine.dispose()
print('Production factory preflight passed using temporary databases.')
