"""Extended base map and Colonist-style Special Build Phase."""
import collections
import random
import tempfile
import unittest
import uuid
from pathlib import Path

from app import catan_rules as rules
from app import catan_cities_knights as ck
from app.catan_maps import EXTENDED
from tests.games.catan_online_test import test_app


class StandardHarborTests(unittest.TestCase):
    def test_fixed_sites_with_shuffled_harbor_types(self):
        for engine in (rules, ck):
            games = [engine.create(list('ABCD'), random.Random(seed)) for seed in range(5)]
            self.assertGreater(len({tuple(port['type'] for port in game['ports']) for game in games}), 1)
            for game in games:
                self.assertEqual([port['edge'] for port in game['ports']],
                                 [port['edge'] for port in rules.PORTS])
                self.assertEqual(collections.Counter(port['type'] for port in game['ports']),
                                 {'any': 4, 'wood': 1, 'brick': 1, 'wheat': 1, 'sheep': 1, 'ore': 1})
                self.assertEqual(engine.view(game, 0)['ports'], rules.topology(game)['ports'])


class ExtendedRulesTests(unittest.TestCase):
    def setUp(self):
        self.game = rules.create(list('ABCDEF'), random.Random(7), map_id='base-56')

    def move(self, seat, **data):
        rules.action(self.game, seat, data, random.Random(5))

    def test_map_contents_and_setup(self):
        game = self.game
        self.assertEqual((len(EXTENDED['tiles']), len(EXTENDED['vertices']), len(EXTENDED['edges']), len(EXTENDED['ports'])), (30, 80, 109, 11))
        self.assertEqual([port['edge'] for port in EXTENDED['ports']], [5, 15, 27, 67, 84, 97, 104, 101, 89, 73, 34])
        self.assertEqual(len({vertex for port in EXTENDED['ports'] for vertex in EXTENDED['edges'][port['edge']]['ends']}), 22)
        self.assertEqual(collections.Counter(port['type'] for port in game['ports']),
                         {'any': 5, 'sheep': 2, 'wood': 1, 'brick': 1, 'wheat': 1, 'ore': 1})
        self.assertEqual([port['edge'] for port in game['ports']],
                         [port['edge'] for port in EXTENDED['ports']])
        harbor_vertex = EXTENDED['edges'][EXTENDED['ports'][0]['edge']]['ends'][0]
        game['buildings'][str(harbor_vertex)] = {'owner': 0, 'kind': 'settlement'}
        game['ports'][0]['edge'] = 0  # A room saved before the layout correction.
        expected_rate = 3 if game['ports'][0]['type'] == 'any' else 2 if game['ports'][0]['type'] == 'ore' else 4
        self.assertEqual(rules.rate(game, 0, 'ore'), expected_rate)
        self.assertEqual(rules.view(game, 0)['ports'][0]['edge'], EXTENDED['ports'][0]['edge'])
        self.assertEqual(rules.view(game, 0)['ports'][0]['type'], game['ports'][0]['type'])
        game['buildings'].clear()
        self.assertEqual(collections.Counter(t['type'] for t in game['tiles']), {'wood': 6, 'sheep': 6, 'wheat': 6, 'brick': 5, 'ore': 5, 'desert': 2})
        self.assertEqual(len(game['deck']), 34)
        self.assertEqual(collections.Counter(t['number'] for t in game['tiles'] if t['number'] in (6, 8)), {6: 3, 8: 3})
        for edge in EXTENDED['edges']:
            if len(edge['tiles']) == 2:
                a, b = (game['tiles'][t]['number'] for t in edge['tiles'])
                self.assertFalse(a in (6, 8) and b in (6, 8))
        order = []
        while game['phase'].startswith('setup'):
            seat = game['current']
            piece = game['phase'].removeprefix('setup-')
            if piece == 'settlement': order.append(seat)
            self.move(seat, type='build', piece=piece, target=rules.legal(game, piece)[0])
        self.assertEqual(order, [0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0])
        self.assertEqual(game['phase'], 'roll')
        self.assertTrue(all(p['vp'] == 2 for p in game['players']))
        for resource in rules.RESOURCES:
            self.assertEqual(game['bank'][resource] + sum(p['resources'][resource] for p in game['players']), 24)

    def test_harbor_types_shuffle_without_moving_docks(self):
        games = [rules.create(list('ABCDE'), random.Random(seed), map_id='base-56') for seed in range(5)]
        self.assertGreater(len({tuple(port['type'] for port in game['ports']) for game in games}), 1)
        self.assertTrue(all([port['edge'] for port in game['ports']] ==
                            [port['edge'] for port in EXTENDED['ports']] for game in games))
        self.assertTrue(all(rules.view(game, 0)['ports'] == rules.topology(game)['ports'] for game in games))

    def test_special_build_turn_order_and_restrictions(self):
        game = self.game
        game['phase'] = 'build'
        self.move(4, type='special-build-flag')
        self.move(2, type='special-build-flag')
        self.move(0, type='end')
        self.assertEqual((game['phase'], game['current'], game['specialQueue']), ('special-build', 2, [4]))
        self.assertEqual(game['turn'], 0)
        for action in ({'type': 'roll'}, {'type': 'offer', 'give': {'wood': 1}, 'want': {}},
                       {'type': 'bank-trade', 'give': 'wood', 'receive': 'ore'},
                       {'type': 'play-development', 'card': 'knight'}):
            with self.assertRaises(rules.Invalid):
                self.move(2, **action)
        game['players'][2]['resources'].update(wheat=1, sheep=1, ore=1)
        game['bank'].update(wheat=23, sheep=23, ore=23)
        self.move(2, type='buy-development')
        self.assertEqual(len(game['deck']), 33)
        self.move(2, type='end')
        self.assertEqual((game['phase'], game['current']), ('special-build', 4))
        self.move(4, type='end')
        self.assertEqual((game['phase'], game['current'], game['turn']), ('roll', 1, 1))
        self.assertEqual(game['specialFlags'], [])
        with self.assertRaises(rules.Invalid):
            self.move(2, type='end')


class ExtendedCitiesKnightsTests(unittest.TestCase):
    def test_setup_and_special_build_rules(self):
        game = ck.create(list('ABCDEF'), random.Random(3), map_id='base-56')
        self.assertEqual(game['commodityBank'], {'paper': 18, 'cloth': 18, 'coin': 18})
        self.assertEqual(len(game['tiles']), 30)
        self.assertEqual([port['edge'] for port in ck.view(game, 0)['ports']],
                         [port['edge'] for port in EXTENDED['ports']])
        self.assertEqual(collections.Counter(port['type'] for port in ck.view(game, 0)['ports']),
                         {'any': 5, 'sheep': 2, 'wood': 1, 'brick': 1, 'wheat': 1, 'ore': 1})
        self.assertEqual(len(game['progressDecks']['science']), 18)
        order = []
        while game['phase'].startswith('setup'):
            owner = game['current']
            piece = game['phase'].removeprefix('setup-')
            if piece != 'road': order.append(owner)
            target = (ck.legal_starting_cities(game)[0] if piece == 'city'
                      else rules.legal(game, piece)[0])
            ck.action(game, owner, {'type': 'build', 'piece': piece, 'target': target}, random.Random(2))
        self.assertEqual(order, [0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0])
        self.assertEqual(game['phase'], 'roll')
        self.assertTrue(all(player['vp'] == 3 for player in game['players']))
        game['phase'] = 'build'
        ck.action(game, 1, {'type': 'special-build-flag'})
        ck.action(game, 0, {'type': 'end'})
        self.assertEqual((game['current'], game['phase']), (1, 'special-build'))
        for move in ({'type': 'bank-trade', 'give': {'wood': 4}, 'receive': {'ore': 1}},
                     {'type': 'play-progress', 'card': 'science_crane'},
                     {'type': 'move-knight', 'target': 0, 'destination': 1},
                     {'type': 'robber', 'target': 0}):
            with self.assertRaises(rules.Invalid): ck.action(game, 1, move)
        game['players'][1]['resources'].update(sheep=3, ore=3, wheat=2)
        corner = next(vertex['id'] for vertex in EXTENDED['vertices']
                      if not rules.building(game, vertex['id']) and
                      any(rules.road(game, edge) == 1 for edge in vertex['edges']))
        ck.action(game, 1, {'type': 'build-knight', 'target': corner})
        ck.action(game, 1, {'type': 'activate-knight', 'target': corner})
        ck.action(game, 1, {'type': 'upgrade-knight', 'target': corner})
        self.assertEqual((game['knightPieces'][str(corner)]['level'], game['knightPieces'][str(corner)]['active']), (2, True))
        game['players'][1]['defenderVP'] = 10
        ck.awards(game)
        self.assertIsNone(game['winner'])
        ck.action(game, 1, {'type': 'end'})
        self.assertEqual((game['current'], game['turn'], game['winner']), (1, 1, 1))


class ExtendedRoomTests(unittest.TestCase):
    def test_create_five_player_room_and_validate_mode(self):
        with tempfile.TemporaryDirectory() as temp:
            app, _ = test_app(Path(temp) / 'catan.sqlite3')
            clients, tokens = [], []
            for i in range(6):
                client = app.test_client()
                with client.session_transaction() as session:
                    session['_user_id'] = str(i)
                    session['_fresh'] = True
                tokens.append(client.get('/api/catan/lobby').json['csrf'])
                clients.append(client)
            version = 0
            def post(seat, room_id, data):
                nonlocal version
                result = clients[seat].post('/api/catan/rooms/' + room_id + '/actions',
                                            json={**data, 'version': version, 'command': uuid.uuid4().hex},
                                            headers={'X-Catan-CSRF': tokens[seat]})
                if result.status_code == 200: version = result.json['version']
                return result
            invalid = clients[0].post('/api/catan/rooms', json={'mode': 'base', 'map': 'unknown'},
                                      headers={'X-Catan-CSRF': tokens[0]})
            self.assertEqual(invalid.status_code, 400)
            expansion = clients[0].post('/api/catan/rooms', json={'mode': 'cities-knights', 'map': 'base-56'},
                                        headers={'X-Catan-CSRF': tokens[0]})
            self.assertEqual(expansion.status_code, 201)
            self.assertEqual((expansion.json['mode'], expansion.json['map']), ('cities-knights', 'base-56'))
            room_id = expansion.json['id']
            version = expansion.json['version']
            for i in range(1, 5): self.assertEqual(post(i, room_id, {'type': 'join'}).status_code, 200)
            for i in range(5): self.assertEqual(post(i, room_id, {'type': 'ready'}).status_code, 200)
            expanded_game = post(0, room_id, {'type': 'start'})
            self.assertEqual(expanded_game.status_code, 200, expanded_game.json)
            self.assertEqual((len(expanded_game.json['game']['players']), expanded_game.json['game']['commodityBank']['paper']), (5, 18))
            response = clients[0].post('/api/catan/rooms', json={'mode': 'base', 'map': 'base-56'},
                                       headers={'X-Catan-CSRF': tokens[0]})
            self.assertEqual(response.status_code, 201)
            room = response.json
            version = room['version']
            room_id = room['id']
            self.assertEqual((room['map'], len(room['geometry']['tiles']), len(room['preview'])), ('base-56', 30, 30))
            preview_ports = room['geometry']['ports']
            self.assertEqual([port['edge'] for port in preview_ports],
                             [port['edge'] for port in EXTENDED['ports']])
            for i in range(1, 5):
                response = post(i, room_id, {'type': 'join'})
                self.assertEqual(response.status_code, 200, response.json)
            for i in range(5):
                response = post(i, room_id, {'type': 'ready'})
                self.assertEqual(response.status_code, 200, response.json)
            response = post(0, room_id, {'type': 'start'})
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual((response.json['status'], len(response.json['game']['players'])), ('playing', 5))
            self.assertEqual(response.json['game']['map'], 'base-56')
            self.assertEqual(response.json['game']['ports'], preview_ports)
            six = clients[0].post('/api/catan/rooms', json={'mode': 'base', 'map': 'base-56'},
                                  headers={'X-Catan-CSRF': tokens[0]}).json
            room_id = six['id']
            version = six['version']
            for i in range(1, 6):
                response = post(i, room_id, {'type': 'join'})
                self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual([m['seat'] for m in response.json['members']], list(range(6)))
            for i in range(6):
                self.assertEqual(post(i, room_id, {'type': 'ready'}).status_code, 200)
            response = post(0, room_id, {'type': 'start'})
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual(len(response.json['game']['players']), 6)
            self.assertEqual(response.json['game']['players'][5]['color'], 5)
            ck_six = clients[0].post('/api/catan/rooms', json={'mode': 'cities-knights', 'map': 'base-56'},
                                     headers={'X-Catan-CSRF': tokens[0]}).json
            room_id = ck_six['id']
            version = ck_six['version']
            for i in range(1, 6): self.assertEqual(post(i, room_id, {'type': 'join'}).status_code, 200)
            for i in range(6): self.assertEqual(post(i, room_id, {'type': 'ready'}).status_code, 200)
            response = post(0, room_id, {'type': 'start'})
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual((response.json['game']['mode'], len(response.json['game']['players'])), ('cities-knights', 6))
            self.assertEqual(response.json['game']['players'][5]['color'], 5)


if __name__ == '__main__':
    unittest.main()
