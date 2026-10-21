"""First Cities & Knights rules slice; the live base-game mode stays separate."""
import random
import unittest

from app import catan_cities_knights as CK
from app import catan_rules as base


class CitiesKnightsFoundationTests(unittest.TestCase):
    def setUp(self):
        self.game = CK.create(['A', 'B', 'C', 'D'], random.Random(8))

    def test_second_starting_placement_is_a_city(self):
        game = self.game
        placements = []
        while game['phase'].startswith('setup'):
            owner = game['current']
            phase = game['phase']
            piece = phase.removeprefix('setup-')
            if piece == 'city':
                with self.assertRaises(base.Invalid):
                    CK.setup_action(game, owner, 'settlement', CK.legal_starting_cities(game)[0])
                target = CK.legal_starting_cities(game)[0]
                expected = [game['tiles'][tile]['type'] for tile in base.VERTICES[target]['tiles']]
                before = game['players'][owner]['resources'].copy()
            else:
                target = base.legal(game, piece)[0]
            CK.setup_action(game, owner, piece, target)
            if piece == 'city':
                placements.append(owner)
                for resource in base.RESOURCES:
                    self.assertEqual(game['players'][owner]['resources'][resource]-before[resource], expected.count(resource))
        self.assertEqual(placements, [3, 2, 1, 0])
        self.assertEqual(game['phase'], 'roll')
        for player in game['players']:
            self.assertEqual((player['settlement'], player['city'], player['road'], player['vp']), (4, 3, 13, 3))

    def test_city_produces_one_resource_and_one_commodity(self):
        game = self.game
        tile = next(tile for tile in game['tiles'] if tile['type'] == 'wood' and tile['id'] != game['robber'])
        for other in game['tiles']:
            other['number'] = 3
        tile['number'] = 5
        a, b = tile['corners'][:2]
        game['buildings'] = {str(a): {'owner': 0, 'kind': 'city'}, str(b): {'owner': 1, 'kind': 'settlement'}}
        CK.produce(game, 5)
        self.assertEqual(game['players'][0]['resources']['wood'], 1)
        self.assertEqual(game['players'][0]['commodities']['paper'], 1)
        self.assertEqual(game['players'][1]['resources']['wood'], 1)
        self.assertEqual(game['players'][1]['commodities']['paper'], 0)
        self.assertEqual(game['bank']['wood'], 17)
        self.assertEqual(game['commodityBank']['paper'], 11)
        game['robber'] = tile['id']
        CK.produce(game, 5)
        self.assertEqual(game['players'][0]['commodities']['paper'], 1)

    def test_wheat_city_keeps_two_resources_and_base_game_has_no_commodities(self):
        game = self.game
        tile = next(tile for tile in game['tiles'] if tile['type'] == 'wheat' and tile['id'] != game['robber'])
        for other in game['tiles']:
            other['number'] = 3
        tile['number'] = 5
        game['buildings'] = {str(tile['corners'][0]): {'owner': 0, 'kind': 'city'}}
        CK.produce(game, 5)
        self.assertEqual(game['players'][0]['resources']['wheat'], 2)
        self.assertEqual(game['players'][0]['commodities'], dict.fromkeys(CK.COMMODITIES, 0))
        normal = base.create(['A', 'B', 'C', 'D'], random.Random(8))
        self.assertNotIn('mode', normal)
        self.assertNotIn('commodityBank', normal)
        self.assertNotIn('commodities', normal['players'][0])

    def test_three_independent_dice_and_event_before_production(self):
        class Dice:
            def __init__(self):
                self.faces = iter((2, 3, 1))

            def randint(self, low, high):
                self_outer.assertEqual((low, high), (1, 6))
                return next(self.faces)

        self_outer = self
        game = self.game
        game['phase'] = 'roll'
        tile = next(tile for tile in game['tiles'] if tile['type'] == 'wood' and tile['id'] != game['robber'])
        tile['number'] = 5
        game['buildings'] = {str(tile['corners'][0]): {'owner': 0, 'kind': 'city'}}
        CK.action(game, 0, {'type': 'roll'}, Dice())
        self.assertEqual(game['dice'], [2, 3])
        self.assertEqual(game['eventDie'], 'barbarian')
        self.assertEqual((game['rolls'][-1]['player'], game['rolls'][-1]['dice'],
                          game['rolls'][-1]['event']), (0, [2, 3], 'barbarian'))
        self.assertEqual(game['rolls'][-1]['production'][0]['resources']['wood'], 1)
        self.assertEqual(game['rolls'][-1]['production'][0]['commodities']['paper'], 1)
        self.assertEqual(game['barbarianPosition'], 1)
        self.assertEqual(game['players'][0]['resources']['wood'], 1)
        self.assertEqual(game['players'][0]['commodities']['paper'], 1)
        self.assertEqual(game['phase'], 'build')

    def test_seven_discards_resources_and_commodities_without_early_robber(self):
        class Dice:
            def __init__(self): self.faces = iter((3, 4, 4))
            def randint(self, _low, _high): return next(self.faces)

        game = self.game
        game['phase'] = 'roll'
        game['players'][1]['resources']['wood'] = 5
        game['players'][1]['commodities']['paper'] = 4
        CK.action(game, 0, {'type': 'roll'}, Dice())
        self.assertEqual(game['eventDie'], 'science')
        self.assertEqual(game['discard'], [{'owner': 1, 'left': 4}])
        self.assertEqual(game['phase'], 'discard')
        for _ in range(4):
            CK.action(game, 1, {'type': 'discard', 'resource': 'paper'})
        self.assertEqual(game['phase'], 'build')
        self.assertEqual(game['commodityBank']['paper'], 16)
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'robber', 'target': 0})

    def test_city_wall_raises_seven_discard_limit(self):
        game = self.game
        game['dice'] = [3, 4]
        game['players'][1]['commodities']['cloth'] = 9
        game['buildings'] = {'0': {'owner': 1, 'kind': 'city', 'wall': True}}
        CK.finish_numbered_dice(game)
        self.assertEqual(game['discard'], [])
        self.assertEqual(game['phase'], 'build')

    def test_seventh_ship_resolves_battle_before_seven(self):
        class Dice:
            def __init__(self): self.faces = iter((3, 4, 2))
            def randint(self, _low, _high): return next(self.faces)

        game = self.game
        game['phase'] = 'roll'
        game['barbarianPosition'] = CK.BARBARIAN_SHORE - 1
        game['players'][1]['resources']['wood'] = 8
        game['buildings'] = {'0': {'owner': 1, 'kind': 'city'}}
        CK.action(game, 0, {'type': 'roll'}, Dice())
        self.assertEqual(game['phase'], 'barbarian-loss')
        self.assertEqual(game['barbarianPosition'], CK.BARBARIAN_SHORE)
        self.assertEqual(game['pendingRoll'], 7)
        self.assertEqual(game['barbarianAttacks'], 0)
        self.assertEqual(game['discard'], [])
        self.assertEqual(game['barbarianLosses'], [1])
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'roll'}, Dice())
        CK.action(game, 1, {'type': 'barbarian-loss', 'target': 0})
        self.assertEqual(game['barbarianPosition'], 0)
        self.assertEqual(game['barbarianAttacks'], 1)
        self.assertEqual(game['buildings']['0']['kind'], 'settlement')
        self.assertEqual(game['phase'], 'discard')
        self.assertEqual(game['discard'], [{'owner': 1, 'left': 4}])

    def test_post_attack_seven_allows_robber_to_steal_commodity(self):
        class Dice:
            def __init__(self): self.faces = iter((1, 6, 5))
            def randint(self, _low, _high): return next(self.faces)
            def choice(self, cards): return next(card for card in cards if card == ('commodity', 'coin'))

        game = self.game
        game['phase'] = 'roll'
        game['barbarianAttacks'] = 1
        game['players'][1]['commodities']['coin'] = 1
        victim_tile = next(tile for tile in game['tiles'] if tile['id'] != game['robber'])
        game['buildings'] = {str(victim_tile['corners'][0]): {'owner': 1, 'kind': 'settlement'}}
        CK.action(game, 0, {'type': 'roll'}, Dice())
        self.assertEqual(game['phase'], 'robber')
        CK.action(game, 0, {'type': 'robber', 'target': victim_tile['id']})
        self.assertEqual(game['phase'], 'steal')
        CK.action(game, 0, {'type': 'steal', 'target': 1}, Dice())
        self.assertEqual(game['players'][0]['commodities']['coin'], 1)
        self.assertEqual(game['players'][1]['commodities']['coin'], 0)
        self.assertEqual(game['phase'], 'build')

    def test_city_improvements_claim_and_transfer_metropolis(self):
        game = self.game
        game['phase'] = 'build'
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'},
                             '1': {'owner': 1, 'kind': 'city'}}
        game['players'][0]['commodities']['paper'] = 15
        for level in range(4):
            CK.action(game, 0, {'type': 'improve-city', 'discipline': 'science', 'target': 0})
            self.assertEqual(game['players'][0]['improvements']['science'], level + 1)
        self.assertEqual(game['buildings']['0']['metropolis'], 'science')
        self.assertEqual(game['players'][0]['vp'], 4)
        game['current'] = 1
        game['players'][1]['commodities']['paper'] = 15
        for _ in range(4):
            CK.action(game, 1, {'type': 'improve-city', 'discipline': 'science'})
        self.assertEqual(game['metropolises']['science']['owner'], 0)
        CK.action(game, 1, {'type': 'improve-city', 'discipline': 'science', 'target': 1})
        self.assertEqual(game['metropolises']['science'], {'owner': 1, 'vertex': 1})
        self.assertNotIn('metropolis', game['buildings']['0'])
        self.assertEqual((game['players'][0]['vp'], game['players'][1]['vp']), (2, 4))

    def test_wall_cost_limit_and_pillage_removes_wall(self):
        game = self.game
        game['phase'] = 'build'
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'}}
        game['players'][0]['resources']['brick'] = 2
        CK.action(game, 0, {'type': 'build-wall', 'target': 0})
        self.assertEqual(game['players'][0]['resources']['brick'], 0)
        self.assertEqual(CK.discard_limit(game, 0), 9)
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'build-wall', 'target': 0})
        CK.pillage(game, 0, 0)
        self.assertNotIn('wall', game['buildings']['0'])
        self.assertEqual(CK.discard_limit(game, 0), 7)

    def test_knight_build_activate_upgrade_move_and_level_limit(self):
        game = self.game
        game['phase'] = 'build'
        game['turn'] = 2
        first = base.EDGES[0]
        next_edge = next(edge for edge in base.EDGES[1:] if first['ends'][1] in edge['ends'])
        start = first['ends'][0]
        destination = next(vertex for vertex in next_edge['ends'] if vertex != first['ends'][1])
        game['roads'] = {str(first['id']): 0, str(next_edge['id']): 0}
        game['players'][0]['resources'].update(sheep=4, ore=4, wheat=2)
        CK.action(game, 0, {'type': 'build-knight', 'target': start})
        CK.action(game, 0, {'type': 'activate-knight', 'target': start})
        CK.action(game, 0, {'type': 'upgrade-knight', 'target': start})
        self.assertEqual(game['knightPieces'][str(start)]['level'], 2)
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'upgrade-knight', 'target': start})
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'move-knight', 'target': start, 'destination': destination})
        CK.action(game, 0, {'type': 'end'})
        game['current'] = 0
        game['phase'] = 'build'
        CK.action(game, 0, {'type': 'move-knight', 'target': start, 'destination': destination})
        self.assertNotIn(str(start), game['knightPieces'])
        self.assertFalse(game['knightPieces'][str(destination)]['active'])
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'upgrade-knight', 'target': destination})
        game['players'][0]['improvements']['politics'] = 3
        CK.action(game, 0, {'type': 'upgrade-knight', 'target': destination})
        self.assertEqual(game['knightPieces'][str(destination)]['level'], 3)

    def test_barbarian_defense_awards_point_and_deactivates_knights(self):
        class Dice:
            def __init__(self): self.faces = iter((2, 3, 1))
            def randint(self, _low, _high): return next(self.faces)

        game = self.game
        game['phase'] = 'roll'
        game['barbarianPosition'] = 6
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'}}
        game['knightPieces'] = {'1': {'owner': 0, 'level': 1, 'active': True,
                                      'placedTurn': 0, 'activatedTurn': 0}}
        CK.action(game, 0, {'type': 'roll'}, Dice())
        self.assertEqual(game['barbarianAttacks'], 1)
        self.assertEqual(game['barbarianPosition'], 0)
        self.assertEqual(game['players'][0]['defenderVP'], 1)
        self.assertFalse(game['knightPieces']['1']['active'])
        self.assertEqual(game['lastBarbarianBattle']['defenders'], 1)
        self.assertEqual(game['phase'], 'build')

    def test_tied_defenders_queue_progress_card_choices(self):
        game = self.game
        game['current'] = 2
        game['dice'] = [2, 3]
        game['pendingRoll'] = 5
        game['rolls'].append({'player': 2, 'dice': [2, 3], 'event': 'barbarian'})
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'}}
        game['knightPieces'] = {'1': {'owner': 0, 'level': 1, 'active': True},
                                 '2': {'owner': 2, 'level': 1, 'active': True}}
        CK.begin_attack(game)
        self.assertEqual(game['defenderRewards'], [2, 0])
        self.assertEqual(game['players'][0]['defenderVP'], 0)
        self.assertEqual(game['barbarianAttacks'], 1)
        self.assertEqual(game['phase'], 'defender-reward')
        self.assertEqual(game['pendingRoll'], 5)

    def test_aqueduct_and_merchant_guild_abilities(self):
        game = self.game
        game['phase'] = 'roll'
        game['dice'] = [2, 3]
        game['rolls'].append({'player': 0, 'dice': [2, 3], 'event': 'trade'})
        game['players'][1]['improvements']['science'] = 3
        CK.finish_numbered_dice(game)
        self.assertEqual(game['phase'], 'aqueduct')
        CK.action(game, 1, {'type': 'aqueduct', 'resource': 'ore'})
        self.assertEqual(game['phase'], 'build')
        self.assertEqual(game['players'][1]['resources']['ore'], 1)
        game['players'][0]['improvements']['trade'] = 3
        game['players'][0]['commodities']['cloth'] = 2
        CK.action(game, 0, {'type': 'tradehouse-exchange', 'give': 'cloth', 'receive': 'coin'})
        self.assertEqual(game['players'][0]['commodities']['coin'], 1)
        self.assertEqual(game['players'][0]['commodities']['cloth'], 0)

    def test_displaced_knight_relocates_on_own_road_and_stays_active(self):
        game = self.game
        game['phase'] = 'build'
        game['turn'] = 3
        first = base.EDGES[0]
        second = next(edge for edge in base.EDGES[1:] if first['ends'][1] in edge['ends'])
        start = first['ends'][0]
        enemy = next(vertex for vertex in second['ends'] if vertex != first['ends'][1])
        third = next(edge for edge in base.EDGES if enemy in edge['ends'] and
                     edge['id'] not in (first['id'], second['id']))
        retreat = next(vertex for vertex in third['ends'] if vertex != enemy)
        game['roads'] = {str(first['id']): 0, str(second['id']): 0, str(third['id']): 1}
        game['knightPieces'] = {
            str(start): {'owner': 0, 'level': 2, 'active': True, 'placedTurn': 1, 'activatedTurn': 1},
            str(enemy): {'owner': 1, 'level': 1, 'active': True, 'placedTurn': 1, 'activatedTurn': 1},
        }
        CK.action(game, 0, {'type': 'move-knight', 'target': start, 'destination': enemy})
        self.assertEqual(game['phase'], 'relocate-knight')
        self.assertEqual(game['displacedKnight']['owner'], 1)
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'relocate-knight', 'target': retreat})
        CK.action(game, 1, {'type': 'relocate-knight', 'target': retreat})
        self.assertEqual(game['phase'], 'build')
        self.assertTrue(game['knightPieces'][str(retreat)]['active'])
        self.assertFalse(game['knightPieces'][str(enemy)]['active'])

    def test_tied_unprotected_cities_are_each_pillaged(self):
        game = self.game
        game['dice'] = [2, 3]
        game['rolls'].append({'player': 0, 'dice': [2, 3], 'event': 'barbarian'})
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'},
                             '1': {'owner': 1, 'kind': 'city'},
                             '2': {'owner': 2, 'kind': 'city', 'metropolis': 'science'}}
        CK.begin_attack(game)
        self.assertEqual(game['barbarianLosses'], [0, 1])
        with self.assertRaises(base.Invalid):
            CK.action(game, 2, {'type': 'barbarian-loss', 'target': 2})
        CK.action(game, 0, {'type': 'barbarian-loss', 'target': 0})
        self.assertEqual(game['phase'], 'barbarian-loss')
        CK.action(game, 1, {'type': 'barbarian-loss', 'target': 1})
        self.assertEqual(game['barbarianAttacks'], 1)
        self.assertEqual(game['phase'], 'build')
        self.assertEqual([game['buildings'][str(i)]['kind'] for i in range(3)],
                         ['settlement', 'settlement', 'city'])

    def test_pillaged_city_without_settlement_piece_must_be_restored_first(self):
        game = self.game
        game['phase'] = 'build'
        game['players'][0]['settlement'] = 0
        game['players'][0]['city'] = 0
        game['players'][0]['resources'].update(wheat=2, ore=3)
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'},
                             '1': {'owner': 0, 'kind': 'settlement'}}
        CK.pillage(game, 0, 0)
        self.assertTrue(game['buildings']['0']['damagedCity'])
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'build', 'piece': 'city', 'target': 1})
        CK.action(game, 0, {'type': 'build', 'piece': 'city', 'target': 0})
        self.assertEqual(game['buildings']['0']['kind'], 'city')
        self.assertNotIn('damagedCity', game['buildings']['0'])
        self.assertEqual(game['players'][0]['city'], 0)

    def test_defender_point_can_end_game_before_production(self):
        game = self.game
        game['dice'] = [2, 3]
        game['rolls'].append({'player': 0, 'dice': [2, 3], 'event': 'barbarian'})
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'}}
        game['players'][0]['defenderVP'] = 10
        game['knightPieces'] = {'1': {'owner': 0, 'level': 1, 'active': True}}
        CK.begin_attack(game)
        self.assertEqual(game['players'][0]['vp'], 13)
        self.assertEqual(game['winner'], 0)
        self.assertEqual(game['phase'], 'finished')
        self.assertNotIn('production', game['rolls'][-1])

    def test_enemy_knight_interrupts_longest_road(self):
        game = self.game

        def path(vertex, used, vertices):
            if len(used) == 5:
                return used, vertices
            for edge in base.VERTICES[vertex]['edges']:
                other = next(v for v in base.EDGES[edge]['ends'] if v != vertex)
                if edge not in used and other not in vertices:
                    found = path(other, used + [edge], vertices + [other])
                    if found:
                        return found
            return None

        edges, vertices = next(path(start, [], [start]) for start in range(len(base.VERTICES))
                               if path(start, [], [start]))
        game['roads'] = {str(edge): 0 for edge in edges}
        CK.awards(game)
        self.assertEqual(game['longest'], 0)
        game['knightPieces'][str(vertices[2])] = {'owner': 1, 'level': 1, 'active': False}
        CK.awards(game)
        self.assertLess(game['players'][0]['longest'], 5)
        self.assertIsNone(game['longest'])

    def test_knight_can_chase_robber_only_after_first_attack(self):
        game = self.game
        game['phase'] = 'build'
        game['turn'] = 2
        vertex = game['tiles'][game['robber']]['corners'][0]
        game['knightPieces'][str(vertex)] = {'owner': 0, 'level': 1, 'active': True,
                                               'placedTurn': 0, 'activatedTurn': 1}
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'chase-robber', 'target': vertex})
        game['barbarianAttacks'] = 1
        CK.action(game, 0, {'type': 'chase-robber', 'target': vertex})
        self.assertEqual(game['phase'], 'robber')
        self.assertFalse(game['knightPieces'][str(vertex)]['active'])

    def test_one_city_cannot_hold_two_metropolises(self):
        game = self.game
        game['phase'] = 'build'
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city', 'metropolis': 'science'}}
        game['metropolises']['science'] = {'owner': 0, 'vertex': 0}
        game['players'][0]['improvements']['science'] = 4
        game['players'][0]['improvements']['trade'] = 3
        game['players'][0]['commodities']['cloth'] = 4
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'improve-city', 'discipline': 'trade', 'target': 0})
        self.assertEqual(game['players'][0]['commodities']['cloth'], 4)


if __name__ == '__main__':
    unittest.main()
