"""Progress-card deck, timing, privacy, and representative card effects."""

import random
import unittest
from pathlib import Path

from app import catan_cities_knights as CK
from app import catan_progress as P
from app import catan_rules as base


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.game = CK.create(['A', 'B', 'C'], random.Random(11))
        self.game['phase'] = 'build'

    def play(self, card, **options):
        self.game['players'][0]['progress'].append(card)
        CK.action(self.game, 0, {'type': 'play-progress', 'card': card, **options}, random.Random(4))

    def test_playing_progress_cards_sets_a_shared_sound_event(self):
        self.play('trade_merchant_fleet', resource='wood')
        self.assertEqual(self.game['audioEvent'], {'id': 1, 'cue': 'sfx_devcard_used'})
        self.play('trade_resource_monopoly', resource='wood')
        self.assertEqual(CK.view(self.game, 1)['audioEvent'],
                         {'id': 2, 'cue': 'sfx_devcard_monopoly'})

    def test_three_complete_decks_match_imported_artwork(self):
        assets = Path(__file__).resolve().parents[2] / 'static/assets/catan/colonist/cities-knights'
        for discipline, deck in self.game['progressDecks'].items():
            self.assertEqual(len(deck), 18)
            self.assertEqual(set(deck), {f'{discipline}_{name}' for name in P.CARD_COUNTS[discipline]})
            self.assertTrue(all((assets / f'card_progress_{card}.svg').is_file() for card in deck))
        self.assertEqual(sum(map(len, self.game['progressDecks'].values())), 54)

    def test_event_draw_order_and_off_turn_overflow_before_production(self):
        class Dice:
            def __init__(self): self.faces = iter((2, 3, 4))
            def randint(self, _low, _high): return next(self.faces)

        game = self.game
        game['phase'] = 'roll'
        game['current'] = 2
        game['players'][2]['improvements']['science'] = 1
        game['players'][0]['improvements']['science'] = 1
        game['players'][0]['progress'] = ['trade_merchant'] * 4
        game['progressDecks']['science'] = ['science_crane', 'science_engineer']
        CK.action(game, 2, {'type': 'roll'}, Dice())
        self.assertEqual(game['players'][2]['progress'], ['science_engineer'])
        self.assertEqual(game['players'][0]['progress'][-1], 'science_crane')
        self.assertEqual(game['phase'], 'progress-discard')
        self.assertEqual(game['progressOverflow'], 0)
        self.assertNotIn('production', game['rolls'][-1])
        CK.action(game, 0, {'type': 'discard-progress', 'card': 'science_crane'})
        self.assertEqual(game['phase'], 'build')
        self.assertEqual(len(game['players'][0]['progress']), 4)
        self.assertEqual(game['progressDecks']['science'][0], 'science_crane')
        self.assertIn('production', game['rolls'][-1])

    def test_victory_point_card_reveals_immediately_and_is_public(self):
        class Dice:
            def __init__(self): self.faces = iter((1, 3, 4))
            def randint(self, _low, _high): return next(self.faces)

        game = self.game
        game['phase'] = 'roll'
        game['players'][1]['improvements']['science'] = 1
        game['progressDecks']['science'] = ['science_printer']
        CK.action(game, 0, {'type': 'roll'}, Dice())
        self.assertEqual(game['players'][1]['progressVP'], ['science_printer'])
        self.assertEqual(game['players'][1]['progress'], [])
        self.assertEqual(game['players'][1]['vp'], 1)
        self.assertEqual(CK.view(game, 0)['players'][1]['progressVP'], ['science_printer'])

    def test_alchemist_sets_both_numbered_dice_but_event_is_random(self):
        class Event:
            def __init__(self): self.calls = 0
            def randint(self, low, high):
                self.calls += 1
                return 1

        game = self.game
        game['phase'] = 'roll'
        game['players'][0]['progress'] = ['science_alchemist']
        CK.action(game, 0, {'type': 'play-progress', 'card': 'science_alchemist', 'dice': [6, 1]})
        event = Event()
        CK.action(game, 0, {'type': 'roll'}, event)
        self.assertEqual(event.calls, 1)
        self.assertEqual(game['dice'], [6, 1])
        self.assertEqual(game['eventDie'], 'barbarian')
        self.assertEqual(game['phase'], 'build')
        self.assertEqual(game['progressDecks']['science'][0], 'science_alchemist')

    def test_science_cards_change_board_and_apply_discount(self):
        game = self.game
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'},
                             '1': {'owner': 0, 'kind': 'settlement'}}
        game['players'][0]['resources'].update(brick=2, wheat=1, ore=2)
        self.play('science_engineer', target=0)
        self.assertTrue(game['buildings']['0']['wall'])
        self.assertEqual(game['players'][0]['resources']['brick'], 2)
        self.play('science_crane', discipline='science')
        self.assertEqual(game['players'][0]['improvements']['science'], 1)
        self.assertEqual(game['players'][0]['commodities']['paper'], 0)
        self.play('science_medicine', target=1)
        self.assertEqual(game['buildings']['1']['kind'], 'city')
        tiles = [tile for tile in game['tiles'] if tile['number'] not in (None, 2, 6, 8, 12)]
        a, b = tiles[:2]
        old = a['number'], b['number']
        self.play('science_inventor', targets=[a['id'], b['id']])
        self.assertEqual((a['number'], b['number']), old[::-1])

    def test_science_income_and_free_build_actions(self):
        game = self.game
        wheat = next(tile for tile in game['tiles'] if tile['type'] == 'wheat')
        ore = next(tile for tile in game['tiles'] if tile['type'] == 'ore')
        game['buildings'] = {str(wheat['corners'][0]): {'owner': 0, 'kind': 'settlement'},
                             str(ore['corners'][0]): {'owner': 0, 'kind': 'city'}}
        self.play('science_irrigation')
        self.play('science_mining')
        self.assertGreaterEqual(game['players'][0]['resources']['wheat'], 2)
        self.assertGreaterEqual(game['players'][0]['resources']['ore'], 2)
        road = next(edge for edge in base.EDGES if wheat['corners'][0] in edge['ends'])
        self.play('science_road_building')
        self.assertEqual(game['phase'], 'free-road')
        CK.action(game, 0, {'type': 'build', 'piece': 'road', 'target': road['id']})
        self.assertEqual(game['players'][0]['road'], 14)

    def test_smith_and_warlord_upgrade_and_activate_free(self):
        game = self.game
        game['knightPieces'] = {'0': {'owner': 0, 'level': 1, 'active': False,
                                      'placedTurn': 0},
                                 '1': {'owner': 0, 'level': 1, 'active': False,
                                      'placedTurn': 0}}
        self.play('science_smith', targets=[0, 1])
        self.assertEqual([piece['level'] for piece in game['knightPieces'].values()], [2, 2])
        self.play('politics_warlord')
        self.assertTrue(all(piece['active'] for piece in game['knightPieces'].values()))
        self.assertEqual(game['players'][0]['resources']['wheat'], 0)

    def test_trade_monopolies_merchant_and_fleet(self):
        game = self.game
        game['players'][1]['resources']['wood'] = 3
        game['players'][2]['resources']['wood'] = 1
        game['players'][1]['commodities']['coin'] = 2
        game['players'][2]['commodities']['coin'] = 1
        self.play('trade_resource_monopoly', resource='wood')
        self.play('trade_commodity_monopoly', commodity='coin')
        self.assertEqual(game['players'][0]['resources']['wood'], 3)
        self.assertEqual(game['players'][0]['commodities']['coin'], 2)
        tile = next(tile for tile in game['tiles'] if tile['type'] == 'wood')
        game['buildings'] = {str(tile['corners'][0]): {'owner': 0, 'kind': 'city'}}
        self.play('trade_merchant', target=tile['id'])
        self.assertEqual(game['players'][0]['vp'], 3)
        self.assertEqual(CK.trade_rate(game, 0, 'wood'), 2)
        self.play('trade_merchant_fleet', resource='coin')
        self.assertEqual(CK.trade_rate(game, 0, 'coin'), 2)

    def test_spy_and_master_merchant_private_previews(self):
        game = self.game
        game['players'][1]['progress'] = ['science_crane']
        self.play('politics_spy', target=1)
        self.assertEqual(game['phase'], 'spy-take')
        self.assertEqual(CK.view(game, 0)['privatePreview']['progress'], ['science_crane'])
        self.assertIsNone(CK.view(game, 2)['privatePreview'])
        self.assertIsNone(CK.view(game, 2)['players'][1]['progress'])
        CK.action(game, 0, {'type': 'spy-take', 'card': 'science_crane'})
        self.assertIn('science_crane', game['players'][0]['progress'])
        game['players'][1]['defenderVP'] = 3
        CK.awards(game)
        game['players'][1]['commodities']['cloth'] = 2
        self.play('trade_master_merchant', target=1)
        self.assertEqual(CK.view(game, 0)['privatePreview']['cards']['cloth'], 2)
        self.assertIsNone(CK.view(game, 2)['privatePreview'])
        CK.action(game, 0, {'type': 'merchant-take', 'card': 'cloth'})
        CK.action(game, 0, {'type': 'merchant-take', 'card': 'cloth'})
        self.assertEqual(game['players'][0]['commodities']['cloth'], 2)
        self.assertEqual(game['phase'], 'build')

    def test_bishop_steals_from_each_adjacent_player(self):
        game = self.game
        game['barbarianAttacks'] = 1
        target = next(tile for tile in game['tiles'] if tile['id'] != game['robber'])
        game['buildings'] = {
            str(target['corners'][0]): {'owner': 1, 'kind': 'settlement'},
            str(target['corners'][2]): {'owner': 2, 'kind': 'city'},
        }
        game['players'][1]['resources']['wood'] = 1
        game['players'][2]['commodities']['coin'] = 1
        self.play('politics_bishop', target=target['id'])
        self.assertEqual(game['robber'], target['id'])
        self.assertEqual(game['players'][0]['resources']['wood'], 1)
        self.assertEqual(game['players'][0]['commodities']['coin'], 1)

    def test_deserter_and_intrigue_keep_opponent_choices(self):
        game = self.game
        owner_edge = base.EDGES[0]
        source = owner_edge['ends'][0]
        replacement = owner_edge['ends'][1]
        enemy_edge = next(edge for edge in base.EDGES if source in edge['ends'] and
                          edge['id'] != owner_edge['id'])
        retreat = next(vertex for vertex in enemy_edge['ends'] if vertex != source)
        game['roads'] = {str(owner_edge['id']): 0, str(enemy_edge['id']): 1}
        game['knightPieces'][str(source)] = {'owner': 1, 'level': 1, 'active': True,
                                              'placedTurn': 0, 'activatedTurn': 0}
        self.play('politics_intrigue', target=source)
        self.assertEqual(game['phase'], 'relocate-knight')
        CK.action(game, 1, {'type': 'relocate-knight', 'target': retreat})
        self.assertTrue(game['knightPieces'][str(retreat)]['active'])
        self.play('politics_deserter', target=1)
        self.assertEqual(game['phase'], 'deserter-pick')
        CK.action(game, 1, {'type': 'deserter-pick', 'target': retreat})
        CK.action(game, 0, {'type': 'deserter-place', 'target': replacement})
        self.assertEqual(game['knightPieces'][str(replacement)]['owner'], 0)
        self.assertTrue(game['knightPieces'][str(replacement)]['active'])

    def test_diplomat_removes_open_enemy_road(self):
        game = self.game
        game['roads'] = {'0': 1}
        self.play('politics_diplomat', road=0)
        self.assertNotIn('0', game['roads'])
        self.assertEqual(game['players'][1]['road'], 16)

    def test_saboteur_and_wedding_force_each_target_to_choose(self):
        game = self.game
        game['players'][1]['resources']['wood'] = 4
        self.play('politics_saboteur')
        self.assertEqual(game['phase'], 'progress-forced-discard')
        CK.action(game, 1, {'type': 'progress-forced-discard', 'resource': 'wood'})
        CK.action(game, 1, {'type': 'progress-forced-discard', 'resource': 'wood'})
        self.assertEqual(game['phase'], 'build')
        self.assertEqual(game['players'][1]['resources']['wood'], 2)
        game['players'][1]['defenderVP'] = 3
        CK.awards(game)
        self.play('politics_wedding')
        self.assertEqual(game['phase'], 'wedding-gift')
        CK.action(game, 1, {'type': 'wedding-gift', 'resource': 'wood'})
        CK.action(game, 1, {'type': 'wedding-gift', 'resource': 'wood'})
        self.assertEqual(game['players'][0]['resources']['wood'], 2)
        self.assertEqual(game['phase'], 'build')

    def test_commercial_harbor_and_fleet_bank_trade(self):
        game = self.game
        game['players'][0]['resources']['wood'] = 1
        game['players'][1]['commodities']['paper'] = 1
        self.play('trade_commercial_harbor')
        CK.action(game, 0, {'type': 'harbor-offer', 'target': 1, 'resource': 'wood'})
        self.assertEqual(game['phase'], 'harbor-response')
        CK.action(game, 1, {'type': 'harbor-response', 'commodity': 'paper'})
        self.assertEqual(game['players'][0]['commodities']['paper'], 1)
        self.assertEqual(game['players'][1]['resources']['wood'], 1)
        game['players'][0]['commodities']['coin'] = 2
        self.play('trade_merchant_fleet', resource='coin')
        CK.action(game, 0, {'type': 'bank-trade', 'give': {'coin': 2}, 'receive': {'ore': 1}})
        self.assertEqual(game['players'][0]['resources']['ore'], 1)

    def test_defense_tie_rewards_draw_before_production(self):
        game = self.game
        game['dice'] = [2, 3]
        game['pendingRoll'] = 5
        game['rolls'].append({'player': 0, 'dice': [2, 3], 'event': 'barbarian'})
        game['buildings'] = {'0': {'owner': 0, 'kind': 'city'}}
        game['knightPieces'] = {'1': {'owner': 0, 'level': 1, 'active': True},
                                 '2': {'owner': 1, 'level': 1, 'active': True}}
        game['progressDecks']['trade'] = ['trade_merchant']
        game['progressDecks']['politics'] = ['politics_spy']
        CK.begin_attack(game)
        self.assertEqual(game['phase'], 'defender-reward')
        CK.action(game, 0, {'type': 'defender-reward', 'discipline': 'trade'})
        self.assertEqual(game['phase'], 'defender-reward')
        CK.action(game, 1, {'type': 'defender-reward', 'discipline': 'politics'})
        self.assertEqual(game['phase'], 'build')
        self.assertIn('production', game['rolls'][-1])
        self.assertEqual(game['players'][0]['progress'], ['trade_merchant'])
        self.assertEqual(game['players'][1]['progress'], ['politics_spy'])

    def test_current_player_must_reduce_progress_hand_before_ending(self):
        game = self.game
        game['players'][0]['progress'] = ['science_crane'] * 5
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'end'})
        CK.action(game, 0, {'type': 'discard-progress', 'card': 'science_crane'})
        CK.action(game, 0, {'type': 'end'})
        self.assertEqual(game['current'], 1)


if __name__ == '__main__':
    unittest.main()
