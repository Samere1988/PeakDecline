"""Cities & Knights rules, isolated from the base-game engine."""

import secrets
import copy
import sys

from app import catan_rules as base
from app import catan_progress as progress

COMMODITIES = ('paper', 'cloth', 'coin')
CITY_OUTPUT = {'wood': 'paper', 'sheep': 'cloth', 'ore': 'coin'}
EVENT_FACES = ('barbarian', 'barbarian', 'barbarian', 'science', 'trade', 'politics')
BARBARIAN_SHORE = 7
IMPROVEMENT_COMMODITY = {'science': 'paper', 'trade': 'cloth', 'politics': 'coin'}
KNIGHT_COST = {'sheep': 1, 'ore': 1}


def create(names, rng=None, map_id='base'):
    game = base.create(names, rng, map_id=map_id)
    game['mode'] = 'cities-knights'
    game['commodityBank'] = {kind: 18 if map_id == 'base-56' else 12 for kind in COMMODITIES}
    game['eventDie'] = None
    game['barbarianPosition'] = 0
    game['barbarianAttacks'] = 0
    game['pendingRoll'] = None
    game['knightPieces'] = {}
    game['metropolises'] = {}
    game['barbarianLosses'] = []
    game['defenderRewards'] = []
    game['aqueductChoices'] = []
    game['displacedKnight'] = None
    game['progressDecks'] = progress.decks(rng or secrets.SystemRandom())
    game['progressQueue'] = []
    game['progressOverflow'] = None
    game['progressResume'] = None
    game['progressPending'] = None
    game['pendingAlchemy'] = None
    game['harborTargets'] = []
    game['merchant'] = None
    game['merchantFleet'] = []
    # Development cards and Largest Army are replaced by expansion systems.
    game['deck'] = []
    game['army'] = None
    for player in game['players']:
        player['commodities'] = {kind: 0 for kind in COMMODITIES}
        player['improvements'] = dict.fromkeys(IMPROVEMENT_COMMODITY, 0)
        player['defenderVP'] = 0
        player['progress'] = []
        player['progressVP'] = []
    return game


def legal_starting_cities(game):
    """Use the base distance rule for the second starting placement."""
    if game['phase'] != 'setup-city':
        return []
    return base.legal({**game, 'phase': 'setup-settlement'}, 'settlement')


def place_starting_city(game, owner, target):
    base.require(game['phase'] == 'setup-city' and owner == game['current'], 'Place your starting city now.')
    base.require(type(target) is int and target in legal_starting_cities(game), 'Choose a legal city location.')
    player = game['players'][owner]
    base.require(player['city'] > 0, 'No cities remaining.')
    player['city'] -= 1
    game['buildings'][str(target)] = {'owner': owner, 'kind': 'city'}
    game['anchor'] = target
    game['phase'] = 'setup-road'
    gains = []
    for tile_id in base.topology(game)["vertices"][target]['tiles']:
        resource = game['tiles'][tile_id]['type']
        if resource in base.RESOURCES:
            base.give(game, owner, resource, 1)
            gains.append(resource)
    base.awards(game)
    entry = player['name'] + ' placed a city'
    if gains:
        entry += ' · ' + player['name'] + ' received ' + ', '.join('1 ' + resource for resource in gains)
    game['log'] = (game['log'] + [entry])[-80:]


def setup_action(game, owner, piece, target):
    """Advance the normal snake order, replacing each second settlement by a city."""
    base.require(game.get('mode') == 'cities-knights', 'Not a Cities & Knights game.')
    if game['phase'] == 'setup-city':
        base.require(piece == 'city', 'Place a city on your second setup turn.')
        place_starting_city(game, owner, target)
    else:
        base.require(game['phase'] in ('setup-settlement', 'setup-road'), 'Setup is complete.')
        base.action(game, owner, {'type': 'build', 'piece': piece, 'target': target})
        if game['phase'] == 'setup-settlement' and game['setup'] >= len(game['players']):
            game['phase'] = 'setup-city'


def produce(game, dice_total):
    """Resolve the resource and commodity portion of one non-seven roll."""
    base.require(game.get('mode') == 'cities-knights', 'Not a Cities & Knights game.')
    base.require(type(dice_total) is int and 2 <= dice_total <= 12 and dice_total != 7, 'Choose a non-seven dice total.')
    resources = [base.bag() for _ in game['players']]
    commodities = [{kind: 0 for kind in COMMODITIES} for _ in game['players']]
    for tile in game['tiles']:
        if tile['number'] != dice_total or tile['id'] == game['robber']:
            continue
        resource = tile['type']
        for vertex in tile['corners']:
            building = base.building(game, vertex)
            if not building:
                continue
            owner = building['owner']
            if building['kind'] == 'city':
                resources[owner][resource] += 1 if resource in CITY_OUTPUT else 2
                if resource in CITY_OUTPUT:
                    commodities[owner][CITY_OUTPUT[resource]] += 1
            else:
                resources[owner][resource] += 1
    for resource in base.RESOURCES:
        recipients = [(i, demand[resource]) for i, demand in enumerate(resources) if demand[resource]]
        if sum(amount for _, amount in recipients) <= game['bank'][resource] or len(recipients) == 1:
            for owner, amount in recipients:
                base.give(game, owner, resource, amount)
    for kind in COMMODITIES:
        recipients = [(i, demand[kind]) for i, demand in enumerate(commodities) if demand[kind]]
        available = game['commodityBank'][kind]
        if sum(amount for _, amount in recipients) <= available or len(recipients) == 1:
            for owner, amount in recipients:
                given = min(amount, game['commodityBank'][kind])
                game['commodityBank'][kind] -= given
                game['players'][owner]['commodities'][kind] += given


def card_total(player):
    return base.total(player) + sum(player['commodities'].values())


def trade_rate(game, owner, kind):
    rates = [4]
    for port in base.topology(game)['ports']:
        if any((building := base.building(game, vertex)) and building['owner'] == owner
               for vertex in base.topology(game)["edges"][port['edge']]['ends']):
            if port['type'] == 'any':
                rates.append(3)
            if port['type'] == kind:
                rates.append(2)
    if kind in COMMODITIES and game['players'][owner]['improvements']['trade'] >= 3:
        rates.append(2)
    merchant = game['merchant']
    if merchant and merchant['owner'] == owner and game['tiles'][merchant['tile']]['type'] == kind:
        rates.append(2)
    if any(fleet['owner'] == owner and fleet['turn'] == game['turn'] and fleet['kind'] == kind
           for fleet in game['merchantFleet']):
        rates.append(2)
    return min(rates)


def bank_trade(game, owner, data):
    base.require(game['phase'] == 'build', 'Roll before trading.')
    kinds = (*base.RESOURCES, *COMMODITIES)
    outgoing, incoming = data.get('give'), data.get('receive')
    base.require(isinstance(outgoing, dict) and isinstance(incoming, dict) and
                 set(outgoing) <= set(kinds) and set(incoming) <= set(kinds) and
                 all(type(amount) is int and 0 <= amount <= 76 for amount in
                     (*outgoing.values(), *incoming.values())), 'Choose valid trade cards.')
    outgoing = {kind: outgoing.get(kind, 0) for kind in kinds}
    incoming = {kind: incoming.get(kind, 0) for kind in kinds}
    credits = sum(amount // trade_rate(game, owner, kind) for kind, amount in outgoing.items())
    base.require(credits > 0 and credits == sum(incoming.values()) and
                 all(amount % trade_rate(game, owner, kind) == 0 for kind, amount in outgoing.items()),
                 'Match the available bank and port trade rates.')
    for kind in kinds:
        hand = game['players'][owner]['resources'] if kind in base.RESOURCES else game['players'][owner]['commodities']
        bank = game['bank'] if kind in base.RESOURCES else game['commodityBank']
        base.require(not (outgoing[kind] and incoming[kind]) and hand[kind] >= outgoing[kind] and
                     bank[kind] >= incoming[kind], 'These cards are unavailable.')
    for kind in kinds:
        hand = game['players'][owner]['resources'] if kind in base.RESOURCES else game['players'][owner]['commodities']
        bank = game['bank'] if kind in base.RESOURCES else game['commodityBank']
        hand[kind] += incoming[kind] - outgoing[kind]
        bank[kind] += outgoing[kind] - incoming[kind]


def trade_bag(value):
    kinds = (*base.RESOURCES, *COMMODITIES)
    base.require(isinstance(value, dict) and set(value) <= set(kinds) and
                 all(type(amount) is int and 0 <= amount <= 19 for amount in value.values()),
                 'Choose valid resources or commodities.')
    return {kind: value.get(kind, 0) for kind in kinds}


def player_trade(game, owner, kind, data):
    """Negotiate one turn's offers using resources and commodities only."""
    base.require(game['phase'] == 'build', 'Trading is available after rolling.')
    active = game['current']
    kinds = (*base.RESOURCES, *COMMODITIES)
    def amount(seat, card):
        hand = ('resources' if card in base.RESOURCES else 'commodities')
        return game['players'][seat][hand][card]

    def blocked(a, b):
        embargo = game.get('embargo', {})
        return b in embargo.get(str(a), []) or a in embargo.get(str(b), [])

    def sync_rejected():
        for candidate in game['offers']:
            for seat in range(len(game['players'])):
                if seat != active and blocked(active, seat):
                    candidate.setdefault('responses', {})[str(seat)] = 'rejected'
            if all(candidate.get('responses', {}).get(str(seat)) == 'rejected'
                   for seat in range(len(game['players'])) if seat != active):
                candidate['allRejected'] = True

    if kind == 'embargo':
        target = data.get('target')
        base.require(type(target) is int and 0 <= target < len(game['players']) and target != owner,
                     'Choose another player.')
        targets = game.setdefault('embargo', {}).setdefault(str(owner), [])
        if target in targets:
            targets.remove(target)
        else:
            targets.append(target)
            if active in (owner, target):
                respondent = target if owner == active else owner
                for offer in game['offers']:
                    offer.setdefault('responses', {})[str(respondent)] = 'rejected'
        sync_rejected()
        return

    if kind == 'offer':
        base.require(owner == active, 'It is not your turn.')
        give, want = trade_bag(data.get('give')), trade_bag(data.get('want'))
        base.require((sum(give.values()) or sum(want.values())) and
                     all(not (give[card] and want[card]) and amount(owner, card) >= give[card]
                         for card in kinds), 'Choose an affordable trade with different cards.')
        game['offers'] = [dict(id=secrets.token_hex(8), give=give, want=want,
                               author=owner, responses={})]
        sync_rejected()
        return

    offer = next((offer for offer in game['offers'] if offer['id'] == data.get('offer')), None)
    if kind == 'cancel-trade':
        base.require(owner == active or (offer and offer.get('author', active) == owner),
                     'You cannot cancel this offer.')
        if owner == active and (offer is None or offer.get('author', active) == active):
            game['offers'] = []
        else:
            game['offers'] = [item for item in game['offers'] if item['id'] != offer['id']]
        return

    base.require(offer is not None, 'This offer is no longer available.')
    base.require(not offer.get('allRejected'), 'Everyone declined this offer.')
    if kind == 'confirm-trade':
        target = data.get('target')
        base.require(owner == active and type(target) is int and
                     0 <= target < len(game['players']) and target != active,
                     'Only the current player can complete a trade.')
        base.require(offer.get('responses', {}).get(str(target)) == 'accepted' and
                     not blocked(active, target), 'This player has not accepted the trade.')
        base.require(sum(offer['give'].values()) and sum(offer['want'].values()),
                     'Resolve the open-ended offer first.')
        base.require(all(amount(active, card) >= offer['give'][card] and
                         amount(target, card) >= offer['want'][card] for card in kinds),
                     'A player no longer has these cards.')
        for card in kinds:
            hand = 'resources' if card in base.RESOURCES else 'commodities'
            delta = offer['give'][card] - offer['want'][card]
            game['players'][target][hand][card] += delta
            game['players'][active][hand][card] -= delta
        game['offers'] = []
    elif kind == 'counter-trade':
        base.require(owner != active and not blocked(active, owner),
                     'You cannot counter this trade.')
        give, want = trade_bag(data.get('give')), trade_bag(data.get('want'))
        base.require(sum(give.values()) and sum(want.values()) and
                     all(not (give[card] and want[card]) and amount(owner, card) >= give[card]
                         for card in kinds), 'Choose an affordable counteroffer with different cards.')
        game['offers'] = [item for item in game['offers'] if item.get('author', active) != owner]
        game['offers'].append(dict(id=secrets.token_hex(8), give=want, want=give,
                                   author=owner, responses={str(owner): 'accepted'}))
        sync_rejected()
    else:
        base.require(owner != active and not blocked(active, owner),
                     'You cannot respond to this trade.')
        if kind == 'accept-trade':
            base.require(sum(offer['give'].values()) and sum(offer['want'].values()),
                         'Choose specific cards with a counteroffer first.')
            base.require(all(amount(owner, card) >= offer['want'][card] for card in kinds),
                         'You do not have the requested cards.')
        offer.setdefault('responses', {})[str(owner)] = (
            'accepted' if kind == 'accept-trade' else 'rejected')
        sync_rejected()


def discard_limit(game, owner):
    walls = sum(bool(building.get('wall')) for building in game['buildings'].values()
                if building['owner'] == owner and building['kind'] == 'city')
    return 7 + 2 * walls


def pay_resources(game, owner, cost):
    hand = game['players'][owner]['resources']
    base.require(all(hand[kind] >= amount for kind, amount in cost.items()), 'Not enough resources.')
    for kind, amount in cost.items():
        hand[kind] -= amount
        game['bank'][kind] += amount


def player_cities(game, owner, vulnerable=False):
    return [int(vertex) for vertex, building in game['buildings'].items()
            if building['owner'] == owner and building['kind'] == 'city' and
            (not vulnerable or not building.get('metropolis'))]


def knight_strengths(game):
    return [sum(knight['level'] for knight in game['knightPieces'].values()
                if knight['owner'] == owner and knight['active'])
            for owner in range(len(game['players']))]


def road_length(game, owner):
    owned = {int(edge) for edge, player in game['roads'].items() if player == owner}

    def walk(vertex, used):
        building = base.building(game, vertex)
        knight = game['knightPieces'].get(str(vertex))
        if used and ((building and building['owner'] != owner) or
                     (knight and knight['owner'] != owner)):
            return len(used)
        lengths = [len(used)]
        for edge in base.topology(game)["vertices"][vertex]['edges']:
            if edge in owned and edge not in used:
                other = next(v for v in base.topology(game)["edges"][edge]['ends'] if v != vertex)
                lengths.append(walk(other, used | {edge}))
        return max(lengths)

    return max((walk(vertex, set()) for vertex in range(len(base.topology(game)["vertices"]))), default=0)


def awards(game):
    """Recalculate expansion points without the base game's Largest Army."""
    for owner, player in enumerate(game['players']):
        player['longest'] = road_length(game, owner)
    best = max(player['longest'] for player in game['players'])
    leaders = [owner for owner, player in enumerate(game['players']) if player['longest'] == best]
    game['longest'] = (None if best < 5 else game['longest'] if game['longest'] in leaders
                       else leaders[0] if len(leaders) == 1 else None)
    game['army'] = None
    for owner, player in enumerate(game['players']):
        buildings = sum(2 if building['kind'] == 'city' else 1
                        for building in game['buildings'].values() if building['owner'] == owner)
        metropolises = sum(building.get('metropolis') is not None
                           for building in game['buildings'].values() if building['owner'] == owner)
        player['vp'] = (buildings + 2 * metropolises + 2 * (game['longest'] == owner) +
                        player['defenderVP'] + len(player['progressVP']) +
                        int(game['merchant'] is not None and game['merchant']['owner'] == owner))
    if game['phase'] != 'special-build' and game['players'][game['current']]['vp'] >= 13:
        game['winner'] = game['current']
        game['phase'] = 'finished'
        game['offers'] = []


def knight_reach(game, owner, start):
    """Intersections reachable on this player's continuous roads."""
    reached = {start}
    frontier = [start]
    while frontier:
        vertex = frontier.pop()
        for edge in base.topology(game)["vertices"][vertex]['edges']:
            if base.road(game, edge) != owner:
                continue
            other = next(v for v in base.topology(game)["edges"][edge]['ends'] if v != vertex)
            building = base.building(game, other)
            knight = game['knightPieces'].get(str(other))
            if other in reached or (building and building['owner'] != owner):
                continue
            reached.add(other)
            if not knight or knight['owner'] == owner:
                frontier.append(other)
    return reached


def knight_destinations(game, owner, start, level, displacement=False):
    return [vertex for vertex in knight_reach(game, owner, start) if vertex != start and
            not base.building(game, vertex) and
            (not (other := game['knightPieces'].get(str(vertex))) or
             (not displacement and other['owner'] != owner and level > other['level']))]


def finish_attack(game):
    """Return the ship and resolve the saved production dice after battle choices."""
    game['barbarianPosition'] = 0
    game['barbarianAttacks'] += 1
    for knight in game['knightPieces'].values():
        knight['active'] = False
    game['barbarianLosses'] = []
    awards(game)
    if game['winner'] is not None:
        game['pendingRoll'] = None
    elif game['defenderRewards']:
        # A tie grants progress-card choices before the numbered dice resolve.
        game['phase'] = 'defender-reward'
    else:
        finish_numbered_dice(game)


def pillage(game, owner, target):
    base.require(type(target) is int and target in player_cities(game, owner, vulnerable=True),
                 'Choose one of your unprotected cities.')
    player = game['players'][owner]
    building = game['buildings'][str(target)]
    building.pop('wall', None)
    building['kind'] = 'settlement'
    if player['settlement']:
        player['settlement'] -= 1
        player['city'] += 1
    else:
        building['damagedCity'] = True
    game['log'] = (game['log'] + [player['name'] + ' lost a city to the barbarians'])[-80:]


def begin_attack(game):
    barbarians = sum(building['kind'] == 'city' for building in game['buildings'].values())
    strengths = knight_strengths(game)
    defenders = sum(strengths)
    game['lastBarbarianBattle'] = {'barbarians': barbarians, 'defenders': defenders,
                                   'contributions': strengths.copy()}
    if defenders >= barbarians:
        best = max(strengths)
        leaders = [owner for owner, strength in enumerate(strengths) if strength == best]
        if len(leaders) == 1:
            game['players'][leaders[0]]['defenderVP'] += 1
            game['log'] = (game['log'] + [game['players'][leaders[0]]['name'] +
                                          ' defended Catan'])[-80:]
        else:
            # The progress-card implementation will fulfill these choices.
            current = game['current']
            game['defenderRewards'].extend(sorted(leaders, key=lambda owner: (owner - current) % len(strengths)))
        finish_attack(game)
        return
    candidates = [owner for owner in range(len(strengths)) if player_cities(game, owner, vulnerable=True)]
    if not candidates:
        finish_attack(game)
        return
    weakest = min(strengths[owner] for owner in candidates)
    game['barbarianLosses'] = [owner for owner in candidates if strengths[owner] == weakest]
    game['phase'] = 'barbarian-loss'


def legal_road(game, owner, target):
    if target not in base.legal(game, 'road'):
        return False
    for vertex in base.topology(game)["edges"][target]['ends']:
        building = base.building(game, vertex)
        knight = game['knightPieces'].get(str(vertex))
        if (building and building['owner'] != owner) or (knight and knight['owner'] != owner):
            continue
        if (building and building['owner'] == owner) or any(
                base.road(game, edge) == owner for edge in base.topology(game)["vertices"][vertex]['edges']):
            return True
    return False


def build_piece(game, owner, piece, target, cost=None):
    base.require(game['phase'] in ('build', 'free-road', 'special-build') and type(target) is int and
                 piece in ('road', 'settlement', 'city') and
                 target in base.legal(game, piece), 'Choose a legal building location.')
    base.require(game['phase'] != 'free-road' or piece == 'road', 'Place a free road.')
    if piece == 'road':
        base.require(legal_road(game, owner, target), 'An opponent blocks this road.')
    if piece == 'settlement':
        base.require(str(target) not in game['knightPieces'], 'A knight occupies this intersection.')
    player = game['players'][owner]
    damaged = [vertex for vertex, building in game['buildings'].items()
               if building['owner'] == owner and building.get('damagedCity')]
    if piece == 'city' and damaged:
        base.require(str(target) in damaged, 'Restore your pillaged city first.')
    if piece != 'city' or not damaged:
        base.require(player[piece] > 0, 'No pieces remaining.')
    if game['phase'] != 'free-road':
        pay_resources(game, owner, base.COSTS[piece] if cost is None else cost)
    if piece == 'road':
        player['road'] -= 1
        game['roads'][str(target)] = owner
    elif piece == 'settlement':
        player['settlement'] -= 1
        game['buildings'][str(target)] = {'owner': owner, 'kind': 'settlement'}
    else:
        building = game['buildings'][str(target)]
        building['kind'] = 'city'
        if damaged:
            building.pop('damagedCity')
        else:
            player['city'] -= 1
            player['settlement'] += 1
    if game['phase'] == 'free-road':
        game['freeRoads'] -= 1
        if (not game['freeRoads'] or not player['road'] or
                not any(legal_road(game, owner, edge['id']) for edge in base.topology(game)["edges"])):
            game['phase'] = 'build'


def build_wall(game, owner, target, free=False):
    base.require(game['phase'] in ('build', 'special-build') and type(target) is int and
                 target in player_cities(game, owner), 'Choose one of your cities.')
    building = game['buildings'][str(target)]
    base.require(not building.get('wall'), 'This city already has a wall.')
    base.require(sum(bool(entry.get('wall')) for entry in game['buildings'].values()
                     if entry['owner'] == owner) < 3, 'You have placed all three city walls.')
    if not free:
        pay_resources(game, owner, {'brick': 2})
    building['wall'] = True


def improve_city(game, owner, discipline, target, discount=0):
    base.require(game['phase'] in ('build', 'special-build') and discipline in IMPROVEMENT_COMMODITY,
                 'Choose a city improvement.')
    player = game['players'][owner]
    base.require(player_cities(game, owner), 'You need a city to improve.')
    level = player['improvements'][discipline]
    base.require(level < 5, 'This improvement is complete.')
    commodity = IMPROVEMENT_COMMODITY[discipline]
    cost = max(0, level + 1 - discount)
    base.require(player['commodities'][commodity] >= cost, 'Not enough commodities.')
    holder = game['metropolises'].get(discipline)
    claim = level + 1 >= 4 and (holder is None or
                                (holder['owner'] != owner and level + 1 >
                                 game['players'][holder['owner']]['improvements'][discipline]))
    free_cities = [vertex for vertex in player_cities(game, owner)
                   if not game['buildings'][str(vertex)].get('metropolis')]
    if level + 1 == 4 and holder is None or claim:
        base.require(type(target) is int and target in free_cities,
                     'Choose a city without a metropolis.')
    elif level + 1 == 4:
        base.require(free_cities, 'Build another city before this improvement.')
    player['commodities'][commodity] -= cost
    game['commodityBank'][commodity] += cost
    player['improvements'][discipline] += 1
    if claim:
        if holder:
            game['buildings'][str(holder['vertex'])].pop('metropolis')
        game['metropolises'][discipline] = {'owner': owner, 'vertex': target}
        game['buildings'][str(target)]['metropolis'] = discipline


def knight_action(game, owner, kind, data, free=False):
    base.require(game['phase'] == 'build' or game['phase'] == 'special-build' and
                 kind in ('build-knight', 'activate-knight', 'upgrade-knight'),
                 'Finish the dice result first.')
    target = data.get('target')
    base.require(type(target) is int and 0 <= target < len(base.topology(game)["vertices"]),
                 'Choose a board intersection.')
    piece = game['knightPieces'].get(str(target))
    if kind == 'build-knight':
        base.require(not piece and not base.building(game, target) and
                     any(base.road(game, edge) == owner for edge in base.topology(game)["vertices"][target]['edges']),
                     'Choose an empty intersection on your road.')
        base.require(sum(knight['owner'] == owner and knight['level'] == 1
                         for knight in game['knightPieces'].values()) < 2,
                     'Both basic knights are in use.')
        if not free:
            pay_resources(game, owner, KNIGHT_COST)
        game['knightPieces'][str(target)] = {'owner': owner, 'level': 1,
                                                'active': False, 'placedTurn': game['turn']}
        return
    base.require(piece and piece['owner'] == owner, 'Choose your knight.')
    if kind == 'upgrade-knight':
        level = piece['level']
        base.require(level < 3 and piece.get('upgradedTurn') != game['turn'],
                     'This knight cannot be upgraded again this turn.')
        base.require(level < 2 or game['players'][owner]['improvements']['politics'] >= 3,
                     'The Fortress improvement is required for a mighty knight.')
        base.require(sum(knight['owner'] == owner and knight['level'] == level + 1
                         for knight in game['knightPieces'].values()) < 2,
                     'Both knights of the next level are in use.')
        if not free:
            pay_resources(game, owner, KNIGHT_COST)
        piece['level'] += 1
        piece['upgradedTurn'] = game['turn']
    elif kind == 'activate-knight':
        base.require(not piece['active'], 'This knight is already active.')
        pay_resources(game, owner, {'wheat': 1})
        piece['active'] = True
        piece['activatedTurn'] = game['turn']
    else:
        base.require(piece['active'] and piece.get('activatedTurn', -1) < game['turn'] and
                     piece['placedTurn'] < game['turn'],
                     'A knight cannot act on the turn it was placed or activated.')
        if kind == 'chase-robber':
            base.require(game['barbarianAttacks'] and
                         game['robber'] in base.topology(game)["vertices"][target]['tiles'],
                         'An active knight must touch the robber after the first attack.')
            piece['active'] = False
            game['phase'] = 'robber'
            game['robberReturn'] = 'build'
        elif kind == 'move-knight':
            destination = data.get('destination')
            base.require(type(destination) is int and destination in
                         knight_destinations(game, owner, target, piece['level']),
                         'Choose a reachable intersection.')
            displaced = game['knightPieces'].pop(str(destination), None)
            game['knightPieces'][str(destination)] = game['knightPieces'].pop(str(target))
            piece['active'] = False
            if displaced:
                game['displacedKnight'] = {'owner': displaced['owner'], 'origin': destination,
                                           'piece': displaced}
                if knight_destinations(game, displaced['owner'], destination,
                                       displaced['level'], displacement=True):
                    game['phase'] = 'relocate-knight'
                else:
                    game['displacedKnight'] = None
        else:
            raise base.Invalid('Unknown knight action.')


def finish_numbered_dice(game):
    """Resolve production or a seven after the event die has finished."""
    total = sum(game['dice'])
    if total == 7:
        game['discard'] = [dict(owner=i, left=card_total(player) // 2)
                           for i, player in enumerate(game['players'])
                           if card_total(player) > discard_limit(game, i)]
        game['phase'] = 'discard' if game['discard'] else 'robber' if game['barbarianAttacks'] else 'build'
        game['robberReturn'] = 'build'
    else:
        before = [(player['resources'].copy(), player['commodities'].copy())
                  for player in game['players']]
        produce(game, total)
        game['rolls'][-1]['production'] = [
            dict(resources={kind: player['resources'][kind] - resources[kind]
                            for kind in base.RESOURCES},
                 commodities={kind: player['commodities'][kind] - commodities[kind]
                              for kind in COMMODITIES})
            for player, (resources, commodities) in zip(game['players'], before)
        ]
        game['aqueductChoices'] = [owner for owner, player in enumerate(game['players'])
                                   if player['improvements']['science'] >= 3 and
                                   not any(game['rolls'][-1]['production'][owner]['resources'].values()) and
                                   not any(game['rolls'][-1]['production'][owner]['commodities'].values())]
        if not any(game['bank'].values()):
            game['aqueductChoices'] = []
        game['phase'] = 'aqueduct' if game['aqueductChoices'] else 'build'
    game['pendingRoll'] = None


def action(game, owner, data, rng=None):
    """Mutate an expansion game state; the caller commits only on success."""
    base.require(game.get('mode') == 'cities-knights', 'Not a Cities & Knights game.')
    base.require(game['winner'] is None and game['phase'] != 'finished', 'This game has ended.')
    rng = rng or secrets.SystemRandom()
    kind = data.get('type')
    if kind == 'special-build-flag':
        base.require(game.get('map') == 'base-56' and owner != game['current'] and
                     not game['phase'].startswith('setup') and
                     game['phase'] not in ('special-build', 'finished'),
                     'Special building can be requested during another player\'s turn.')
        flags = game.setdefault('specialFlags', [])
        if owner in flags: flags.remove(owner)
        else: flags.append(owner)
    elif kind == 'roll':
        base.require(owner == game['current'] and game['phase'] == 'roll', 'You cannot roll now.')
        game['dice'] = (game['pendingAlchemy'] or [rng.randint(1, 6), rng.randint(1, 6)]).copy()
        game['pendingAlchemy'] = None
        game['eventDie'] = EVENT_FACES[rng.randint(1, 6) - 1]
        game.setdefault('rolls', []).append(dict(player=owner, dice=game['dice'].copy(), event=game['eventDie']))
        if game['eventDie'] == 'barbarian':
            game['barbarianPosition'] += 1
            if game['barbarianPosition'] == BARBARIAN_SHORE:
                game['pendingRoll'] = sum(game['dice'])
                begin_attack(game)
            else:
                finish_numbered_dice(game)
        else:
            game['pendingRoll'] = sum(game['dice'])
            game['progressQueue'] = [(player, game['eventDie']) for player in progress.event_order(game)]
            game['progressResume'] = 'event'
            progress.advance_draws(game, sys.modules[__name__])
        game['log'] = (game['log'] + [game['players'][owner]['name'] + ' rolled ' +
                                  str(sum(game['dice'])) + ' · ' + game['eventDie']])[-80:]
    elif kind == 'defender-reward':
        discipline = data.get('discipline')
        base.require(game['phase'] == 'defender-reward' and game['defenderRewards'] and
                     game['defenderRewards'][0] == owner and discipline in IMPROVEMENT_COMMODITY,
                     'Choose a progress-card deck for your defense reward.')
        game['defenderRewards'].pop(0)
        progress.draw(game, owner, discipline, sys.modules[__name__])
        if game['winner'] is None and owner != game['current'] and len(game['players'][owner]['progress']) > 4:
            game['progressOverflow'] = owner
            game['progressResume'] = 'defender'
            game['phase'] = 'progress-discard'
        elif game['winner'] is None:
            if game['defenderRewards']:
                game['phase'] = 'defender-reward'
            else:
                finish_numbered_dice(game)
    elif kind == 'discard-progress':
        voluntary = game['phase'] == 'build' and owner == game['current']
        base.require(voluntary or (game['phase'] == 'progress-discard' and
                     game['progressOverflow'] == owner), 'You have no progress card to discard now.')
        progress.discard_progress(game, owner, data.get('card'))
        if voluntary:
            return
        game['progressOverflow'] = None
        if game['progressResume'] == 'defender':
            if game['defenderRewards']:
                game['phase'] = 'defender-reward'
            else:
                finish_numbered_dice(game)
        elif game['progressResume'] == 'event':
            progress.advance_draws(game, sys.modules[__name__])
        else:
            game['phase'] = 'build'
    elif kind == 'play-progress':
        progress.play(game, owner, data, rng, sys.modules[__name__])
    elif kind in ('progress-forced-discard', 'wedding-gift', 'spy-take', 'merchant-take',
                  'deserter-pick', 'deserter-place', 'harbor-offer', 'harbor-response'):
        progress.respond(game, owner, data, sys.modules[__name__])
    elif kind == 'barbarian-loss':
        base.require(game['phase'] == 'barbarian-loss' and owner in game['barbarianLosses'],
                     'You are not choosing a pillaged city.')
        pillage(game, owner, data.get('target'))
        game['barbarianLosses'].remove(owner)
        if not game['barbarianLosses']:
            finish_attack(game)
    elif kind == 'aqueduct':
        resource = data.get('resource')
        base.require(game['phase'] == 'aqueduct' and owner in game['aqueductChoices'] and
                     resource in base.RESOURCES and game['bank'][resource] > 0,
                     'Choose an available resource for your aqueduct.')
        base.give(game, owner, resource, 1)
        game['rolls'][-1].setdefault('aqueduct', []).append({'player': owner, 'resource': resource})
        game['aqueductChoices'].remove(owner)
        if not any(game['bank'].values()):
            game['aqueductChoices'] = []
        if not game['aqueductChoices']:
            game['phase'] = 'build'
    elif kind == 'build':
        base.require(owner == game['current'], 'It is not your turn.')
        if game['phase'].startswith('setup'):
            setup_action(game, owner, data.get('piece'), data.get('target'))
        else:
            build_piece(game, owner, data.get('piece'), data.get('target'))
            awards(game)
    elif kind == 'build-wall':
        base.require(owner == game['current'], 'It is not your turn.')
        build_wall(game, owner, data.get('target'))
    elif kind == 'improve-city':
        base.require(owner == game['current'], 'It is not your turn.')
        improve_city(game, owner, data.get('discipline'), data.get('target'))
        awards(game)
    elif kind in ('build-knight', 'upgrade-knight', 'activate-knight', 'move-knight', 'chase-robber'):
        base.require(owner == game['current'], 'It is not your turn.')
        knight_action(game, owner, kind, data)
        if game['phase'] != 'relocate-knight':
            awards(game)
    elif kind == 'relocate-knight':
        displaced = game['displacedKnight']
        destination = data.get('target')
        base.require(game['phase'] == 'relocate-knight' and displaced and
                     displaced['owner'] == owner and type(destination) is int and
                     destination in knight_destinations(game, owner, displaced['origin'],
                                                         displaced['piece']['level'], displacement=True),
                     'Relocate your displaced knight along your roads.')
        game['knightPieces'][str(destination)] = displaced['piece']
        game['displacedKnight'] = None
        game['phase'] = 'build'
        awards(game)
    elif kind == 'tradehouse-exchange':
        base.require(owner == game['current'] and game['phase'] == 'build' and
                     game['players'][owner]['improvements']['trade'] >= 3,
                     'The Merchant Guild improvement is required.')
        give, receive = data.get('give'), data.get('receive')
        base.require(give in COMMODITIES and receive in (*COMMODITIES, *base.RESOURCES) and
                     give != receive and game['players'][owner]['commodities'][give] >= 2,
                     'Trade two identical commodities for another card.')
        bank = game['commodityBank'] if receive in COMMODITIES else game['bank']
        base.require(bank[receive] > 0, 'That card is unavailable from the bank.')
        game['players'][owner]['commodities'][give] -= 2
        game['commodityBank'][give] += 2
        bank[receive] -= 1
        hand = game['players'][owner]['commodities'] if receive in COMMODITIES else game['players'][owner]['resources']
        hand[receive] += 1
    elif kind == 'bank-trade':
        base.require(owner == game['current'], 'It is not your turn.')
        bank_trade(game, owner, data)
    elif kind in ('offer', 'accept-trade', 'reject-trade', 'counter-trade',
                  'confirm-trade', 'cancel-trade', 'embargo'):
        player_trade(game, owner, kind, data)
    elif kind == 'discard':
        entry = next((entry for entry in game['discard'] if entry['owner'] == owner), None)
        card = data.get('resource')
        hand = (game['players'][owner]['resources'] if card in base.RESOURCES else
                game['players'][owner]['commodities'] if card in COMMODITIES else None)
        base.require(game['phase'] == 'discard' and entry and hand and hand[card] > 0,
                     'You cannot discard that card.')
        hand[card] -= 1
        bank = game['bank'] if card in base.RESOURCES else game['commodityBank']
        bank[card] += 1
        entry['left'] -= 1
        game['discard'] = [entry for entry in game['discard'] if entry['left']]
        if not game['discard']:
            game['phase'] = 'robber' if game['barbarianAttacks'] else 'build'
    elif kind == 'robber':
        target = data.get('target')
        base.require(owner == game['current'] and game['barbarianAttacks'] and
                     game['phase'] == 'robber' and type(target) is int and
                     0 <= target < len(game['tiles']) and target != game['robber'],
                     'Choose a different tile after the first barbarian attack.')
        game['robber'] = target
        game['victims'] = sorted({building['owner'] for vertex in base.topology(game)["tiles"][target]['corners']
                                  if (building := base.building(game, vertex)) and
                                  building['owner'] != owner and
                                  card_total(game['players'][building['owner']])})
        game['phase'] = 'steal' if game['victims'] else 'build'
    elif kind == 'steal':
        victim = data.get('target')
        base.require(owner == game['current'] and game['phase'] == 'steal' and
                     type(victim) is int and victim in game['victims'], 'Choose an eligible player.')
        player = game['players'][victim]
        cards = [(kind, card) for kind, hand in (('resource', player['resources']),
                                                 ('commodity', player['commodities']))
                 for card, count in hand.items() for _ in range(count)]
        card_kind, card = rng.choice(cards)
        key = 'resources' if card_kind == 'resource' else 'commodities'
        player[key][card] -= 1
        game['players'][owner][key][card] += 1
        game['log'] = (game['log'] + [game['players'][owner]['name'] +
            ' stole a card from ' + game['players'][victim]['name']])[-80:]
        game['victims'] = []
        game['phase'] = 'build'
    elif kind == 'end':
        base.require(owner == game['current'] and game['phase'] in ('build', 'special-build'),
                     'Finish the dice result and your turn actions first.')
        base.require(len(game['players'][owner]['progress']) <= 4,
                     'Play or discard down to four progress cards before ending your turn.')
        if game['phase'] == 'special-build':
            queue = game['specialQueue']
            if queue:
                game['current'] = queue.pop(0)
            else:
                game['current'] = game['specialNext']
                game['specialNext'] = None
                game['turn'] += 1
                game['phase'] = 'roll'
        else:
            following = (owner + 1) % len(game['players'])
            flags = set(game.get('specialFlags', [])) if game.get('map') == 'base-56' else set()
            queue = [(owner + offset) % len(game['players'])
                     for offset in range(1, len(game['players']))
                     if (owner + offset) % len(game['players']) in flags]
            game['specialFlags'] = []
            if queue:
                game['current'] = queue.pop(0)
                game['specialQueue'] = queue
                game['specialNext'] = following
                game['phase'] = 'special-build'
            else:
                game['current'] = following
                game['turn'] += 1
                game['phase'] = 'roll'
        game['offers'] = []
        game['merchantFleet'] = []
        game['harborTargets'] = []
        awards(game)
    else:
        raise base.Invalid('This Cities & Knights action is not implemented yet.')
    cue = {
        'offer': 'sfx_offer_acceptable',
        'counter-trade': 'sfx_offer_acceptable',
        'accept-trade': 'sfx_offer_acceptable',
        'reject-trade': 'sfx_offer_rejected',
        'confirm-trade': 'sfx_offer_accepted',
        'bank-trade': 'sfx_offer_accepted',
        'tradehouse-exchange': 'sfx_offer_accepted',
    }.get(kind)
    if kind == 'play-progress':
        cue = ('sfx_devcard_monopoly' if 'monopoly' in data.get('card', '')
               else 'sfx_devcard_used')
    if cue:
        game['audioSeq'] = game.get('audioSeq', 0) + 1
        game['audioEvent'] = {'id': game['audioSeq'], 'cue': cue}


def view(game, seat):
    """Return a seat-specific snapshot without other players' private cards."""
    public = copy.deepcopy(game)
    public['ports'] = base.topology(game)['ports']
    public.pop('deck', None)
    public['progressDeckCounts'] = {discipline: len(cards) for discipline, cards in
                                    public.pop('progressDecks').items()}
    public['tradeRates'] = ({kind: trade_rate(game, seat, kind)
                             for kind in (*base.RESOURCES, *COMMODITIES)}
                            if type(seat) is int and 0 <= seat < len(game['players']) else None)
    public['legal'] = {kind: [] for kind in ('road', 'settlement', 'city')}
    if seat == game['current']:
        for kind in public['legal']:
            if kind == 'city' and game['phase'] == 'setup-city':
                public['legal'][kind] = legal_starting_cities(game)
            else:
                public['legal'][kind] = base.legal(game, kind)
        if game['phase'] in ('build', 'free-road', 'special-build'):
            public['legal']['road'] = [edge for edge in public['legal']['road']
                                       if legal_road(game, seat, edge)]
            public['legal']['settlement'] = [vertex for vertex in public['legal']['settlement']
                                             if str(vertex) not in game['knightPieces']]
            damaged = [int(vertex) for vertex, building in game['buildings'].items()
                       if building['owner'] == seat and building.get('damagedCity')]
            if damaged:
                public['legal']['city'] = [vertex for vertex in public['legal']['city']
                                           if vertex in damaged]
    for owner, player in enumerate(public['players']):
        player['cardCount'] = card_total(game['players'][owner])
        player['progressCount'] = len(game['players'][owner]['progress'])
        player['devCount'] = 0
        player['dev'] = None
        if owner != seat:
            player['resources'] = None
            player['commodities'] = None
            player['progress'] = None
        else:
            player['totalVP'] = player['vp']
    pending = game.get('progressPending') or {}
    public['privatePreview'] = None
    if seat == pending.get('owner') and game['phase'] == 'spy-take':
        public['privatePreview'] = {'player': pending['target'],
                                    'progress': game['players'][pending['target']]['progress'].copy()}
    if seat == pending.get('owner') and game['phase'] == 'merchant-take':
        public['privatePreview'] = {'player': pending['target'],
                                    'cards': progress.card_hand(game, pending['target'])}
    return public
