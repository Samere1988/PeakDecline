import copy
import random
import unittest

from app import catan_cities_knights as CK
from app import catan_rules as base


class CitiesKnightsTradeTests(unittest.TestCase):
    def setUp(self):
        self.game = CK.create(['A', 'B', 'C'], random.Random(7))
        self.game['phase'] = 'build'
        self.game['players'][0]['resources']['wood'] = 2
        self.game['players'][0]['commodities']['paper'] = 2
        self.game['players'][1]['resources']['ore'] = 2
        self.game['players'][1]['commodities']['cloth'] = 2
        self.game['players'][2]['commodities']['cloth'] = 2

    def offer(self, give=None, want=None):
        CK.action(self.game, 0, {'type': 'offer', 'give': give or {}, 'want': want or {}})
        return self.game['offers'][0]['id']

    def test_mixed_cards_move_between_players_without_changing_banks(self):
        game = self.game
        before_banks = (game['bank'].copy(), game['commodityBank'].copy())
        offer = self.offer({'wood': 1, 'paper': 1}, {'ore': 1, 'cloth': 1})
        self.assertEqual(CK.view(game, 1)['audioEvent'], {'id': 1, 'cue': 'sfx_offer_acceptable'})
        CK.action(game, 1, {'type': 'accept-trade', 'offer': offer})
        self.assertEqual(game['audioEvent'], {'id': 2, 'cue': 'sfx_offer_acceptable'})
        CK.action(game, 0, {'type': 'confirm-trade', 'offer': offer, 'target': 1})
        self.assertEqual(game['audioEvent'], {'id': 3, 'cue': 'sfx_offer_accepted'})
        self.assertEqual((game['players'][0]['resources']['wood'],
                          game['players'][0]['commodities']['paper'],
                          game['players'][0]['resources']['ore'],
                          game['players'][0]['commodities']['cloth']), (1, 1, 1, 1))
        self.assertEqual((game['players'][1]['resources']['wood'],
                          game['players'][1]['commodities']['paper'],
                          game['players'][1]['resources']['ore'],
                          game['players'][1]['commodities']['cloth']), (1, 1, 1, 1))
        self.assertEqual((game['bank'], game['commodityBank']), before_banks)
        self.assertEqual(game['offers'], [])

    def test_open_offer_requires_counter_and_counter_uses_current_player_perspective(self):
        game = self.game
        offer = self.offer({'wood': 1}, {})
        with self.assertRaises(base.Invalid):
            CK.action(game, 1, {'type': 'accept-trade', 'offer': offer})
        CK.action(game, 1, {'type': 'counter-trade', 'offer': offer,
                            'give': {'cloth': 1}, 'want': {'wood': 1}})
        counter = game['offers'][-1]
        self.assertEqual(counter['give']['wood'], 1)
        self.assertEqual(counter['want']['cloth'], 1)
        self.assertEqual(counter['responses'], {'1': 'accepted'})
        CK.action(game, 0, {'type': 'confirm-trade', 'offer': counter['id'], 'target': 1})
        self.assertEqual(game['players'][0]['commodities']['cloth'], 1)

    def test_blocked_players_auto_decline_and_offer_resolves(self):
        game = self.game
        CK.action(game, 1, {'type': 'embargo', 'target': 0})
        offer = self.offer({'wood': 1}, {'cloth': 1})
        self.assertEqual(game['offers'][0]['responses']['1'], 'rejected')
        CK.action(game, 2, {'type': 'reject-trade', 'offer': offer})
        self.assertTrue(game['offers'][0]['allRejected'])
        with self.assertRaises(base.Invalid):
            CK.action(game, 2, {'type': 'accept-trade', 'offer': offer})

    def test_decline_embargo_cancel_and_turn_expiry(self):
        game = self.game
        offer = self.offer({'paper': 1}, {'cloth': 1})
        CK.action(game, 1, {'type': 'reject-trade', 'offer': offer})
        self.assertEqual(game['audioEvent']['cue'], 'sfx_offer_rejected')
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'confirm-trade', 'offer': offer, 'target': 1})
        CK.action(game, 1, {'type': 'accept-trade', 'offer': offer})
        CK.action(game, 0, {'type': 'embargo', 'target': 1})
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'confirm-trade', 'offer': offer, 'target': 1})
        CK.action(game, 0, {'type': 'embargo', 'target': 1})
        CK.action(game, 2, {'type': 'accept-trade', 'offer': offer})
        CK.action(game, 0, {'type': 'cancel-trade', 'offer': offer})
        self.assertEqual(game['offers'], [])
        self.offer({'wood': 1}, {'cloth': 1})
        CK.action(game, 0, {'type': 'end'})
        self.assertEqual(game['offers'], [])

    def test_trade_rechecks_hands_and_rejects_progress_cards(self):
        game = self.game
        for give, want in (({'science_crane': 1}, {'cloth': 1}),
                           ({'paper': -1}, {'cloth': 1}),
                           ({'paper': True}, {'cloth': 1}),
                           ({'paper': 1}, {'paper': 1})):
            with self.assertRaises(base.Invalid):
                self.offer(give, want)
        offer = self.offer({'paper': 1}, {'cloth': 1})
        CK.action(game, 1, {'type': 'accept-trade', 'offer': offer})
        game['players'][1]['commodities']['cloth'] = 0
        before = copy.deepcopy(game['players'])
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'confirm-trade', 'offer': offer, 'target': 1})
        self.assertEqual(game['players'], before)

    def test_commodity_bank_trade_and_victory_threshold(self):
        game = self.game
        game['players'][0]['commodities']['paper'] = 4
        before = copy.deepcopy((game['players'][0]['commodities'], game['bank'], game['commodityBank']))
        with self.assertRaises(base.Invalid):
            CK.action(game, 0, {'type': 'bank-trade', 'give': {'paper': 4},
                                'receive': {'ore': 1, 'coin': 1}})
        self.assertEqual((game['players'][0]['commodities'], game['bank'], game['commodityBank']), before)
        CK.action(game, 0, {'type': 'bank-trade', 'give': {'paper': 4},
                            'receive': {'ore': 1}})
        self.assertEqual(game['players'][0]['commodities']['paper'], 0)
        self.assertEqual(game['players'][0]['resources']['ore'], 1)
        game['buildings'] = {str(i): {'owner': 0, 'kind': 'city'} for i in range(4)}
        game['buildings'].update({str(i): {'owner': 0, 'kind': 'settlement'} for i in range(4, 6)})
        game['players'][0]['defenderVP'] = 2
        CK.awards(game)
        self.assertEqual(game['players'][0]['vp'], 12)
        self.assertIsNone(game['winner'])
        game['players'][0]['progressVP'] = ['science_printer']
        CK.awards(game)
        self.assertEqual(game['winner'], 0)
        self.assertEqual(game['phase'], 'finished')

    def test_starting_city_locations_are_in_private_board_snapshot(self):
        game = self.game
        game['phase'] = 'setup-city'
        self.assertEqual(CK.view(game, 0)['legal']['city'], CK.legal_starting_cities(game))
        self.assertEqual(CK.view(game, 1)['legal']['city'], [])
        self.assertEqual(CK.view(game, 0)['tradeRates']['paper'], 4)
        self.assertIsNone(CK.view(game, None)['tradeRates'])


if __name__ == '__main__':
    unittest.main()
