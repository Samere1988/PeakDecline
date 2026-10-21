from pathlib import Path
import json
from functools import lru_cache
from flask import current_app, render_template, send_from_directory, abort, url_for
from flask_login import login_required
from .catalog import GAMES, PREVIEW_GAMES


def register_routes(blueprint):
    from .saves import register_save_routes
    register_save_routes(blueprint)
    @blueprint.route('/games/retro')
    @login_required
    def retro_games():
        catalog = [game.descriptor(current_app) for game in GAMES.values()]
        response = current_app.make_response(render_template('retro_games.html', catalog=catalog, games=GAMES))
        response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
        response.headers['Cross-Origin-Embedder-Policy'] = 'credentialless'
        return response

    @blueprint.route('/games/retro/preview/perfectdark')
    @login_required
    def perfect_dark_preview():
        game = PREVIEW_GAMES['perfectdark']
        if not game.descriptor(current_app)['available']:
            abort(404)
        response = current_app.make_response(render_template('retro/perfectdark_preview.html',
            build_url=url_for('main.retro_game_asset', game_id=game.id, filename=game.files[0]).rsplit('/', 1)[0] + '/',
            rom_url=(url_for('main.retro_private_data', game_id=game.id) if game.private_data else url_for('main.retro_diablo_data') if game.id == 'devilutionx' else url_for('static', filename=game.rom))))
        response.headers['Cache-Control'] = 'private, no-store'
        return response

    @blueprint.route('/games/retro/netplay/<filename>')
    @login_required
    def retro_netplay_asset(filename):
        if filename not in ('netplay.js', 'netplay.wasm'):
            abort(404)
        response = send_from_directory(Path(current_app.instance_path) / 'netplay/build', filename)
        response.headers['Cache-Control'] = 'private, no-cache'
        return response

    @blueprint.route('/games/retro/runtime/<game_id>')
    @login_required
    def retro_game_runtime(game_id):
        game = GAMES.get(game_id)
        if not game or not game.runtime_template or not game.descriptor(current_app)['available']:
            abort(404)
        response = current_app.make_response(render_template(game.runtime_template, game=game,
            save_url=url_for("main.retro_save", game_id=game_id),
            build_url=url_for('main.retro_game_asset', game_id=game_id, filename=game.files[0]).rsplit('/', 1)[0] + '/',
            rom_url=(url_for('main.retro_private_data', game_id=game.id) if game.private_data else url_for('main.retro_diablo_data') if game.id == 'devilutionx' else url_for('static', filename=game.rom))))
        response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
        response.headers['Cross-Origin-Embedder-Policy'] = 'credentialless'
        response.headers['Cache-Control'] = 'private, no-store'
        return response

    @blueprint.route('/games/retro/worker/<filename>')
    @login_required
    def retro_worker_asset(filename):
        if filename not in ('mk64_checkpoint_worker.js', 'mk64_state_codec.js'):
            abort(404)
        response = send_from_directory(Path(current_app.static_folder) / 'js/netplay', filename)
        response.headers['Cache-Control'] = 'private, no-cache'
        response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        response.headers['Cross-Origin-Embedder-Policy'] = 'credentialless'
        return response

    @blueprint.route('/games/retro/build/<game_id>/<path:filename>')
    @login_required
    def retro_game_asset(game_id, filename):
        game = GAMES.get(game_id) or PREVIEW_GAMES.get(game_id)
        if not game or filename not in game.files:
            abort(404)
        response = send_from_directory(Path(current_app.instance_path) / game.build_dir, filename)
        response.headers['Cache-Control'] = 'private, no-cache'
        response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        response.headers['Cross-Origin-Embedder-Policy'] = 'credentialless'
        return response

    @blueprint.route('/games/retro/data/devilutionx/diabdat.mpq')
    @login_required
    def retro_diablo_data():
        response = send_from_directory(Path(current_app.instance_path) / 'devilutionx/data', 'diabdat.mpq')
        response.headers['Cache-Control'] = 'private, no-cache'
        response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        return response

    @blueprint.route('/games/retro/data/driver2/fmv/<int:movie>')
    @login_required
    def retro_driver_movie(movie):
        response = send_from_directory(Path(current_app.instance_path) / 'driver2/data/fmv', str(movie) + '.avi')
        response.headers['Cache-Control'] = 'private, no-cache'
        response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        return response

    @blueprint.route('/games/retro/data/cmr2/file/<path:filename>')
    @login_required
    def retro_cmr2_asset(filename):
        manifest = Path(current_app.instance_path) / 'cmr2/build/assets.json'
        try:
            stat = manifest.stat()
            names = _cmr2_assets(str(manifest), stat.st_mtime_ns, stat.st_size)
        except (OSError, ValueError, KeyError, TypeError):
            abort(404)
        if filename not in names:
            abort(404)
        response = send_from_directory(Path(current_app.instance_path) / 'cmr2/data', filename)
        response.headers['Cache-Control'] = 'private, no-cache'
        response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        return response

    @blueprint.route('/games/retro/data/<game_id>')
    @login_required
    def retro_private_data(game_id):
        game = GAMES.get(game_id)
        if not game or not game.private_data:
            abort(404)
        source = Path(current_app.instance_path) / game.rom
        response = send_from_directory(source.parent, source.name)
        response.headers['Cache-Control'] = 'private, no-cache'
        response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        return response


@lru_cache(maxsize=8)
def _cmr2_assets(path, modified, size):
    document = json.loads(Path(path).read_text())
    return {entry['path'] for entry in document['files']}
