# Cities & Knights implementation status

The expansion rules are being built in `app/catan_cities_knights.py`. This module
is separate from the live base-game rules. Room creation now shows the mode, but
its Cities & Knights option is disabled until the rules are playable.

Implemented and tested:

- The second starting placement is a city, in the existing reverse setup order.
- That city receives one resource from each adjacent producing tile at setup.
- On a producing roll, a city on wood, sheep, or ore gets one resource and one
  paper, cloth, or coin commodity respectively. Cities on wheat and brick still
  receive two resources. Settlements receive one resource.
- The commodity bank starts with 12 of each type; the robber blocks production.
- Each expansion roll makes three independent six-sided draws: two numbered dice
  and one event die. The event die has three ship faces and one face for each
  progress-card discipline. Rolls, event results, and each player's production
  are kept in game history.
- A ship advances the barbarian marker. On the seventh advance, combat resolves
  before the numbered dice. Tied defenders wait for their progress-card reward;
  other outcomes resume production or a seven after the battle.
- A seven counts resources and commodities together. Players over the discard
  limit lose half their cards; city walls, when present, add two to that limit.
  Before the first barbarian attack, the robber cannot move. Later, it may move
  and steal a resource or commodity.
- City improvements cost increasing amounts of paper, cloth, or coin; the fourth
  and fifth levels claim or transfer discipline-specific metropolises. The
  aqueduct and merchant-guild abilities are implemented, and the Fortress
  unlocks mighty knights.
- Players can build up to three walls, build/activate/upgrade/move knights,
  displace weaker enemy knights, relocate displaced knights, and chase the
  robber after its first activation. Knights block opposing road continuity.
- Barbarian attacks compare city count with active knight strength. Defenders
  earn a point or queue progress-card choices on a tie. The weakest eligible
  player or tied players choose cities to pillage; metropolises are protected,
  walls are lost with pillaged cities, and all knights deactivate afterwards.
- Expansion points exclude Largest Army and use a 13-point victory threshold.
- The three independently shuffled 18-card progress decks use the card list
  matching the imported Colonist artwork. Colored event results award cards
  using the red die and improvement level in turn order. Defender ties draw
  chosen cards before production. Victory-point cards reveal immediately;
  off-turn fifth cards require an immediate discard, while the current player
  must return to four before ending the turn.
- All 25 progress-card kinds have effects, including Alchemist before rolling,
  discounted and free builds, robber and knight actions, monopolies, forced
  opponent choices, merchant control, and temporary trade rates. Played and
  discarded cards return to the bottom of their own deck.
- The expansion snapshot hides other players' resources, commodities, and
  progress hands. Spy and Master Merchant reveal the selected hand only to the
  acting player while they make their card choice.
- Player offers, counteroffers, acceptance, rejection, embargoes, and confirmed
  exchanges now include resources and commodities. Bank and port exchanges,
  seven discards, and robber theft also handle commodities. Progress cards stay
  outside normal trading. The expansion awards victory at 13 points.
- The expansion interface shows commodities, progress-card artwork, the event
  die, barbarian position, city improvements, walls, metropolises, knights,
  merchant, player and bank trades, and choices that interrupt a turn. Board
  selectors highlight the corners, roads, or tiles listed in each form.

Cities & Knights is available when creating an online room. Room actions are
dispatched to the expansion rules, each seat receives a private snapshot, and
game revision checks, reconnects, spectators, and rematches use the existing
room transport. A deterministic complete engine match and a three-browser
multiplayer flow cover the expansion alongside the unchanged base-game suite.

Rules checked against:

- https://colonist.io/catan-rules/cities-and-knights
- https://www.catan.com/sites/default/files/2025-03/CN3087%20CATAN%E2%80%93Cities%26Knights_%20Rulebook.pdf
- https://www.catan.com/sites/default/files/2021-06/catan_c_k_2020_rule_book_200708.pdf
