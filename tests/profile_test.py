import io
import tempfile
import unittest
from pathlib import Path
from flask import Flask
from PIL import Image
from app import db, login_manager
from app.auth import auth_bp
from app.models import User
from app.catan_online import database, save

ROOT = Path(__file__).resolve().parents[1]

class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Flask(__name__, template_folder=str(ROOT / 'templates'), static_folder=str(ROOT / 'static'), instance_path=self.temp.name)
        self.app.config.update(TESTING=True, SECRET_KEY='test', SQLALCHEMY_DATABASE_URI='sqlite://', SQLALCHEMY_BINDS={'channels_db':'sqlite://'}, CATAN_DATABASE=str(Path(self.temp.name)/'catan.sqlite3'))
        db.init_app(self.app)
        login_manager.init_app(self.app)
        self.app.register_blueprint(auth_bp)
        self.app.add_url_rule('/', endpoint='main.index', view_func=lambda: '')
        with self.app.app_context():
            db.create_all()
            user=User(id='one',username='Original',email='one@example.test')
            user.set_password('old-password')
            db.session.add_all([user,User(id='two',username='Taken',email='two@example.test')])
            db.session.commit()
        self.client=self.app.test_client()
        with self.client.session_transaction() as session:
            session['_user_id']='one';session['_fresh']=True;session['profile_csrf']='token'
    def tearDown(self):
        with self.app.app_context(): db.session.remove();db.engine.dispose()
        self.temp.cleanup()
    def post(self, **data):
        return self.client.post('/profile',data={'csrf':'token',**data})
    def test_profile_upload_username_and_safe_render(self):
        self.assertEqual(self.client.get('/profile').status_code,200)
        image=io.BytesIO();Image.new('RGB',(400,300)).save(image,'PNG');image.seek(0)
        self.assertEqual(self.post(action='details',username='New name',picture=(image,'picture.png')).status_code,302)
        with self.app.app_context():
            user=db.session.get(User,'one');self.assertEqual(user.username,'New name');url='/profile/pictures/'+user.avatar
        response=self.client.get(url);self.assertEqual(response.status_code,200)
        self.assertEqual(Image.open(io.BytesIO(response.data)).size,(256,256))
        response.close()
        saved_page=self.client.get('/profile').data
        self.assertIn(b'New name',saved_page)
        self.assertNotIn(b'alert-success',saved_page)
        self.assertIn(b'id="profile-avatar-preview"',saved_page)
        self.assertIn(b'id="picture-preview"',saved_page)
        self.assertIn(url.encode(),saved_page)
    def test_reject_duplicates_invalid_images_and_csrf(self):
        self.post(action='details',username='taken')
        self.post(action='details',username='Changed',picture=(io.BytesIO(b'not an image'),'x.png'))
        with self.app.app_context(): self.assertEqual(db.session.get(User,'one').username,'Original')
        self.assertEqual(self.client.post('/profile',data={'action':'details','username':'Changed'}).status_code,403)
    def test_viewer_profiles_use_uploaded_picture_or_fallback(self):
        from app.routes import _viewer_profiles
        with self.app.app_context():
            user=db.session.get(User,'one');user.avatar='a'*32+'.jpg';db.session.commit()
            people=_viewer_profiles(['Original','Taken','Guest'])
            self.assertEqual(people[0]['avatar'],'/profile/pictures/'+'a'*32+'.jpg')
            self.assertEqual([p['avatar'] for p in people[1:]],['/static/img/avatar-default.svg']*2)
            self.assertEqual([p['name'] for p in people],['Original','Taken','Guest'])

    def test_password_requires_current_and_confirmation(self):
        self.post(action='password',current_password='wrong',password='new-password',confirm_password='new-password')
        with self.app.app_context(): self.assertTrue(db.session.get(User,'one').check_password('old-password'))
        self.assertEqual(self.post(action='password',current_password='old-password',password='new-password',confirm_password='new-password').status_code,302)
        with self.app.app_context(): self.assertTrue(db.session.get(User,'one').check_password('new-password'))
    def test_match_statistics_are_idempotent_and_exclude_tests(self):
        with self.app.app_context():
            room=dict(id='room',version=0,game={'winner':None},participants=[{'id':'one','seat':0},{'id':'two','seat':1}])
            with database(True) as connection:
                save(connection,room);save(connection,room)
                room['game']['winner']=0;save(connection,room);save(connection,room)
                test=dict(id='test',version=0,testOwner='one',game={'winner':0},participants=[{'id':'one','seat':0}]);save(connection,test)
            with database() as connection:
                rows=connection.execute('SELECT user_id,won FROM catan_results ORDER BY user_id').fetchall()
                self.assertEqual([tuple(row) for row in rows],[('one',1),('two',0)])
        self.assertIn(b'Catan games won',self.client.get('/profile').data)

if __name__ == '__main__': unittest.main()
