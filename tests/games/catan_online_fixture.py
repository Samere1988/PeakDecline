"""Ephemeral localhost-only browser fixture. Does not load production databases."""
import tempfile
from pathlib import Path
from flask import render_template, session, redirect
from werkzeug.serving import make_server
from catan_online_test import test_app
from app.catan_online import database, load, save
from app import catan_rules as rules
from app import catan_cities_knights as ck
from unittest.mock import patch

if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='catan-browser-') as directory:
        app,_=test_app(Path(directory)/'games.sqlite3')
        patch('app.catan_online.secrets.randbelow', return_value=0).start()
        @app.get('/test-login/<player>')
        def login(player):
            session['_user_id']=player;session['_fresh']=True
            return redirect('/games/catan')
        @app.get('/games')
        def games():return 'Test games'
        # Match the production template URL names without importing streaming routes.
        app.add_url_rule('/test-games','main.games',games)
        app.add_url_rule('/','main.index',games)
        for endpoint in ('profile','login','logout'):
            app.add_url_rule('/test-'+endpoint,'auth.'+endpoint,lambda: 'Fixture account')
        @app.get('/games/catan')
        def catan():return render_template('catan.html',player_name='Player '+session.get('_user_id','?'),online=True)
        @app.post('/test-seed/<room_id>')
        def seed(room_id):
            # Test fixture ONLY: arrange resources to exercise UI actions quickly.
            with database(True) as db:
                room=load(db,room_id);s=room['game'];s['current']=1;s['phase']='build';s['turn']=4
                for p in s['players']:p['resources']=rules.bag(2)
                s['players'][1]['resources']['wood']=4;s['players'][1]['resources']['ore']=3
                for r in rules.RESOURCES:s['bank'][r]=19-sum(p['resources'][r] for p in s['players'])
                s['players'][1]['dev']=[dict(kind=kind,bought=0) for kind in ('roadbuilding','monopoly','plenty','victory')]
                s['deck'][-1]='knight';room['gameRevision']+=1;save(db,room)
            return {'ok':True}
        @app.post('/test-finish/<room_id>')
        def finish(room_id):
            # Test fixture ONLY: show the completed match summary without playing to ten points.
            with database(True) as db:
                room=load(db,room_id);s=room['game']
                s['phase']='finished';s['winner']=1
                s['rolls']=[{'player':0,'dice':[1,1]},{'player':1,'dice':[3,4]},{'player':2,'dice':[5,2]},{'player':1,'dice':[6,6]}]
                room['status']='finished';room['gameRevision']+=1;save(db,room)
            return {'ok':True}
        @app.post('/test-seed-ck/<room_id>')
        def seed_ck(room_id):
            # Test fixture ONLY: provide cards for multiplayer expansion controls.
            with database(True) as db:
                room=load(db,room_id)
                assert room['mode']=='cities-knights'
                game=room['game'];game['current']=0;game['phase']='build';game['turn']=4
                for player in game['players']:
                    player['resources']=rules.bag()
                    player['commodities']=dict.fromkeys(ck.COMMODITIES,0)
                game['players'][0]['resources']['wood']=4
                game['players'][0]['commodities']['paper']=3
                game['players'][1]['commodities']['cloth']=2
                game['players'][1]['resources']['ore']=1
                for kind in rules.RESOURCES:
                    game['bank'][kind]=19-sum(p['resources'][kind] for p in game['players'])
                for kind in ck.COMMODITIES:
                    game['commodityBank'][kind]=12-sum(p['commodities'][kind] for p in game['players'])
                card='science_crane';game['progressDecks']['science'].remove(card)
                game['players'][0]['progress'].append(card)
                room['gameRevision']+=1;save(db,room)
            return {'ok':True}
        @app.post('/test-seed-ck-56/<room_id>')
        def seed_ck_56(room_id):
            # Test fixture ONLY: exercise the expansion's five-player build phase.
            with database(True) as db:
                room=load(db,room_id)
                assert room['mode']=='cities-knights' and room['map']=='base-56'
                game=room['game'];game['current']=0;game['phase']='build';game['turn']=4
                game['buildings']={'0':{'owner':1,'kind':'city'}}
                game['roads']={'0':1}
                for player in game['players']:
                    player['resources']=rules.bag()
                    player['commodities']=dict.fromkeys(ck.COMMODITIES,0)
                game['players'][1]['resources'].update(wood=2,brick=2,wheat=3,sheep=3,ore=3)
                game['players'][1]['commodities']['paper']=2
                for kind in rules.RESOURCES:
                    game['bank'][kind]=24-sum(player['resources'][kind] for player in game['players'])
                for kind in ck.COMMODITIES:
                    game['commodityBank'][kind]=18-sum(player['commodities'][kind] for player in game['players'])
                ck.awards(game)
                room['gameRevision']+=1;save(db,room)
            return {'ok':True}
        server=make_server('127.0.0.1',0,app,threaded=True)
        print('CATAN_TEST_PORT='+str(server.server_port),flush=True)
        server.serve_forever()
