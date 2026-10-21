from pathlib import Path
from types import SimpleNamespace
from jinja2 import Environment, FileSystemLoader
root = Path(__file__).resolve().parents[2]
env = Environment(loader=FileSystemLoader(root / 'templates'))
env.globals.update(current_user=SimpleNamespace(is_authenticated=False), request=SimpleNamespace(endpoint='main.games'), url_for=lambda endpoint, **kw: '/static/' + kw['filename'] if endpoint == 'static' else '/games', get_flashed_messages=lambda **kw: [])
for name in ['horse_race', 'games', 'catan']:
    (root / 'tests/games' / (name + '.html')).write_text(env.get_template(name + '.html').render(player_name='You'), encoding='utf-8')
