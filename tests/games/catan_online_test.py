"""Runs only against temporary databases; never boots the production app factory."""
import copy
import importlib.util
import json
import random
import sys
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from flask import Flask
from flask_login import LoginManager, UserMixin
from flask_socketio import SocketIO
from app import catan_rules as R
from app import catan_cities_knights as CK
from app.catan_online import register, database, load, save


def test_app(path):
    app=Flask(__name__,template_folder=str(ROOT/'templates'),static_folder=str(ROOT/'static'))
    app.config.update(TESTING=True,SECRET_KEY='isolated-test-only',CATAN_DATABASE=str(path))
    login=LoginManager(app)
    class User(UserMixin):
        def __init__(self,id): self.id=id; self.username='Player '+id
    @login.user_loader
    def user(id): return User(id)
    sio=SocketIO(app,async_mode='threading')
    register(app,sio)
    return app,sio


class RulesTests(unittest.TestCase):
    def setUp(self): self.s=R.create(['A','B','C','D'],random.Random(4))
    def call(self,owner,**data): R.action(self.s,owner,data,random.Random(7))
    def setup_board(self):
        order=[]
        while self.s['phase'].startswith('setup'):
            owner=self.s['current']; kind=self.s['phase'][6:]
            if kind=='settlement': order.append(owner)
            self.call(owner,type='build',piece=kind,target=R.legal(self.s,kind)[0])
        return order
    def test_setup_and_conservation(self):
        self.assertEqual(self.setup_board(),[0,1,2,3,3,2,1,0])
        self.assertEqual(self.s['phase'],'roll')
        for p in self.s['players']: self.assertEqual((p['vp'],p['settlement'],p['road']),(2,3,13))
        for r in R.RESOURCES: self.assertEqual(self.s['bank'][r]+sum(p['resources'][r] for p in self.s['players']),19)
        with self.assertRaises(R.Invalid): self.call(1,type='roll')
        self.call(0,type='roll')
        with self.assertRaises(R.Invalid): self.call(0,type='roll')
    def test_public_resource_gains_appear_in_move_log(self):
        self.setup_board()
        tile=next(t for t in self.s['tiles'] if t['id']!=self.s['robber'] and t['number']!=7 and any(str(v) in self.s['buildings'] for v in t['corners']))
        number=tile['number']; first=max(1,number-6)
        class FixedRoll:
            def __init__(self): self.dice=iter((first,number-first))
            def randint(self,_low,_high): return next(self.dice)
        before=[p['resources'].copy() for p in self.s['players']]
        R.action(self.s,0,{'type':'roll'},FixedRoll())
        expected=[p['name']+' received '+', '.join(f"{p['resources'][r]-before[i][r]} {r}" for r in R.RESOURCES if p['resources'][r]>before[i][r]) for i,p in enumerate(self.s['players']) if any(p['resources'][r]>before[i][r] for r in R.RESOURCES)]
        self.assertTrue(expected)
        for gain in expected:self.assertIn(gain,self.s['log'][-1])
    def test_three_players_and_valid_random_board(self):
        self.s=R.create(['A','B','C'],random.Random(1))
        self.assertEqual(self.setup_board(),[0,1,2,2,1,0])
        for seed in range(50):
            s=R.create(['A','B','C'],random.Random(seed))
            self.assertEqual(sum(t['number'] is None for t in s['tiles']),1)
            for e in R.EDGES:
                if len(e['tiles'])==2: self.assertFalse(all(s['tiles'][t]['number'] in (6,8) for t in e['tiles']))
    def test_private_views(self):
        self.setup_board();self.s['players'][0]['dev']=[dict(kind='victory',bought=0)]
        a,b,spectator=[R.view(self.s,i) for i in (0,1,None)]
        self.assertNotIn('deck',a);self.assertIsNone(b['players'][0]['resources']);self.assertIsNone(b['players'][0]['dev'])
        self.assertNotIn('totalVP',b['players'][0]);self.assertEqual(a['players'][0]['totalVP'],3)
        self.assertTrue(all(p['resources'] is None and p['dev'] is None for p in spectator['players']))
        self.assertTrue(all(not ids for ids in spectator['legal'].values()))
    def test_dev_purchase_age_and_once_per_turn(self):
        self.setup_board();s=self.s;s['phase']='build';s['deck']=['knight']
        for r in ('ore','wheat','sheep'): s['players'][0]['resources'][r]=1
        self.call(0,type='buy-development')
        with self.assertRaises(R.Invalid): self.call(0,type='play-development',card='knight')
        s['turn']=4;s['phase']='roll';self.call(0,type='play-development',card='knight')
        self.assertEqual(s['phase'],'robber');self.assertEqual(s['players'][0]['knights'],1)
        self.call(0,type='robber',target=next(i for i in range(19) if i!=s['robber']))
        if s['phase']=='steal':self.call(0,type='steal',target=s['victims'][0])
        self.assertEqual(s['phase'],'roll')
        s['players'][0]['dev'].append(dict(kind='knight',bought=0))
        with self.assertRaises(R.Invalid): self.call(0,type='play-development',card='knight')
    def test_monopoly_plenty_and_free_roads(self):
        self.setup_board();s=self.s;s['phase']='build';s['turn']=4
        s['players'][0]['dev']=[dict(kind=k,bought=0) for k in ['monopoly','plenty','roadbuilding']]
        s['players'][1]['resources']['wood']=3
        before=sum(p['resources']['wood'] for p in s['players'])
        self.call(0,type='play-development',card='monopoly',resource='wood')
        self.assertEqual(s['players'][0]['resources']['wood'],before)
        s['playedDev']=False;before=s['players'][0]['resources']['ore']
        self.call(0,type='play-development',card='plenty',resources={'ore':2})
        self.assertEqual(s['players'][0]['resources']['ore'],before+2)
        s['playedDev']=False;cards=copy.deepcopy(s['players'][0]['resources'])
        self.call(0,type='play-development',card='roadbuilding')
        for _ in range(2):self.call(0,type='build',piece='road',target=R.legal(s,'road')[0])
        self.assertEqual(s['phase'],'build');self.assertEqual(s['players'][0]['resources'],cards)
    def test_player_trade_and_double_accept(self):
        s=self.s;s['phase']='build';s['players'][0]['resources']['wood']=2;s['players'][1]['resources']['ore']=1
        self.call(0,type='offer',give={'wood':2},want={'ore':1});offer=s['offers'][0]['id']
        self.call(1,type='accept-trade',offer=offer)
        self.assertEqual(s['players'][1]['resources']['wood'],0)
        self.call(0,type='confirm-trade',offer=offer,target=1)
        self.assertEqual(s['players'][1]['resources']['wood'],2);self.assertEqual(s['players'][0]['resources']['ore'],1)
        with self.assertRaises(R.Invalid):self.call(2,type='accept-trade',offer=offer)
    def test_trade_responses_counteroffers_and_wildcards(self):
        s=self.s;s['phase']='build'
        s['players'][0]['resources']=R.bag(4)
        s['players'][1]['resources']=R.bag(2)
        s['players'][2]['resources']=R.bag(2)
        self.call(0,type='offer',give={'wood':1},want={});original=s['offers'][0]['id']
        with self.assertRaises(R.Invalid):self.call(1,type='accept-trade',offer=original)
        self.call(1,type='counter-trade',offer=original,give={'ore':1},want={'wood':1})
        counter=s['offers'][1]['id']
        self.assertEqual(s['offers'][1]['give']['wood'],1)
        self.call(2,type='reject-trade',offer=counter)
        self.call(2,type='accept-trade',offer=counter)
        self.assertEqual(s['offers'][1]['responses']['2'],'accepted')
        with self.assertRaises(R.Invalid):self.call(1,type='confirm-trade',offer=counter,target=2)
        self.call(0,type='confirm-trade',offer=counter,target=2)
        self.assertEqual(s['players'][2]['resources']['wood'],3)
        self.assertEqual(s['players'][1]['resources']['wood'],2)
        self.assertFalse(s['offers'])

    def test_trade_revalidates_cards_embargo_and_turn_end(self):
        s=self.s;s['phase']='build';s['players'][0]['resources']=R.bag(4);s['players'][1]['resources']=R.bag(2)
        self.call(0,type='offer',give={'wood':1},want={'ore':2});offer=s['offers'][0]['id']
        self.call(1,type='accept-trade',offer=offer)
        s['players'][1]['resources']['ore']=1
        before=copy.deepcopy(s['players'])
        with self.assertRaises(R.Invalid):self.call(0,type='confirm-trade',offer=offer,target=1)
        self.assertEqual(s['players'],before)
        self.call(1,type='embargo',target=0)
        with self.assertRaises(R.Invalid):self.call(1,type='counter-trade',offer=offer,give={'brick':1},want={'wood':1})
        self.call(1,type='embargo',target=0)
        self.call(0,type='end')
        self.assertFalse(s['offers'])
        with self.assertRaises(R.Invalid):self.call(1,type='accept-trade',offer=offer)

    def test_embargo_auto_rejects_and_all_declines_resolve_offer(self):
        s=self.s;s['phase']='build';s['players'][0]['resources']=R.bag(3)
        self.call(1,type='embargo',target=0)
        self.call(0,type='offer',give={'wood':1},want={'ore':1})
        offer=s['offers'][0]
        self.assertEqual(offer['responses']['1'],'rejected')
        for owner in (2,3):self.call(owner,type='reject-trade',offer=offer['id'])
        self.assertTrue(offer['allRejected'])
        with self.assertRaises(R.Invalid):self.call(2,type='accept-trade',offer=offer['id'])

    def test_batch_bank_trade_atomic_and_rates(self):
        s=self.s;s['phase']='build';s['players'][0]['resources']=R.bag(8)
        self.call(0,type='bank-trade',give={'wood':8},receive={'ore':1,'wheat':1})
        self.assertEqual(s['players'][0]['resources']['wood'],0)
        self.assertEqual(s['players'][0]['resources']['ore'],9)
        before=copy.deepcopy(s)
        with self.assertRaises(R.Invalid):self.call(0,type='bank-trade',give={'brick':3},receive={'ore':1})
        self.assertEqual(s,before)
        with self.assertRaises(R.Invalid):self.call(0,type='bank-trade',give={'brick':4},receive={'brick':1})

    def test_default_dice_use_two_independent_system_random_draws(self):
        from unittest.mock import patch
        s=self.s;s['phase']='roll'
        class AuditedRandom:
            calls=[]
            def randint(self,a,b):
                self.calls.append((a,b))
                return (2,5)[len(self.calls)-1]
        with patch('app.catan_rules.secrets.SystemRandom',return_value=AuditedRandom()):
            R.action(s,0,{'type':'roll'})
        self.assertEqual(s['dice'],[2,5])
        self.assertEqual(AuditedRandom.calls,[(1,6),(1,6)])
        self.assertEqual(s['rolls'],[{'player':0,'dice':[2,5]}])

    def test_existing_game_marks_incomplete_roll_history(self):
        s=self.s;s['phase']='roll';del s['rolls']
        self.call(0,type='roll')
        self.assertTrue(s['rollHistoryPartial'])
        self.assertEqual(s['rolls'][0]['dice'],s['dice'])

    def test_discard_and_robber(self):
        self.setup_board();s=self.s
        class Seven:
            def __init__(self):self.values=iter([1,6])
            def randint(self,*args):return next(self.values)
        s['players'][1]['resources']=R.bag();s['players'][1]['resources']['wood']=9
        R.action(s,0,{'type':'roll'},Seven());self.assertEqual(s['phase'],'discard')
        with self.assertRaises(R.Invalid):self.call(0,type='discard',resource='wood')
        for _ in range(4):self.call(1,type='discard',resource='wood')
        self.assertEqual(s['phase'],'robber');self.assertEqual(s['players'][1]['resources']['wood'],5)
    def test_longest_road_block_and_hidden_victory(self):
        s=self.s;s['phase']='build'
        # Find a simple six-edge path without a repeated vertex.
        def path(v,used,vs):
            if len(used)==6:return used,vs
            for e in R.VERTICES[v]['edges']:
                w=next(w for w in R.EDGES[e]['ends'] if w!=v)
                if e not in used and w not in vs:
                    result=path(w,used+[e],vs+[w])
                    if result:return result
        edges,vertices=path(0,[],[0]);s['roads']={str(e):0 for e in edges};R.awards(s)
        self.assertEqual(s['longest'],0);self.assertEqual(s['players'][0]['longest'],6)
        s['buildings'][str(vertices[3])]=dict(owner=1,kind='settlement');R.awards(s)
        self.assertIsNone(s['longest']);self.assertEqual(s['players'][0]['longest'],3)
        s['players'][0]['knights']=3;R.awards(s);self.assertEqual(s['army'],0)
        s['buildings']={str(v):dict(owner=0,kind='city') for v in (0,5,10)}
        s['players'][0]['dev']=[dict(kind='victory',bought=0)]*2;R.awards(s)
        self.assertEqual(s['winner'],0)


class OnlineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.app,self.sio=test_app(Path(self.tmp.name)/'games.sqlite3')
        self.clients=[];self.tokens=[]
        for i in range(6):
            c=self.app.test_client()
            with c.session_transaction() as session:session['_user_id']=str(i);session['_fresh']=True
            self.tokens.append(c.get('/api/catan/lobby').json['csrf']);self.clients.append(c)
        self.room=self.clients[0].post('/api/catan/rooms',json={'name':'First'},headers=self.headers(0)).json
    def tearDown(self):self.tmp.cleanup()
    def headers(self,i):return {'X-Catan-CSRF':self.tokens[i]}
    def command(self,i,kind,room=None,**kw):
        room=room or self.room
        response=self.clients[i].post('/api/catan/rooms/'+room['id']+'/actions',json=dict(type=kind,version=room['version'],command=uuid.uuid4().hex,**kw),headers=self.headers(i))
        if response.status_code==200 and 'id' in response.json and room['id']==self.room['id']:self.room=response.json
        return response
    def start(self):
        for i in (1,2,3):self.assertEqual(self.command(i,'join').status_code,200)
        for i in range(4):self.assertEqual(self.command(i,'ready').status_code,200)
        with patch('app.catan_online.secrets.randbelow',return_value=0):
            self.assertEqual(self.command(0,'start').status_code,200)
    def test_random_start_keeps_seat_colors(self):
        for i in (1,2,3):self.command(i,'join')
        for i in range(4):self.command(i,'ready')
        with patch('app.catan_online.secrets.randbelow',return_value=2):
            self.assertEqual(self.command(0,'start').status_code,200)
        self.assertEqual(self.room['game']['current'],2)
        self.assertEqual([p['color'] for p in self.room['game']['players']],[0,1,2,3])
        order=[]
        while self.room['game']['phase'].startswith('setup'):
            owner=self.room['game']['current']
            game=self.clients[owner].get('/api/catan/rooms/'+self.room['id']).json['game']
            piece=game['phase'].removeprefix('setup-')
            if piece=='settlement':order.append(owner)
            self.assertEqual(self.command(owner,'build',piece=piece,target=game['legal'][piece][0]).status_code,200)
        self.assertEqual(order,[2,3,0,1,1,0,3,2])
    def test_extended_map_reshuffle_and_three_player_start(self):
        created=self.clients[0].post('/api/catan/rooms',json={'name':'Small extended','map':'base-56'},headers=self.headers(0))
        self.room=created.json
        before=(self.room['preview'],self.room['previewPorts'])
        self.assertEqual(self.command(0,'reshuffle-map').status_code,200)
        after=(self.room['preview'],self.room['previewPorts'])
        self.assertNotEqual(after,before)
        for owner in (1,2):self.assertEqual(self.command(owner,'join').status_code,200)
        for owner in (0,1,2):self.assertEqual(self.command(owner,'ready').status_code,200)
        response=self.command(0,'start');self.assertEqual(response.status_code,200,response.json)
        self.assertEqual(len(self.room['game']['players']),3)
        self.assertEqual((self.room['game']['tiles'],self.room['game']['ports']),after)
    def test_game_mode_selection_is_saved_and_unknown_mode_is_rejected(self):
        self.assertEqual(self.room['mode'],'base')
        self.assertEqual(self.clients[0].get('/api/catan/lobby').json['rooms'][0]['mode'],'base')
        selected=self.clients[0].post('/api/catan/rooms',json={'name':'Selected base','mode':'base'},headers=self.headers(0))
        self.assertEqual(selected.status_code,201)
        self.assertEqual(selected.json['mode'],'base')
        expansion=self.clients[0].post('/api/catan/rooms',json={'name':'Expansion','mode':'cities-knights'},headers=self.headers(0))
        self.assertEqual(expansion.status_code,201)
        self.assertEqual(expansion.json['mode'],'cities-knights')
        for mode in ('unknown',42):
            response=self.clients[0].post('/api/catan/rooms',json={'mode':mode},headers=self.headers(0))
            self.assertEqual(response.status_code,400)
        self.assertEqual(len(self.clients[0].get('/api/catan/lobby').json['rooms']),3)

    def test_cities_knights_room_setup_private_trade_and_rematch(self):
        created=self.clients[0].post('/api/catan/rooms',json={'name':'Expansion','mode':'cities-knights'},headers=self.headers(0))
        self.assertEqual(created.status_code,201)
        self.room=created.json
        self.start()
        self.assertEqual(self.room['game']['mode'],'cities-knights')
        while self.room['game']['phase'].startswith('setup'):
            owner=self.room['game']['current']
            game=self.clients[owner].get('/api/catan/rooms/'+self.room['id']).json['game']
            piece=game['phase'].removeprefix('setup-')
            response=self.command(owner,'build',piece=piece,target=game['legal'][piece][0])
            self.assertEqual(response.status_code,200,response.json)
        self.assertEqual(self.room['game']['phase'],'roll')
        self.assertTrue(all(player['vp']==3 for player in self.room['game']['players']))
        spectator=self.command(4,'join',spectator=True)
        self.assertEqual(spectator.status_code,200)
        view=spectator.json['game']
        self.assertIsNone(view['players'][0]['resources'])
        self.assertIsNone(view['players'][0]['commodities'])
        self.assertIsNone(view['players'][0]['progress'])
        self.assertNotIn('progressDecks',view)
        self.assertIsNone(view['tradeRates'])
        with self.app.app_context(), database(True) as db:
            room=load(db,self.room['id'])
            game=room['game'];game['phase']='build'
            for owner,card,amount in ((0,'wood',1),(1,'ore',1)):
                game['players'][owner]['resources'][card]+=amount;game['bank'][card]-=amount
            for owner,card,amount in ((0,'paper',1),(1,'cloth',1)):
                game['players'][owner]['commodities'][card]+=amount;game['commodityBank'][card]-=amount
            save(db,room)
        self.room=self.clients[0].get('/api/catan/rooms/'+self.room['id']).json
        ore_before_trade=self.room['game']['players'][0]['resources']['ore']
        response=self.command(0,'offer',give={'wood':1,'paper':1},want={'ore':1,'cloth':1})
        self.assertEqual(response.status_code,200,response.json)
        offer=self.room['game']['offers'][0]['id']
        self.assertEqual(self.command(1,'accept-trade',offer=offer).status_code,200)
        self.assertEqual(self.command(0,'confirm-trade',offer=offer,target=1).status_code,200)
        self.assertEqual(self.room['game']['players'][0]['commodities']['cloth'],1)
        self.assertEqual(self.room['game']['players'][0]['resources']['ore'],ore_before_trade+1)
        private=self.clients[1].get('/api/catan/rooms/'+self.room['id']).json['game']
        self.assertIsNone(private['players'][0]['commodities'])
        self.assertIsNotNone(private['players'][1]['commodities'])
        self.assertEqual(self.command(1,'leave').status_code,200)
        self.room=self.clients[0].get('/api/catan/rooms/'+self.room['id']).json
        self.assertEqual(self.room['status'],'finished')
        self.assertEqual(self.command(0,'rematch').status_code,200)
        self.assertEqual(self.room['mode'],'cities-knights')
        self.assertEqual(self.room['status'],'lobby')
    def test_empty_room_timeout_and_reconnect(self):
        import time
        from unittest.mock import patch
        base=time.time()
        with self.app.app_context(), database(True) as db:
            room=load(db,self.room['id']);room['members'][0]['seen']=base;save(db,room)
        url='/api/catan/rooms/'+self.room['id']
        with patch('app.catan_online.time.time',return_value=base+59):
            self.assertEqual(self.clients[0].get(url).status_code,200)
        with patch('app.catan_online.time.time',return_value=base+118):
            self.assertEqual(self.clients[0].get(url+'/info').status_code,200)
        with patch('app.catan_online.time.time',return_value=base+119):
            self.assertEqual(self.clients[0].get(url).status_code,410)
            self.assertFalse(self.clients[0].get('/api/catan/lobby').json['rooms'])
            self.assertEqual(self.command(0,'join').status_code,410)

    def test_running_room_timeout_and_spectator_presence(self):
        import time
        self.start();self.command(4,'join',spectator=True)
        with self.app.app_context(), database(True) as db:
            room=load(db,self.room['id'])
            for m in room['members']:
                if m['seat'] is not None:m['seen']=time.time()-61
            save(db,room)
        self.assertEqual(self.clients[4].get('/api/catan/rooms/'+self.room['id']).status_code,200)
        with self.app.app_context(), database(True) as db:
            room=load(db,self.room['id'])
            for m in room['members']:m['seen']=time.time()-61
            save(db,room)
        self.assertEqual(self.clients[0].get('/api/catan/rooms/'+self.room['id']).status_code,410)

    def test_private_three_player_control(self):
        self.room=self.clients[0].post('/api/catan/rooms',json={'testMode':True,'public':True},headers=self.headers(0)).json
        self.assertFalse(self.room['public']);self.assertTrue(self.room['testMode'])
        self.assertEqual(len(self.room['members']),3)
        self.assertEqual(self.command(1,'join',spectator=True).status_code,400)
        self.assertEqual(self.command(0,'start').status_code,200)
        while self.room['game']['phase'].startswith('setup'):
            seat=self.room['game']['current']
            self.assertEqual(self.command(0,'test-seat',seat=seat).status_code,200)
            self.assertEqual(self.room['seat'],seat)
            self.assertIsNotNone(self.room['game']['players'][seat]['resources'])
            piece=self.room['game']['phase'][6:]
            self.assertEqual(self.command(0,'build',piece=piece,target=self.room['game']['legal'][piece][0]).status_code,200)
        self.assertEqual(self.room['game']['phase'],'roll')
        self.assertEqual(self.command(0,'test-seat',seat=3).status_code,400)
        with self.app.app_context(), database(True) as db:
            room=load(db,self.room['id']);room['members'][0]['seen']-=61;save(db,room)
        self.assertEqual(self.clients[0].get('/api/catan/rooms/'+self.room['id']).status_code,410)

    def test_concurrent_trade_responses_and_confirmation_idempotency(self):
        self.start()
        with self.app.app_context(), database(True) as db:
            room=load(db,self.room['id']);room['game']['phase']='build'
            for p in room['game']['players']:p['resources']=R.bag(3)
            save(db,room)
        self.room=self.clients[0].get('/api/catan/rooms/'+self.room['id']).json
        self.assertEqual(self.command(0,'offer',give={'wood':1},want={'ore':1}).status_code,200)
        original=self.room;offer=original['game']['offers'][0]['id']
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda i:self.command(i,'accept-trade',room=original,offer=offer),(1,2)))
        self.assertTrue(all(r.status_code==200 for r in results))
        room=self.clients[0].get('/api/catan/rooms/'+original['id']).json
        self.assertEqual(room['game']['offers'][0]['responses'],{'1':'accepted','2':'accepted'})
        body=dict(type='confirm-trade',offer=offer,target=2,version=room['version'],command=uuid.uuid4().hex)
        url='/api/catan/rooms/'+room['id']+'/actions'
        first=self.clients[0].post(url,json=body,headers=self.headers(0))
        again=self.clients[0].post(url,json=body,headers=self.headers(0))
        self.assertEqual(first.status_code,200);self.assertEqual(first.json['version'],again.json['version'])
        self.assertEqual(again.json['game']['players'][0]['resources']['wood'],2)
        self.assertEqual(self.clients[1].get('/api/catan/rooms/'+room['id']).json['game']['players'][1]['resources']['ore'],3)

    def test_auth_csrf_private_room_and_multiple_rooms(self):
        self.assertEqual(self.app.test_client().get('/api/catan/lobby').status_code,401)
        self.assertEqual(self.clients[0].post('/api/catan/rooms',json={}).status_code,403)
        self.assertEqual(self.clients[1].get('/api/catan/rooms/'+self.room['id']).status_code,400)
        self.assertFalse(self.clients[1].get('/api/catan/lobby').json['rooms'])
        other=self.clients[4].post('/api/catan/rooms',json={'name':'Second','public':True},headers=self.headers(4)).json
        self.start()
        restored=self.clients[4].get('/api/catan/rooms/'+other['id']).json
        self.assertEqual(restored['status'],'lobby');self.assertEqual(len(restored['members']),1)
    def test_duplicate_stale_concurrent_and_reconnect(self):
        self.start();snapshot=self.room;v=snapshot['game']['legal']['settlement'][0]
        command=dict(type='build',piece='settlement',target=v,version=snapshot['version'],command=uuid.uuid4().hex)
        url='/api/catan/rooms/'+snapshot['id']+'/actions'
        a=self.clients[0].post(url,json=command,headers=self.headers(0));b=self.clients[0].post(url,json=command,headers=self.headers(0))
        self.assertEqual(a.status_code,200);self.assertEqual(a.json['version'],b.json['version'])
        self.assertEqual(len(b.json['game']['buildings']),1)
        stale=self.clients[0].post(url,json={**command,'command':uuid.uuid4().hex},headers=self.headers(0))
        self.assertEqual(stale.status_code,409)
        self.room=b.json
        with self.app.app_context():
            with database() as db: self.assertEqual(load(db,snapshot['id'])['game']['phase'],'setup-road')
        road=b.json['game']['legal']['road'][0]
        def submit(_):
            c=self.app.test_client()
            with c.session_transaction() as session:session['_user_id']='0';session['catan_csrf']=self.tokens[0]
            return c.post(url,json=dict(type='build',piece='road',target=road,version=b.json['version'],command=uuid.uuid4().hex),headers=self.headers(0)).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(sorted(pool.map(submit,range(2))),[200,409])
        app2,_=test_app(Path(self.tmp.name)/'games.sqlite3');c=app2.test_client()
        with c.session_transaction() as session:session['_user_id']='0'
        restored=c.get('/api/catan/rooms/'+snapshot['id']).json
        self.assertEqual(restored['game']['current'],1);self.assertEqual(restored['seat'],0)
    def test_spectator_wrong_turn_socket_isolation_and_redaction(self):
        self.start();self.command(4,'join',spectator=True)
        spectator=self.clients[4].get('/api/catan/rooms/'+self.room['id']).json
        self.assertIsNone(spectator['seat']);self.assertTrue(all(p['resources'] is None for p in spectator['game']['players']))
        self.assertEqual(self.command(4,'roll').status_code,400)
        self.assertEqual(self.command(1,'build',piece='settlement',target=0).status_code,400)
        sockets=[self.sio.test_client(self.app,namespace='/catan',flask_test_client=self.clients[i]) for i in (0,5)]
        for sock in sockets:sock.emit('watch',{'id':self.room['id']},namespace='/catan')
        view=self.clients[0].get('/api/catan/rooms/'+self.room['id']).json
        self.command(0,'build',piece='settlement',target=view['game']['legal']['settlement'][0])
        received=sockets[0].get_received('/catan');self.assertTrue(received)
        self.assertEqual(set(received[0]['args'][0]),{'id','version'})
        self.assertFalse(sockets[1].get_received('/catan'))
        for sock in sockets:sock.disconnect(namespace='/catan')
    def test_host_recovery_resignation_rematch_and_chat(self):
        self.start()
        self.assertEqual(self.command(1,'claim-host').status_code,400)
        with self.app.app_context():
            with database(True) as db:
                room=load(db,self.room['id']);room['members'][0]['seen']-=130;save(db,room)
        self.assertEqual(self.command(1,'claim-host').status_code,200)
        self.assertEqual(self.room['host'],'1')
        self.assertEqual(self.command(1,'end-abandoned').status_code,200)
        self.assertEqual(self.room['status'],'finished')
        self.assertEqual(self.command(1,'rematch').status_code,200)
        self.assertEqual(self.room['status'],'lobby');self.assertTrue(all(not m['ready'] for m in self.room['members']))
        self.assertEqual(self.command(0,'chat',message='<script>bad</script>').status_code,200)
        self.assertEqual(self.room['chat'][-1]['text'],'<script>bad</script>') # rendered with textContent
        for i in range(4):self.command(i,'ready')
        self.command(1,'start');self.assertEqual(self.command(2,'leave').status_code,200)
        restored=self.clients[1].get('/api/catan/rooms/'+self.room['id']).json
        self.assertEqual(restored['status'],'finished');self.assertEqual(restored['game']['phase'],'finished')
    def test_simultaneous_ready_and_rejected_move_rollback(self):
        self.command(1,'join');self.command(2,'join');old=copy.deepcopy(self.room)
        for i in range(3):self.assertEqual(self.command(i,'ready',room=old).status_code,200)
        self.command(0,'start')
        before=self.clients[0].get('/api/catan/rooms/'+self.room['id']).json
        self.assertEqual(self.command(0,'build',piece='city',target=0).status_code,400)
        after=self.clients[0].get('/api/catan/rooms/'+self.room['id']).json
        self.assertEqual(before['version'],after['version']);self.assertEqual(before['game'],after['game'])
    def test_three_seat_color_survives_start_and_rematch(self):
        self.command(1,'join');self.command(2,'join');self.command(2,'seat',seat=3)
        for i in range(3):self.command(i,'ready')
        self.command(0,'start')
        self.assertEqual([p['color'] for p in self.room['game']['players']],[0,1,3])
        self.assertEqual(self.room['members'][2]['color'],3)
        self.command(1,'leave')
        self.room=self.clients[0].get('/api/catan/rooms/'+self.room['id']).json
        self.command(0,'rematch')
        self.assertEqual(next(m['seat'] for m in self.room['members'] if m['id']=='2'),3)
    def test_chat_does_not_invalidate_game_move(self):
        self.start();old=copy.deepcopy(self.room)
        self.command(1,'chat',message='Hello')
        result=self.command(0,'build',room=old,gameRevision=old['gameRevision'],piece='settlement',target=old['game']['legal']['settlement'][0])
        self.assertEqual(result.status_code,200)
    def test_host_returns_running_game_and_spectator_takes_vacated_seat(self):
        self.start()
        before_join=copy.deepcopy(self.room)
        self.assertEqual(self.command(4,'join',spectator=True).status_code,200)
        self.assertEqual(self.command(4,'return-lobby').status_code,400)
        self.assertEqual(self.command(0,'change-game',mode='cities-knights',map='base').status_code,400)
        self.assertEqual(self.command(0,'return-lobby',room=before_join,gameRevision=before_join['gameRevision']).status_code,200)
        self.assertEqual(self.room['status'],'lobby');self.assertIsNone(self.room['game'])
        self.assertEqual([m['seat'] for m in self.room['members']],[0,1,2,3,None])
        self.assertTrue(all(not m['ready'] for m in self.room['members']))
        self.assertEqual(self.command(4,'seat',seat=1).status_code,400)
        self.assertEqual(self.command(1,'seat',seat=None).status_code,200)
        self.assertEqual(self.command(4,'seat',seat=1).status_code,200)
        self.assertEqual(self.command(4,'change-game',mode='cities-knights',map='base').status_code,400)
        self.assertEqual(self.command(0,'change-game',mode='cities-knights',map='base').status_code,200)
        self.assertEqual(self.room['mode'],'cities-knights')
        for i in (0,2,3,4):self.assertEqual(self.command(i,'ready').status_code,200)
        self.assertEqual(self.command(0,'start').status_code,200)
        self.assertEqual(self.room['status'],'playing')
        self.assertIsNone(next(m['seat'] for m in self.room['members'] if m['id']=='1'))

    def test_public_room_roster_started_games_and_spectator_join(self):
        with self.app.app_context():
            with database(True) as db:
                r=load(db,self.room['id']);r['public']=True;save(db,r)
        self.room=self.clients[0].get('/api/catan/rooms/'+self.room['id']).json
        preview=copy.deepcopy(self.room['preview'])
        self.command(4,'join',spectator=True)
        listed=self.clients[5].get('/api/catan/lobby').json['rooms'][0]
        self.assertEqual(listed['spectators'],1);self.assertEqual(listed['members'][0]['name'],'Player 0')
        self.assertNotIn('game',listed);self.assertNotIn('resources',json.dumps(listed))
        self.start()
        self.assertEqual(self.room['game']['tiles'],preview)
        listed=self.clients[5].get('/api/catan/lobby').json['rooms'][0]
        self.assertEqual(listed['status'],'playing');self.assertEqual(listed['seats'],4)
        self.assertEqual(self.command(5,'join').status_code,400)
        self.assertEqual(self.command(5,'join',spectator=True).status_code,200)
        self.assertIsNone(self.room['seat'])


if __name__=='__main__':unittest.main(verbosity=2)
