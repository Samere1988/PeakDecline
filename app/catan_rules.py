"""Authoritative base-game rules, independent of Flask and streaming services."""
import copy
import secrets

from .catan_maps import EXTENDED

RESOURCES = ['wood', 'brick', 'wheat', 'sheep', 'ore']
COSTS = {'road': {'wood': 1, 'brick': 1}, 'settlement': dict(wood=1, brick=1, wheat=1, sheep=1),
         'city': dict(wheat=2, ore=3), 'development': dict(wheat=1, sheep=1, ore=1)}
POSITIONS = [(23,2),(41,2),(59,2),(14,20),(32,20),(50,20),(68,20),(5,38),(23,38),(41,38),(59,38),(77,38),(14,56),(32,56),(50,56),(68,56),(23,74),(41,74),(59,74)]
VERTICES, EDGES, TILES = [], [], []
for tid, (x, y) in enumerate(POSITIONS):
    corners = []
    for dx, dy in [(9,0),(18,6),(18,18),(9,24),(0,18),(0,6)]:
        v = next((v for v in VERTICES if (v['x'],v['y']) == (x+dx,y+dy)), None)
        if v is None:
            v = dict(id=len(VERTICES), x=x+dx, y=y+dy, tiles=[], edges=[])
            VERTICES.append(v)
        v['tiles'].append(tid)
        corners.append(v['id'])
    for a,b in zip(corners, corners[1:]+corners[:1]):
        e = next((e for e in EDGES if set(e['ends']) == {a,b}), None)
        if e is None:
            e = dict(id=len(EDGES), ends=[a,b], tiles=[])
            EDGES.append(e)
            VERTICES[a]['edges'].append(e['id']); VERTICES[b]['edges'].append(e['id'])
        e['tiles'].append(tid)
    TILES.append(dict(id=tid,x=x,y=y,corners=corners))
PAIRS = [[(23,8),(32,2)],[(50,2),(59,8)],[(77,20),(86,26)],[(95,44),(95,56)],[(86,74),(77,80)],[(59,92),(68,98)],[(23,92),(32,98)],[(14,62),(14,74)],[(14,26),(14,38)]]
PORTS = []
for pair, kind in zip(PAIRS, ['wood','any','any','brick','wheat','ore','sheep','any','any']):
    ids = {v['id'] for v in VERTICES if (v['x'],v['y']) in pair}
    PORTS.append(dict(edge=next(e['id'] for e in EDGES if set(e['ends']) == ids),type=kind))


class Invalid(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def bag(n=0):
    return dict.fromkeys(RESOURCES, n)


def total(p):
    return sum(p['resources'].values())


def topology(s):
    geometry = (EXTENDED if s.get('map') == 'base-56' else
                dict(vertices=VERTICES, edges=EDGES, tiles=TILES, ports=PORTS))
    # Harbor sites belong to the coast. Keep each room's shuffled types while
    # correcting edge IDs in rooms saved before the larger-map layout fix.
    sites, saved = geometry['ports'], s.get('ports', [])
    ports = ([dict(edge=site['edge'], type=saved[i].get('type', site['type']))
              for i, site in enumerate(sites)] if len(saved) == len(sites) else sites)
    return dict(geometry, ports=ports)


def create(names, rng=None, map_id='base'):
    rng = rng or secrets.SystemRandom()
    require(map_id in ('base', 'base-56'), 'Choose a valid base-game map.')
    require(3 <= len(names) <= 6 if map_id == 'base-56' else 3 <= len(names) <= 4,
            'Start with three to six players.' if map_id == 'base-56' else 'Start with three or four players.')
    terrain = (['wood']*6+['sheep']*6+['wheat']*6+['brick']*5+['ore']*5+['desert']*2
               if map_id == 'base-56' else
               ['wood']*4+['sheep']*4+['wheat']*4+['brick']*3+['ore']*3+['desert'])
    rng.shuffle(terrain)
    tokens = ([2,2]+[n for n in (3,4,5,6,8,9,10,11) for _ in range(3)]+[12,12]
              if map_id == 'base-56' else
              [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12])
    geometry = EXTENDED if map_id == 'base-56' else dict(tiles=TILES, edges=EDGES, ports=PORTS)
    tiles = copy.deepcopy(geometry['tiles'])
    for t,r in zip(tiles,terrain):
        t['type'] = r
    # Reject adjacent red tokens; bounded retries then deterministic backtracking.
    neighbors = {t['id']: {other for e in geometry['edges'] if t['id'] in e['tiles'] for other in e['tiles'] if other != t['id']} for t in tiles}
    eligible = [t['id'] for t in tiles if t['type'] != 'desert']
    rng.shuffle(eligible)
    def red_slots(chosen, candidates):
        if len(chosen) == (6 if map_id == 'base-56' else 4): return chosen
        for pos,i in enumerate(candidates):
            found = red_slots(chosen+[i], [j for j in candidates[pos+1:] if j not in neighbors[i]])
            if found: return found
        return None
    reds = red_slots([], eligible)
    other = [n for n in tokens if n not in (6,8)]; rng.shuffle(other)
    red_numbers = [6,6,6,8,8,8] if map_id == 'base-56' else [6,6,8,8]
    rng.shuffle(red_numbers)
    for t in tiles:
        t['number'] = None if t['type']=='desert' else red_numbers.pop() if t['id'] in reds else other.pop()
    deck = (['knight']*20+['victory']*5+['roadbuilding']*3+['plenty']*3+['monopoly']*3
            if map_id == 'base-56' else
            ['knight']*14+['victory']*5+['roadbuilding']*2+['plenty']*2+['monopoly']*2)
    rng.shuffle(deck)
    ports = copy.deepcopy(geometry['ports'])
    # The extension adds one 3:1 harbor and one wool 2:1 harbor.
    kinds = ['any'] * (5 if map_id == 'base-56' else 4) + RESOURCES
    if map_id == 'base-56': kinds.append('sheep')
    rng.shuffle(kinds)
    for port, kind in zip(ports, kinds):
        port['type'] = kind
    return dict(map=map_id,current=0,phase='setup-settlement',setup=0,anchor=None,buildings={},roads={},bank=bag(24 if map_id == 'base-56' else 19),
                robber=terrain.index('desert'),dice=None,winner=None,discard=[],victims=[],tiles=tiles,ports=ports,
                deck=deck,turn=0,playedDev=False,freeRoads=0,robberReturn='build',longest=None,army=None,offers=[],log=[],rolls=[],
                specialFlags=[],specialQueue=[],specialNext=None,
                players=[dict(name=name,resources=bag(),vp=0,road=15,settlement=5,city=4,dev=[],knights=0,longest=0) for name in names])


def building(s,v): return s['buildings'].get(str(v))
def road(s,e): return s['roads'].get(str(e))


def legal(s,kind):
    geometry=topology(s); vertices=geometry['vertices']; edges=geometry['edges']
    setup = s['phase'].startswith('setup')
    if s['winner'] is not None or (setup and s['phase'] != 'setup-'+kind) or (not setup and s['phase'] not in ('build','free-road','special-build')):
        return []
    if s['phase']=='free-road' and kind!='road': return []
    def connected(v):
        b=building(s,v)
        return b['owner']==s['current'] if b else any(road(s,e)==s['current'] for e in vertices[v]['edges'])
    if kind=='road':
        return [e['id'] for e in edges if road(s,e['id']) is None and (s['anchor'] in e['ends'] if setup else any(connected(v) for v in e['ends']))]
    if kind=='settlement':
        return [v['id'] for v in vertices if not building(s,v['id']) and all(not building(s,w) for e in v['edges'] for w in edges[e]['ends']) and (setup or any(road(s,e)==s['current'] for e in v['edges']))]
    if kind=='city': return [int(v) for v,b in s['buildings'].items() if b['owner']==s['current'] and b['kind']=='settlement']
    return []


def pay(s,owner,kind):
    p=s['players'][owner]
    require(all(p['resources'][r]>=n for r,n in COSTS[kind].items()), 'Not enough resources.')
    for r,n in COSTS[kind].items(): p['resources'][r]-=n; s['bank'][r]+=n


def give(s,owner,r,n):
    n=min(n,s['bank'][r]); s['bank'][r]-=n; s['players'][owner]['resources'][r]+=n


def rate(s,owner,r):
    rates=[4]
    for p in topology(s)['ports']:
        if any(building(s,v) and building(s,v)['owner']==owner for v in topology(s)['edges'][p['edge']]['ends']):
            if p['type']=='any': rates.append(3)
            if p['type']==r: rates.append(2)
    return min(rates)


def awards(s):
    geometry=topology(s); vertices=geometry['vertices']; edges=geometry['edges']
    for owner,p in enumerate(s['players']):
        owned={int(e) for e,o in s['roads'].items() if o==owner}
        def walk(v,used):
            if used and building(s,v) and building(s,v)['owner']!=owner: return len(used)
            return max([len(used)]+[walk(next(w for w in edges[e]['ends'] if w!=v),used|{e}) for e in vertices[v]['edges'] if e in owned and e not in used])
        p['longest']=max((walk(v,set()) for v in range(len(vertices))),default=0)
    for key,stat,threshold in [('longest','longest',5),('army','knights',3)]:
        best=max(p[stat] for p in s['players']); leaders=[i for i,p in enumerate(s['players']) if p[stat]==best]
        s[key]=None if best<threshold else s[key] if s[key] in leaders else leaders[0] if len(leaders)==1 else None
    for i,p in enumerate(s['players']):
        p['vp']=sum(2 if b['kind']=='city' else 1 for b in s['buildings'].values() if b['owner']==i)+2*(s['longest']==i)+2*(s['army']==i)
    p=s['players'][s['current']]
    if s['phase']!='special-build' and p['vp']+sum(d['kind']=='victory' for d in p['dev'])>=10:
        s['winner']=s['current']; s['phase']='finished'; s['offers']=[]


def resource_bag(value):
    require(isinstance(value,dict) and set(value)<=set(RESOURCES), 'Invalid resource selection.')
    require(all(type(n) is int and 0<=n<=24 for n in value.values()), 'Invalid resource amount.')
    return {r:value.get(r,0) for r in RESOURCES}


def action(s,owner,data,rng=None):
    """Mutates a transaction-local state. Caller commits only on success."""
    rng=rng or secrets.SystemRandom()
    kind=data.get('type'); p=s['players'][owner]
    initial_phase=s['phase']
    before_resources=[q['resources'].copy() for q in s['players']]
    require(s['winner'] is None and s['phase']!='finished','This game has ended.')
    if kind=='special-build-flag':
        require(s.get('map')=='base-56' and s['phase'] in ('roll','build','free-road','discard','robber','steal') and
                owner!=s['current'], 'Special building can be requested during another player\'s turn.')
        flags=s.setdefault('specialFlags',[])
        if owner in flags: flags.remove(owner)
        else: flags.append(owner)
    elif kind=='discard':
        d=next((d for d in s['discard'] if d['owner']==owner),None)
        r=data.get('resource')
        require(s['phase']=='discard' and d and r in RESOURCES and p['resources'][r]>0,'You cannot discard that card.')
        p['resources'][r]-=1; s['bank'][r]+=1; d['left']-=1
        s['discard']=[d for d in s['discard'] if d['left']]
        if not s['discard']: s['phase']='robber'
    elif kind in ('accept-trade','reject-trade','counter-trade','confirm-trade','cancel-trade','embargo'):
        require(s['phase']=='build','Trading is available after rolling.')
        active=s['current']; sender=s['players'][active]
        def blocked(a,b):
            embargo=s.get('embargo',{})
            return b in embargo.get(str(a),[]) or a in embargo.get(str(b),[])
        def sync_rejected():
            for candidate in s['offers']:
                for seat in range(len(s['players'])):
                    if seat!=active and blocked(active,seat):
                        candidate.setdefault('responses',{})[str(seat)]='rejected'
                if all(candidate.get('responses',{}).get(str(seat))=='rejected'
                       for seat in range(len(s['players'])) if seat!=active):
                    candidate['allRejected']=True
        if kind=='embargo':
            target=data.get('target')
            require(type(target) is int and 0<=target<len(s['players']) and target!=owner,'Choose another player.')
            embargo=s.setdefault('embargo',{}); targets=embargo.setdefault(str(owner),[])
            if target in targets: targets.remove(target)
            else:
                targets.append(target)
                for o in s['offers']:
                    if active in (owner,target):o.setdefault('responses',{})[str(target if owner==active else owner)]='rejected'
        elif kind=='cancel-trade':
            offer=next((o for o in s['offers'] if o['id']==data.get('offer')),None)
            require(owner==active or offer and offer.get('author',active)==owner,'You cannot cancel this offer.')
            if owner==active and (offer is None or offer.get('author',active)==active): s['offers']=[]
            else:s['offers']=[o for o in s['offers'] if o['id']!=offer['id']]
        else:
            offer=next((o for o in s['offers'] if o['id']==data.get('offer')),None)
            require(offer is not None,'This offer is no longer available.')
            require(not offer.get('allRejected'),'Everyone declined this offer.')
            if kind=='confirm-trade':
                target=data.get('target')
                require(owner==active and type(target) is int and 0<=target<len(s['players']) and target!=active,'Only the current player can complete a trade.')
                require(offer.get('responses',{}).get(str(target))=='accepted' and not blocked(active,target),'This player has not accepted the trade.')
                recipient=s['players'][target]
                require(sum(offer['give'].values()) and sum(offer['want'].values()),'Resolve the open-ended offer first.')
                require(all(sender['resources'][r]>=offer['give'][r] and recipient['resources'][r]>=offer['want'][r] for r in RESOURCES),'A player no longer has these cards.')
                for r in RESOURCES:
                    delta=offer['give'][r]-offer['want'][r];recipient['resources'][r]+=delta;sender['resources'][r]-=delta
                s['offers']=[]
            elif kind=='counter-trade':
                require(owner!=active and not blocked(active,owner),'You cannot counter this trade.')
                # Counter input is from its author's perspective; all stored offers
                # use the active player's perspective so others can join them.
                counter_give,counter_want=resource_bag(data.get('give')),resource_bag(data.get('want'))
                require(sum(counter_give.values()) and sum(counter_want.values()) and all(not(counter_give[r] and counter_want[r]) and p['resources'][r]>=counter_give[r] for r in RESOURCES),'Choose an affordable counteroffer with different resources.')
                s['offers']=[o for o in s['offers'] if o.get('author',active)!=owner]
                s['offers'].append(dict(id=secrets.token_hex(8),give=counter_want,want=counter_give,author=owner,responses={str(owner):'accepted'}))
            else:
                require(owner!=active and not blocked(active,owner),'You cannot respond to this trade.')
                if kind=='accept-trade':
                    require(sum(offer['give'].values()) and sum(offer['want'].values()),'Choose specific resources with a counteroffer first.')
                    require(all(p['resources'][r]>=offer['want'][r] for r in RESOURCES),'You do not have the requested cards.')
                offer.setdefault('responses',{})[str(owner)]='accepted' if kind=='accept-trade' else 'rejected'
        sync_rejected()
    else:
        require(owner==s['current'],'It is not your turn.')
        if kind=='build':
            piece=data.get('piece'); target=data.get('target')
            require(type(target) is int and piece in ('road','settlement','city') and target in legal(s,piece),'Choose a legal building location.')
            require(p[piece]>0,'No pieces remaining.')
            setup=s['phase'].startswith('setup'); free=s['phase']=='free-road'
            if not setup and not free: pay(s,owner,piece)
            p[piece]-=1
            if piece=='road': s['roads'][str(target)]=owner
            else:
                s['buildings'][str(target)]=dict(owner=owner,kind=piece)
                if piece=='city': p['settlement']+=1
            if setup and piece=='settlement':
                s['anchor']=target; s['phase']='setup-road'
                if s['setup']>=len(s['players']):
                    for t in topology(s)['vertices'][target]['tiles']:
                        r=s['tiles'][t]['type']
                        if r in RESOURCES: give(s,owner,r,1)
            elif setup:
                s['setup']+=1; s['anchor']=None; n=len(s['players'])
                order=[(s.get('startSeat',0)+offset)%n for offset in range(n)]
                s['current']=(order+list(reversed(order)))[s['setup']] if s['setup']<n*2 else order[0]
                s['phase']='setup-settlement' if s['setup']<n*2 else 'roll'
            elif free:
                s['freeRoads']-=1
                if not s['freeRoads'] or not p['road'] or not legal(s,'road'): s['phase']=s['robberReturn']
        elif kind=='roll':
            require(s['phase']=='roll','You cannot roll now.')
            s['dice']=[rng.randint(1,6),rng.randint(1,6)]; roll=sum(s['dice'])
            if 'rolls' not in s:
                s['rolls']=[];s['rollHistoryPartial']=True
            s['rolls'].append(dict(player=owner,dice=s['dice'].copy()))
            if roll==7:
                s['discard']=[dict(owner=i,left=total(q)//2) for i,q in enumerate(s['players']) if total(q)>7]
                s['phase']='discard' if s['discard'] else 'robber'; s['robberReturn']='build'
            else:
                demand=[bag() for _ in s['players']]
                for t in s['tiles']:
                    if t['number']!=roll or t['id']==s['robber']: continue
                    for v in t['corners']:
                        b=building(s,v)
                        if b: demand[b['owner']][t['type']]+=2 if b['kind']=='city' else 1
                for r in RESOURCES:
                    recipients=[(i,d[r]) for i,d in enumerate(demand) if d[r]]
                    if sum(n for _,n in recipients)<=s['bank'][r] or len(recipients)==1:
                        for i,n in recipients: give(s,i,r,n)
                s['phase']='build'
        elif kind=='robber':
            tid=data.get('target')
            require(s['phase']=='robber' and type(tid) is int and 0<=tid<len(s['tiles']) and tid!=s['robber'],'Choose a different tile.')
            s['robber']=tid
            s['victims']=list({building(s,v)['owner'] for v in topology(s)['tiles'][tid]['corners'] if building(s,v) and building(s,v)['owner']!=owner and total(s['players'][building(s,v)['owner']])})
            s['phase']='steal' if s['victims'] else s['robberReturn']
        elif kind=='steal':
            victim=data.get('target')
            require(s['phase']=='steal' and type(victim) is int and victim in s['victims'],'Choose an eligible player.')
            q=s['players'][victim]; cards=[r for r in RESOURCES for _ in range(q['resources'][r])]
            r=rng.choice(cards); q['resources'][r]-=1; p['resources'][r]+=1
            s['victims']=[]; s['phase']=s['robberReturn']
        elif kind=='bank-trade':
            a,b=data.get('give'),data.get('receive')
            require(s['phase']=='build','Roll before trading.')
            if isinstance(a,str) and isinstance(b,str):
                require(a in RESOURCES and b in RESOURCES and a!=b,'Invalid bank trade.')
                outgoing=bag();incoming=bag();outgoing[a]=rate(s,owner,a);incoming[b]=1
            else:outgoing,incoming=resource_bag(a),resource_bag(b)
            credits=sum(n//rate(s,owner,r) for r,n in outgoing.items())
            require(credits>0 and credits==sum(incoming.values()) and all(n%rate(s,owner,r)==0 for r,n in outgoing.items()),'Match your bank or port rates to the cards received.')
            require(all(not(outgoing[r] and incoming[r]) and p['resources'][r]>=outgoing[r] and s['bank'][r]>=incoming[r] for r in RESOURCES),'Not enough cards or invalid bank trade.')
            for r in RESOURCES:
                p['resources'][r]+=incoming[r]-outgoing[r];s['bank'][r]+=outgoing[r]-incoming[r]
        elif kind=='offer':
            require(s['phase']=='build','Roll before trading.')
            give_bag,want=resource_bag(data.get('give')),resource_bag(data.get('want'))
            require((sum(give_bag.values()) or sum(want.values())) and all(not(give_bag[r] and want[r]) and p['resources'][r]>=give_bag[r] for r in RESOURCES),'Choose an affordable trade with different resources.')
            s['offers']=[dict(id=secrets.token_hex(8),give=give_bag,want=want,author=owner,responses={})]
            for seat in range(len(s['players'])):
                if seat!=owner and (seat in s.get('embargo',{}).get(str(owner),[]) or
                                    owner in s.get('embargo',{}).get(str(seat),[])):
                    s['offers'][0]['responses'][str(seat)]='rejected'
            if all(s['offers'][0]['responses'].get(str(seat))=='rejected'
                   for seat in range(len(s['players'])) if seat!=owner):
                s['offers'][0]['allRejected']=True
        elif kind=='buy-development':
            require(s['phase'] in ('build','special-build') and s['deck'],'Development cards are unavailable.')
            pay(s,owner,'development'); p['dev'].append(dict(kind=s['deck'].pop(),bought=s['turn']))
        elif kind=='play-development':
            card=data.get('card'); require(s['phase'] in ('roll','build') and not s['playedDev'],'Play one development card per turn.')
            d=next((d for d in p['dev'] if d['kind']==card and d['bought']<s['turn']),None)
            require(d is not None and card!='victory','That card cannot be played now.')
            s['robberReturn']=s['phase']
            if card=='knight': p['knights']+=1; s['phase']='robber'
            elif card=='roadbuilding':
                old=s['phase']; s['phase']='free-road'
                require(p['road']>0 and legal(s,'road'),'No legal roads available.')
                s['freeRoads']=min(2,p['road']); s['robberReturn']=old
            elif card=='monopoly':
                r=data.get('resource'); require(r in RESOURCES,'Choose a resource.')
                for i,q in enumerate(s['players']):
                    if i!=owner: p['resources'][r]+=q['resources'][r]; q['resources'][r]=0
            elif card=='plenty':
                chosen=resource_bag(data.get('resources'))
                require(sum(chosen.values())==min(2,sum(s['bank'].values())) and all(n<=s['bank'][r] for r,n in chosen.items()),'Choose up to two available bank cards.')
                for r,n in chosen.items(): give(s,owner,r,n)
            else: raise Invalid('Unknown development card.')
            p['dev'].remove(d); s['playedDev']=True
        elif kind=='end':
            require(s['phase'] in ('build','special-build'),'Finish your turn actions first.')
            if s['phase']=='special-build':
                queue=s['specialQueue']
                if queue:
                    s['current']=queue.pop(0)
                else:
                    s['current']=s['specialNext']
                    s['phase']='roll'; s['turn']+=1; s['playedDev']=False; s['specialNext']=None
            else:
                following=(owner+1)%len(s['players'])
                flags=s.get('specialFlags',[]) if s.get('map')=='base-56' else []
                queue=[i for offset in range(1,len(s['players']))
                       if (i:=(owner+offset)%len(s['players'])) in flags]
                s['specialFlags']=[]
                if queue:
                    s['current']=queue.pop(0); s['specialQueue']=queue
                    s['specialNext']=following; s['phase']='special-build'
                else:
                    s['current']=following; s['turn']+=1; s['phase']='roll'; s['playedDev']=False
            s['offers']=[]
        else: raise Invalid('Unknown game action.')
    awards(s)
    descriptions={'build':'placed a '+str(data.get('piece','piece')), 'roll':'rolled '+str(sum(s['dice'] or [])), 'bank-trade':'traded with the bank', 'buy-development':'bought a development card', 'play-development':'played '+str(data.get('card','a card')), 'robber':'moved the robber', 'steal':'stole a card', 'discard':'discarded a card', 'offer':'offered a trade', 'accept-trade':'accepted an offer; awaiting confirmation', 'confirm-trade':'completed a trade', 'reject-trade':'declined a trade', 'counter-trade':'proposed a counteroffer', 'embargo':'updated trade preferences', 'cancel-trade':'cancelled the offer', 'special-build-flag':'updated their special build request', 'end':'ended their turn'}
    entry=p['name']+' '+(f"stole a card from {s['players'][data['target']]['name']}" if kind=='steal'
                         else descriptions.get(kind,kind))
    # Production, initial placement, and completed trades are public. A robber
    # steal or discard must not reveal the card type through the shared log.
    public_gains=kind in ('roll','bank-trade','confirm-trade') or (kind=='build' and initial_phase.startswith('setup') and data.get('piece')=='settlement') or (kind=='play-development' and data.get('card') in ('plenty','monopoly'))
    if public_gains:
        gains=[]
        for i,q in enumerate(s['players']):
            cards=[f"{q['resources'][r]-before_resources[i][r]} {r}" for r in RESOURCES if q['resources'][r]>before_resources[i][r]]
            if cards:gains.append(q['name']+' received '+', '.join(cards))
        if gains:entry+=' · '+'; '.join(gains)
    s['log']=(s['log']+[entry])[-80:]


def view(s,seat):
    public=copy.deepcopy(s); public['deckCount']=len(public.pop('deck'))
    public['ports']=topology(s)['ports']
    public['legal']={k:legal(s,k) if seat==s['current'] else [] for k in ('road','settlement','city')}
    for i,p in enumerate(public['players']):
        p['cardCount']=total(p); p['devCount']=len(p['dev'])
        if i!=seat:
            p['resources']=None; p['dev']=None
        else:
            p['totalVP']=p['vp']+sum(d['kind']=='victory' for d in p['dev'])
        if s['winner'] is not None:
            p['totalVP']=s['players'][i]['vp']+sum(d['kind']=='victory' for d in s['players'][i]['dev'])
    return public
