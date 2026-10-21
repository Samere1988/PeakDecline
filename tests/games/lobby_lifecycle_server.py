"""Loopback fixture with installed builds and disposable accounts/save data."""
import argparse
from dataclasses import replace
from pathlib import Path
import tempfile
from retro_test import GAMES, ROOT, make_app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8079)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Choose an unprivileged loopback port.')
    for game_id, game in list(GAMES.items()):
        GAMES[game_id] = replace(game, build_dir=str(ROOT / 'instance' / game.build_dir),
                                rom=str(ROOT / 'instance' / game.rom) if game.private_data or game_id == 'devilutionx' else game.rom)
    with tempfile.TemporaryDirectory(prefix='lobby-lifecycle-') as directory:
        instance = Path(directory)
        (instance / 'netplay').mkdir()
        (instance / 'netplay/build').symlink_to(ROOT / 'instance/netplay/build', target_is_directory=True)
        # Streamed asset routes resolve beneath instance_path, independently of
        # the catalog's build/data file paths. Save databases stay disposable.
        for game_id in GAMES:
            data = ROOT / 'instance' / game_id / 'data'
            if data.is_dir():
                (instance / game_id).mkdir()
                (instance / game_id / 'data').symlink_to(data, target_is_directory=True)
                (instance / game_id / 'build').symlink_to(ROOT / 'instance' / game_id / 'build', target_is_directory=True)
        app, socket = make_app(instance)
        socket.run(app, host='127.0.0.1', port=args.port, debug=False, allow_unsafe_werkzeug=True)
