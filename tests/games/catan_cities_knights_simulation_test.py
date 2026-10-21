"""Deterministic complete Cities & Knights match with conservation checks."""
import random
import unittest

from app import catan_cities_knights as CK
from app import catan_rules as base


class CitiesKnightsMatchTests(unittest.TestCase):
    def test_complete_match(self):
        rng = random.Random(22)
        game = CK.create(['A', 'B', 'C'], rng)
        actions = 0

        def move(owner, **data):
            nonlocal actions
            CK.action(game, owner, data, rng)
            actions += 1
            for kind in base.RESOURCES:
                self.assertEqual(game['bank'][kind] + sum(p['resources'][kind] for p in game['players']), 19)
            for kind in CK.COMMODITIES:
                self.assertEqual(game['commodityBank'][kind] + sum(p['commodities'][kind] for p in game['players']), 12)

        def wealth(player, kind):
            return player['resources'][kind] if kind in base.RESOURCES else player['commodities'][kind]

        for step in range(12000):
            if game['winner'] is not None:
                break
            owner, phase = game['current'], game['phase']
            player = game['players'][owner]
            if phase.startswith('setup'):
                piece = phase.removeprefix('setup-')
                legal = CK.view(game, owner)['legal'][piece]
                if piece in ('city', 'settlement'):
                    def score(vertex):
                        tiles = [game['tiles'][i] for i in base.VERTICES[vertex]['tiles']]
                        return sum(6 - abs(7 - tile['number']) for tile in tiles if tile['number']) + (
                            3 if piece == 'city' and any(tile['type'] in CK.CITY_OUTPUT for tile in tiles) else 0)
                    target = max(legal, key=score)
                else:
                    target = rng.choice(legal)
                move(owner, type='build', piece=piece, target=target)
            elif phase == 'roll':
                move(owner, type='roll')
            elif phase == 'discard':
                owner = game['discard'][0]['owner']; player = game['players'][owner]
                card = max((*base.RESOURCES, *CK.COMMODITIES), key=lambda kind: wealth(player, kind))
                move(owner, type='discard', resource=card)
            elif phase == 'robber':
                target = rng.choice([tile['id'] for tile in game['tiles'] if tile['id'] != game['robber']])
                move(owner, type='robber', target=target)
            elif phase == 'steal':
                move(owner, type='steal', target=game['victims'][0])
            elif phase == 'barbarian-loss':
                owner = game['barbarianLosses'][0]
                move(owner, type='barbarian-loss', target=CK.player_cities(game, owner, vulnerable=True)[0])
            elif phase == 'defender-reward':
                move(game['defenderRewards'][0], type='defender-reward', discipline='science')
            elif phase == 'progress-discard':
                owner = game['progressOverflow']
                move(owner, type='discard-progress', card=game['players'][owner]['progress'][0])
            elif phase == 'aqueduct':
                owner = game['aqueductChoices'][0]
                resource = max(base.RESOURCES, key=lambda kind: game['bank'][kind])
                move(owner, type='aqueduct', resource=resource)
            elif phase == 'free-road':
                legal = CK.view(game, owner)['legal']['road']
                move(owner, type='build', piece='road', target=rng.choice(legal))
            elif phase == 'build':
                # Return unused cards to avoid blocking the end of a turn.
                if player['progress']:
                    move(owner, type='discard-progress', card=player['progress'][0]); continue
                cities = CK.player_cities(game, owner)
                improvements = player['improvements']
                did_move = False
                for discipline, commodity in CK.IMPROVEMENT_COMMODITY.items():
                    level = improvements[discipline]
                    if not cities or level >= 5 or wealth(player, commodity) < level + 1:
                        continue
                    for target in [None, *cities]:
                        try:
                            move(owner, type='improve-city', discipline=discipline, target=target)
                            did_move = True
                            break
                        except base.Invalid:
                            pass
                    if did_move:
                        break
                if did_move: continue
                for piece in ('city', 'settlement', 'road'):
                    legal = CK.view(game, owner)['legal'][piece]
                    if not legal or not all(player['resources'][kind] >= count for kind, count in base.COSTS[piece].items()):
                        continue
                    for target in legal:
                        try:
                            move(owner, type='build', piece=piece, target=target)
                            did_move = True
                            break
                        except base.Invalid:
                            pass
                    if did_move:
                        break
                if did_move: continue
                move(owner, type='end')
            else:
                self.fail(f'Unhandled phase {phase}')
        self.assertIsNotNone(game['winner'], f'No winner after {game["turn"]} turns and {actions} actions')
        self.assertGreaterEqual(game['players'][game['winner']]['vp'], 13)
        self.assertEqual(game['phase'], 'finished')


if __name__ == '__main__':
    unittest.main()
