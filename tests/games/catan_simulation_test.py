"""Automated complete matches exercise phase progression and card conservation."""
import random
from catan_online_test import R

for seed in range(3):
    rng=random.Random(seed);s=R.create(['A','B','C','D'],rng)
    for step in range(12000):
        if s['winner'] is not None:break
        owner=s['current'];p=s['players'][owner];phase=s['phase']
        data=None
        if phase.startswith('setup'):
            piece=phase[6:];data=dict(type='build',piece=piece,target=rng.choice(R.legal(s,piece)))
        elif phase=='discard':
            owner=s['discard'][0]['owner'];p=s['players'][owner]
            data=dict(type='discard',resource=max(R.RESOURCES,key=lambda r:p['resources'][r]))
        elif phase=='robber':data=dict(type='robber',target=rng.choice([i for i in range(19) if i!=s['robber']]))
        elif phase=='steal':data=dict(type='steal',target=rng.choice(s['victims']))
        elif phase=='free-road':data=dict(type='build',piece='road',target=rng.choice(R.legal(s,'road')))
        elif phase in ('roll','build'):
            playable=[d['kind'] for d in p['dev'] if d['bought']<s['turn'] and d['kind']!='victory'] if not s['playedDev'] else []
            # Use knights and monopoly; roadbuilding/plenty have dedicated tests.
            if 'knight' in playable:data=dict(type='play-development',card='knight')
            elif 'monopoly' in playable:data=dict(type='play-development',card='monopoly',resource=rng.choice(R.RESOURCES))
            elif phase=='roll':data=dict(type='roll')
            else:
                for piece in ('city','settlement','development','road'):
                    legal=R.legal(s,piece) if piece!='development' else bool(s['deck'])
                    if legal and (piece=='development' or p[piece]>0) and all(p['resources'][r]>=n for r,n in R.COSTS[piece].items()):
                        data=dict(type='buy-development') if piece=='development' else dict(type='build',piece=piece,target=rng.choice(legal));break
                if data is None:
                    # Trade surplus towards the next affordable improvement.
                    gives=[r for r in R.RESOURCES if p['resources'][r]>=R.rate(s,owner,r)]
                    wants=[r for r in R.RESOURCES if s['bank'][r] and p['resources'][r]==0]
                    data=dict(type='bank-trade',give=rng.choice(gives),receive=rng.choice(wants)) if gives and wants else dict(type='end')
        assert data is not None,(phase,step)
        R.action(s,owner,data,rng)
        for r in R.RESOURCES:
            assert s['bank'][r]>=0 and all(q['resources'][r]>=0 for q in s['players'])
            assert s['bank'][r]+sum(q['resources'][r] for q in s['players'])==19,(seed,step,r)
        for i,q in enumerate(s['players']):
            assert q['road']+sum(o==i for o in s['roads'].values())==15
            assert q['city']+sum(b['owner']==i and b['kind']=='city' for b in s['buildings'].values())==4
            assert q['settlement']+sum(b['owner']==i and b['kind']=='settlement' for b in s['buildings'].values())==5
    assert s['winner'] is not None,('No winner',seed,s['turn'])
    print(f'PASS: full match seed {seed}, {s["turn"]} turns, {step} actions, winner {s["winner"]}; all resource and piece totals conserved.')
