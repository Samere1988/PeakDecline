"""Cities & Knights progress decks and card effects (2020 card edition)."""

from app import catan_rules as base

CARD_COUNTS = {
    'science': {'alchemist': 2, 'crane': 2, 'engineer': 1, 'inventor': 2,
                'irrigation': 2, 'medicine': 2, 'mining': 2, 'printer': 1,
                'road_building': 2, 'smith': 2},
    'politics': {'bishop': 2, 'constitution': 1, 'deserter': 2,
                 'diplomat': 2, 'intrigue': 2, 'saboteur': 2, 'spy': 3,
                 'warlord': 2, 'wedding': 2},
    'trade': {'commercial_harbor': 2, 'commodity_monopoly': 2,
              'master_merchant': 2, 'merchant_fleet': 2, 'merchant': 6,
              'resource_monopoly': 4},
}
VICTORY_CARDS = {'science_printer', 'politics_constitution'}


def decks(rng):
    result = {}
    for discipline, counts in CARD_COUNTS.items():
        cards = [f'{discipline}_{name}' for name, count in counts.items() for _ in range(count)]
        rng.shuffle(cards)
        result[discipline] = cards
    return result


def return_card(game, card):
    discipline = card.split('_', 1)[0]
    game['progressDecks'][discipline].insert(0, card)


def draw(game, owner, discipline, ck):
    deck = game['progressDecks'][discipline]
    if not deck:
        return None
    card = deck.pop()
    player = game['players'][owner]
    if card in VICTORY_CARDS:
        player['progressVP'].append(card)
        ck.awards(game)
    else:
        player['progress'].append(card)
    return card


def event_order(game):
    discipline = game['eventDie']
    red = game['dice'][0]
    current = game['current']
    count = len(game['players'])
    return [owner for owner in ((current + offset) % count for offset in range(count))
            if red <= game['players'][owner]['improvements'][discipline] + 1 and
            game['players'][owner]['improvements'][discipline] > 0]


def advance_draws(game, ck):
    """Draw in turn order, pausing for any off-turn hand-limit choice."""
    while game['progressQueue'] and game['winner'] is None:
        owner, discipline = game['progressQueue'].pop(0)
        draw(game, owner, discipline, ck)
        if owner != game['current'] and len(game['players'][owner]['progress']) > 4:
            game['progressOverflow'] = owner
            game['phase'] = 'progress-discard'
            return
    if game['winner'] is not None:
        return
    game['progressOverflow'] = None
    game['progressQueue'] = []
    ck.finish_numbered_dice(game)


def discard_progress(game, owner, card):
    base.require(card in game['players'][owner]['progress'], 'Choose one of your progress cards.')
    game['players'][owner]['progress'].remove(card)
    return_card(game, card)


def card_hand(game, owner):
    player = game['players'][owner]
    return {**player['resources'], **player['commodities']}


def transfer(game, source, target, card, amount=1):
    hand = 'resources' if card in base.RESOURCES else 'commodities'
    available = game['players'][source][hand][card]
    moved = min(amount, available)
    game['players'][source][hand][card] -= moved
    game['players'][target][hand][card] += moved
    return moved


def progress_cost(game, owner, card):
    base.require(card in game['players'][owner]['progress'], 'You do not have that progress card.')
    game['players'][owner]['progress'].remove(card)
    return_card(game, card)


def play(game, owner, data, rng, ck):
    card = data.get('card')
    base.require(isinstance(card, str) and card in game['players'][owner]['progress'],
                 'You do not have that progress card.')
    base.require(owner == game['current'], 'Play progress cards on your turn.')
    if card == 'science_alchemist':
        dice = data.get('dice')
        base.require(game['phase'] == 'roll' and game['pendingAlchemy'] is None and
                     isinstance(dice, list) and len(dice) == 2 and
                     all(type(face) is int and 1 <= face <= 6 for face in dice),
                     'Choose both production dice before rolling.')
        game['pendingAlchemy'] = dice.copy()
        progress_cost(game, owner, card)
        return
    base.require(game['phase'] == 'build', 'Resolve the dice before playing this card.')
    player = game['players'][owner]
    kind = card.split('_', 1)[1]

    if card == 'science_crane':
        ck.improve_city(game, owner, data.get('discipline'), data.get('target'), discount=1)
    elif card == 'science_engineer':
        ck.build_wall(game, owner, data.get('target'), free=True)
    elif card == 'science_inventor':
        targets = data.get('targets')
        base.require(isinstance(targets, list) and len(targets) == 2 and
                     all(type(target) is int and 0 <= target < len(game['tiles']) for target in targets) and
                     targets[0] != targets[1] and
                     all(game['tiles'][target]['number'] not in (None, 2, 6, 8, 12) for target in targets),
                     'Choose two eligible number discs.')
        game['tiles'][targets[0]]['number'], game['tiles'][targets[1]]['number'] = (
            game['tiles'][targets[1]]['number'], game['tiles'][targets[0]]['number'])
    elif card in ('science_irrigation', 'science_mining'):
        terrain, resource = ('wheat', 'wheat') if kind == 'irrigation' else ('ore', 'ore')
        tiles = [tile for tile in game['tiles'] if tile['type'] == terrain and
                 any((building := ck.base.building(game, vertex)) and building['owner'] == owner
                     for vertex in tile['corners'])]
        ck.base.give(game, owner, resource, 2 * len(tiles))
    elif card == 'science_medicine':
        ck.build_piece(game, owner, 'city', data.get('target'), cost={'wheat': 1, 'ore': 2})
    elif card == 'science_road_building':
        game['freeRoads'] = min(2, player['road'])
        if game['freeRoads'] and any(ck.legal_road(game, owner, edge['id'])
                                     for edge in ck.base.topology(game)["edges"]):
            game['phase'] = 'free-road'
        else:
            game['freeRoads'] = 0
    elif card == 'science_smith':
        targets = data.get('targets')
        base.require(isinstance(targets, list) and len(targets) <= 2 and
                     all(type(target) is int for target in targets) and
                     len(targets) == len(set(targets)),
                     'Choose up to two different knights.')
        for target in targets:
            ck.knight_action(game, owner, 'upgrade-knight', {'target': target}, free=True)
    elif card == 'politics_bishop':
        target = data.get('target')
        base.require(game['barbarianAttacks'] and type(target) is int and
                     0 <= target < len(game['tiles']) and target != game['robber'],
                     'Choose a new robber tile after the first barbarian attack.')
        game['robber'] = target
        victims = {building['owner'] for vertex in ck.base.topology(game)["tiles"][target]['corners']
                   if (building := ck.base.building(game, vertex)) and building['owner'] != owner and
                   ck.card_total(game['players'][building['owner']])}
        for victim in sorted(victims):
            chosen = rng.choice([card for card, count in card_hand(game, victim).items()
                                 for _ in range(count)])
            transfer(game, victim, owner, chosen)
    elif card == 'politics_deserter':
        target = data.get('target')
        base.require(type(target) is int and 0 <= target < len(game['players']) and
                     target != owner and any(knight['owner'] == target
                                             for knight in game['knightPieces'].values()),
                     'Choose a player with a knight.')
        game['progressPending'] = {'kind': 'deserter', 'owner': owner, 'target': target}
        game['phase'] = 'deserter-pick'
    elif card == 'politics_diplomat':
        road = data.get('road')
        base.require(type(road) is int and str(road) in game['roads'] and
                     open_road(game, road, ck), 'Choose an open road.')
        road_owner = game['roads'][str(road)]
        remaining = {edge: player for edge, player in game['roads'].items() if edge != str(road)}
        shortened = {**game, 'roads': remaining}
        base.require(all(any((building := ck.base.building(game, vertex)) and
                             building['owner'] == road_owner
                             for vertex in ck.knight_reach(shortened, road_owner, int(position)))
                         for position, knight in game['knightPieces'].items()
                         if knight['owner'] == road_owner),
                     'Removing that road would strand a knight.')
        road_owner = game['roads'].pop(str(road))
        game['players'][road_owner]['road'] += 1
        destination = data.get('destination')
        if destination is not None:
            base.require(road_owner == owner and type(destination) is int and
                         ck.legal_road(game, owner, destination),
                         'Only your removed road may be replaced legally.')
            game['players'][owner]['road'] -= 1
            game['roads'][str(destination)] = owner
    elif card == 'politics_intrigue':
        target = data.get('target')
        knight = game['knightPieces'].get(str(target))
        base.require(type(target) is int and knight and knight['owner'] != owner and
                     any(ck.base.road(game, edge) == owner for edge in ck.base.topology(game)["vertices"][target]['edges']),
                     'Choose an enemy knight touching your road.')
        knight = game['knightPieces'].pop(str(target))
        game['displacedKnight'] = {'owner': knight['owner'], 'origin': target, 'piece': knight}
        if ck.knight_destinations(game, knight['owner'], target, knight['level'], displacement=True):
            game['phase'] = 'relocate-knight'
        else:
            game['displacedKnight'] = None
    elif card == 'politics_saboteur':
        affected = [target for target in range(len(game['players'])) if target != owner and
                    game['players'][target]['vp'] >= player['vp'] and
                    ck.card_total(game['players'][target]) >= 2]
        game['progressPending'] = {'kind': 'saboteur',
                                   'discards': [{'owner': target,
                                                 'left': ck.card_total(game['players'][target]) // 2}
                                                for target in affected]}
        if affected:
            game['phase'] = 'progress-forced-discard'
    elif card == 'politics_spy':
        target = data.get('target')
        base.require(type(target) is int and 0 <= target < len(game['players']) and
                     target != owner, 'Choose another player.')
        if game['players'][target]['progress']:
            game['progressPending'] = {'kind': 'spy', 'owner': owner, 'target': target}
            game['phase'] = 'spy-take'
    elif card == 'politics_warlord':
        for knight in game['knightPieces'].values():
            if knight['owner'] == owner and not knight['active']:
                knight['active'] = True
                knight['activatedTurn'] = game['turn']
    elif card == 'politics_wedding':
        affected = [target for target in range(len(game['players'])) if target != owner and
                    game['players'][target]['vp'] > player['vp'] and
                    ck.card_total(game['players'][target])]
        game['progressPending'] = {'kind': 'wedding', 'owner': owner,
                                   'gifts': [{'owner': target,
                                              'left': min(2, ck.card_total(game['players'][target]))}
                                             for target in affected]}
        if affected:
            game['phase'] = 'wedding-gift'
    elif card == 'trade_commercial_harbor':
        game['harborTargets'] = [target for target in range(len(game['players'])) if target != owner]
    elif card == 'trade_master_merchant':
        target = data.get('target')
        base.require(type(target) is int and 0 <= target < len(game['players']) and
                     game['players'][target]['vp'] > player['vp'],
                     'Choose a player with more victory points.')
        if ck.card_total(game['players'][target]):
            game['progressPending'] = {'kind': 'master_merchant', 'owner': owner,
                                       'target': target, 'left': min(2, ck.card_total(game['players'][target]))}
            game['phase'] = 'merchant-take'
    elif card == 'trade_merchant':
        target = data.get('target')
        base.require(type(target) is int and 0 <= target < len(game['tiles']) and
                     game['tiles'][target]['type'] in base.RESOURCES and
                     any((building := ck.base.building(game, vertex)) and building['owner'] == owner
                         for vertex in game['tiles'][target]['corners']),
                     'Choose a producing tile next to your building.')
        game['merchant'] = {'owner': owner, 'tile': target}
    elif card == 'trade_merchant_fleet':
        selected = data.get('resource')
        base.require(selected in (*base.RESOURCES, *ck.COMMODITIES), 'Choose a resource or commodity.')
        game['merchantFleet'].append({'owner': owner, 'kind': selected, 'turn': game['turn']})
    elif card == 'trade_resource_monopoly':
        selected = data.get('resource')
        base.require(selected in base.RESOURCES, 'Choose a resource.')
        for target in range(len(game['players'])):
            if target != owner:
                transfer(game, target, owner, selected, 2)
    elif card == 'trade_commodity_monopoly':
        selected = data.get('commodity')
        base.require(selected in ck.COMMODITIES, 'Choose a commodity.')
        for target in range(len(game['players'])):
            if target != owner:
                transfer(game, target, owner, selected)
    else:
        raise base.Invalid('Unknown progress card.')

    progress_cost(game, owner, card)
    ck.awards(game)


def open_road(game, edge_id, ck):
    owner = game['roads'][str(edge_id)]
    for vertex in ck.base.topology(game)["edges"][edge_id]['ends']:
        attached = any(other != edge_id and ck.base.road(game, other) == owner
                       for other in ck.base.topology(game)["vertices"][vertex]['edges'])
        building = ck.base.building(game, vertex)
        knight = game['knightPieces'].get(str(vertex))
        if not attached and not (building and building['owner'] == owner) and not (
                knight and knight['owner'] == owner):
            return True
    return False


def respond(game, owner, data, ck):
    pending = game.get('progressPending') or {}
    kind = data.get('type')
    if kind == 'progress-forced-discard':
        entry = next((item for item in pending.get('discards', []) if item['owner'] == owner), None)
        selected = data.get('resource')
        base.require(game['phase'] == 'progress-forced-discard' and entry and
                     selected in (*base.RESOURCES, *ck.COMMODITIES) and card_hand(game, owner)[selected],
                     'Choose a card to discard.')
        hand = game['players'][owner]['resources'] if selected in base.RESOURCES else game['players'][owner]['commodities']
        bank = game['bank'] if selected in base.RESOURCES else game['commodityBank']
        hand[selected] -= 1
        bank[selected] += 1
        entry['left'] -= 1
        pending['discards'] = [item for item in pending['discards'] if item['left']]
        if not pending['discards']:
            game['phase'] = 'build'
            game['progressPending'] = None
    elif kind == 'wedding-gift':
        entry = next((item for item in pending.get('gifts', []) if item['owner'] == owner), None)
        selected = data.get('resource')
        base.require(game['phase'] == 'wedding-gift' and entry and
                     selected in (*base.RESOURCES, *ck.COMMODITIES) and card_hand(game, owner)[selected],
                     'Choose a card to give.')
        transfer(game, owner, pending['owner'], selected)
        entry['left'] -= 1
        pending['gifts'] = [item for item in pending['gifts'] if item['left']]
        if not pending['gifts']:
            game['phase'] = 'build'
            game['progressPending'] = None
    elif kind in ('spy-take', 'merchant-take'):
        base.require(game['phase'] == kind and pending.get('owner') == owner,
                     'This is not your card choice.')
        target = pending['target']
        card = data.get('card')
        if kind == 'spy-take':
            base.require(card in game['players'][target]['progress'], 'Choose a visible progress card.')
            game['players'][target]['progress'].remove(card)
            game['players'][owner]['progress'].append(card)
            game['phase'] = 'build'
            game['progressPending'] = None
        else:
            base.require(card in (*base.RESOURCES, *ck.COMMODITIES) and card_hand(game, target)[card],
                         'Choose a visible resource or commodity.')
            transfer(game, target, owner, card)
            pending['left'] -= 1
            if not pending['left']:
                game['phase'] = 'build'
                game['progressPending'] = None
    elif kind == 'deserter-pick':
        target = data.get('target')
        piece = game['knightPieces'].get(str(target))
        base.require(game['phase'] == 'deserter-pick' and pending.get('target') == owner and
                     type(target) is int and piece and piece['owner'] == owner,
                     'Choose one of your knights to desert.')
        game['knightPieces'].pop(str(target))
        pending['piece'] = piece
        pending['origin'] = target
        game['phase'] = 'deserter-place'
    elif kind == 'deserter-place':
        base.require(game['phase'] == 'deserter-place' and pending.get('owner') == owner,
                     'The card owner places the replacement knight.')
        target = data.get('target')
        if target is not None:
            base.require(type(target) is int and 0 <= target < len(ck.base.topology(game)["vertices"]) and
                         not ck.base.building(game, target) and str(target) not in game['knightPieces'] and
                         any(ck.base.road(game, edge) == owner for edge in ck.base.topology(game)["vertices"][target]['edges']),
                         'Choose an empty intersection on your road.')
            level = pending['piece']['level']
            if sum(piece['owner'] == owner and piece['level'] == level
                   for piece in game['knightPieces'].values()) >= 2:
                level = 1
            base.require(sum(piece['owner'] == owner and piece['level'] == level
                             for piece in game['knightPieces'].values()) < 2,
                         'No matching or basic knight is available.')
            game['knightPieces'][str(target)] = {'owner': owner, 'level': level,
                                                  'active': pending['piece']['active'],
                                                  'placedTurn': game['turn'],
                                                  'activatedTurn': game['turn']}
        game['phase'] = 'build'
        game['progressPending'] = None
        ck.awards(game)
    elif kind == 'harbor-offer':
        target, card = data.get('target'), data.get('resource')
        base.require(game['phase'] == 'build' and owner == game['current'] and
                     target in game['harborTargets'] and card in base.RESOURCES and
                     game['players'][owner]['resources'][card] > 0,
                     'Offer one resource to an unused opponent.')
        game['harborTargets'].remove(target)
        if any(game['players'][target]['commodities'].values()):
            game['progressPending'] = {'kind': 'commercial_harbor', 'owner': owner,
                                       'target': target, 'resource': card}
            game['phase'] = 'harbor-response'
    elif kind == 'harbor-response':
        card = data.get('commodity')
        base.require(game['phase'] == 'harbor-response' and pending.get('target') == owner and
                     card in ck.COMMODITIES and game['players'][owner]['commodities'][card] > 0 and
                     game['players'][pending['owner']]['resources'][pending['resource']] > 0,
                     'Choose one commodity to exchange.')
        transfer(game, pending['owner'], owner, pending['resource'])
        transfer(game, owner, pending['owner'], card)
        game['progressPending'] = None
        game['phase'] = 'build'
    else:
        raise base.Invalid('Unknown progress-card response.')
