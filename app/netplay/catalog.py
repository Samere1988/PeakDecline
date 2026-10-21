"""Server-owned game capabilities. A new game registers an adapter here."""
from dataclasses import dataclass
from functools import lru_cache
import hashlib
from pathlib import Path

PROTOCOL = 1


@lru_cache(maxsize=512)
def _digest(path, size, modified):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _fingerprint(paths):
    try:
        if not all(path.is_file() for path in paths):
            return False, ''
        parts = []
        for path in paths:
            stat = path.stat()
            parts.append(_digest(str(path), stat.st_size, stat.st_mtime_ns))
        return True, hashlib.sha256('|'.join(parts).encode()).hexdigest()
    except OSError:
        # A missing/locked build should disable its game, not the lobby page.
        return False, ''


@dataclass(frozen=True)
class Game:
    id: str
    title: str
    build_dir: str
    files: tuple
    rom: str
    adapter: str
    player_template: str
    scripts: tuple
    max_players: int = 4
    tick_rate: int = 30
    input_schema: str = 'n64-pad-v1'
    backend: str = 'recomp-ring-lockstep-v1'
    runtime_template: str | None = None
    rollback_window: int = 6
    input_delay: int = 2
    settings: tuple = ()
    private_data: bool = False
    rollback_hash_interval: int = 1
    peer_inputs: bool = False
    confirmed_input_delay: int | None = None

    def validate_settings(self, values):
        if values is None:
            values = {}
        if not isinstance(values, dict) or set(values) - {field[0] for field in self.settings}:
            raise ValueError('Invalid match settings.')
        result = {}
        for key, label, default, choices in self.settings:
            value = values.get(key, default)
            if type(value) is not int or value not in {choice[0] for choice in choices}:
                raise ValueError('Choose a valid ' + label.lower() + '.')
            result[key] = value
        return result

    def descriptor(self, app):
        paths = [Path(app.instance_path) / self.build_dir / name for name in self.files]
        if self.backend == 'recomp-ring-lockstep-v1':
            paths += [Path(app.instance_path) / 'netplay/build' / name for name in ('netplay.js', 'netplay.wasm')]
        paths += [Path(app.instance_path if self.backend == 'devilution-native-v1' or self.private_data else app.static_folder) / self.rom]
        paths += [Path(app.static_folder) / name for name in self.scripts]
        paths += [Path(app.static_folder) / name for name in ('js/netplay/session.js', 'js/netplay/telemetry.js', 'js/account_sync.js', 'js/netplay/lobby.js', 'js/netplay/spectators.js', 'js/netplay/spectator_stream.js', 'js/netplay/game_audio.js')]
        if self.backend == 'rollback-v1':
            if not 1 <= self.rollback_window <= 12 or not 0 <= self.input_delay <= 4:
                raise ValueError('Invalid rollback configuration')
            if self.confirmed_input_delay is not None and (type(self.confirmed_input_delay) is not int or
                    not self.input_delay <= self.confirmed_input_delay <= 12):
                raise ValueError('Invalid confirmed-input delay')
            if not 1 <= self.rollback_hash_interval <= 128 or self.tick_rate % self.rollback_hash_interval:
                raise ValueError('Invalid rollback checksum interval')
            paths += [Path(app.static_folder) / 'js/netplay/rollback.js']
        if self.backend == 'authoritative-host-v1':
            if self.input_schema != 'fps-command-v1' or not 10 <= self.tick_rate <= 120 or not 1 <= self.max_players <= 8:
                raise ValueError('Invalid authoritative game configuration')
            paths += [Path(app.static_folder) / name for name in ('js/netplay/authoritative.js', 'js/netplay/fps_input.js')]
        if self.backend == 'sync-input-v1':
            if self.input_schema != 'fps-command-v1' or self.tick_rate != 60:
                raise ValueError('Invalid synchronized game configuration')
            paths += [Path(app.static_folder) / 'js/netplay/synchronized.js']
        if self.backend == 'mk64-server-authority-v1':
            paths += [Path(app.static_folder) / 'js/netplay/mk64_checkpoint_worker.js']
            paths += [Path(__file__).resolve().parents[2] / 'ports/mk64' / name for name in
                      ('authority_worker.cjs', 'authority_runtime.cjs')]
        if self.runtime_template:
            paths += [Path(app.root_path) / app.template_folder / self.runtime_template]
        if getattr(getattr(app, 'extensions', {}).get('socketio'), 'async_mode', None) == 'gevent':
            # Cold hashes and file I/O must not stall active Socket.IO races.
            from gevent import get_hub
            available, fingerprint = get_hub().threadpool.apply(_fingerprint, (paths,))
        else:
            available, fingerprint = _fingerprint(paths)
        descriptor = dict(id=self.id, title=self.title, maxPlayers=self.max_players,
                    tickRate=self.tick_rate, inputSchema=self.input_schema, backend=self.backend,
                    adapter=self.adapter, protocol=PROTOCOL, build=fingerprint, available=available)
        if self.backend == 'rollback-v1':
            descriptor['rollback'] = dict(maxPrediction=self.rollback_window, inputDelay=self.input_delay)
            if self.confirmed_input_delay is not None:
                descriptor['rollback']['confirmedInputDelay'] = self.confirmed_input_delay
            if self.rollback_hash_interval != 1:
                descriptor['rollback']['hashInterval'] = self.rollback_hash_interval
            if self.peer_inputs:
                descriptor['rollback']['peerInputs'] = True
        if self.backend == 'authoritative-host-v1':
            descriptor['authoritative'] = dict(historyTicks=self.tick_rate * 2, maxPending=64,
                snapshotInterval=max(1, self.tick_rate // 20), interpolationTicks=max(1, self.tick_rate // 10),
                maxRewindTicks=max(1, self.tick_rate // 5))
        if self.settings:
            descriptor['settings'] = [dict(key=key, label=label, default=default,
                choices=[dict(value=value, label=text) for value, text in choices])
                for key, label, default, choices in self.settings]
        return descriptor

    def valid_input(self, pad):
        return (isinstance(pad, dict) and set(pad) == {'buttons', 'x', 'y'} and
                type(pad['buttons']) is int and 0 <= pad['buttons'] <= 65535 and
                all(type(pad[key]) is int and -80 <= pad[key] <= 80 for key in ('x', 'y')))


SMASH64 = Game('smash64', 'Super Smash Bros.', 'smash64/build',
    ('BattleShip.js', 'BattleShip.wasm', 'BattleShip.o2r', 'BattleShip.o2r.recipe', 'rollback_adapter.js',
     'f3d.o2r', 'gamecontrollerdb.txt', 'config.yml', 'assets/custom/fonts/Montserrat-Regular.ttf',
     'assets/custom/fonts/Inconsolata-Regular.ttf', 'credits.txt'),
    'roms/N64/Super Smash Bros. (U) [!].z64', 'smash64', 'retro/smash64_player.html',
    ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/n64_touch.js', 'js/game_fullscreen.js', 'js/netplay/rollback_transport.js',
     'js/netplay/wasm_frame_adapter.js', 'js/netplay/smash64_adapter.js'), tick_rate=60, backend='rollback-v1',
    runtime_template='retro/smash64_runtime.html', input_delay=1, rollback_hash_interval=60, peer_inputs=True,
    confirmed_input_delay=8)


GAMES = {'mk64': Game('mk64', 'Mario Kart 64', 'mk64/authority-graphics-20261017', ('mk64.js', 'mk64.wasm', 'state-manifest.json'),
                      'roms/N64/Mario Kart 64 (U) [!].z64', 'mk64', 'retro/mk64_player.html',
                      ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/n64_touch.js', 'js/game_fullscreen.js', 'js/mk64_touch.js', 'js/mario_kart_64.js', 'js/netplay/mk64_adapter.js', 'js/netplay/mk64_native_state.js',
                       'js/netplay/mk64_authority_net.js', 'js/netplay/mk64_state_codec.js', 'js/netplay/mk64_authority_session.js'),
                      backend='mk64-server-authority-v1'),
         'fzerox': Game('fzerox', 'F-Zero X', 'fzerox/build', ('fzerox.js', 'fzerox.wasm', 'fzerox.data', 'licenses.txt'),
                        'roms/N64/F-ZERO X (U) [!].z64', 'fzerox', 'retro/fzerox_player.html',
                        ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/n64_touch.js', 'js/game_fullscreen.js', 'js/netplay/wasm_frame_adapter.js', 'js/netplay/fzerox_adapter.js'),
                        tick_rate=60, runtime_template='retro/fzerox_runtime.html'),
         'smash64': SMASH64}


# Standalone developer preview; multiplayer uses the synchronized runtime below.
PREVIEW_GAMES = {'perfectdark': Game('perfectdark', 'Perfect Dark', 'perfectdark/build',
    ('pd.js', 'pd.wasm', 'LICENSE.txt'), 'roms/N64/Perfect Dark (U) [!].z64',
    'perfectdark', '', ('js/netplay/perfectdark_engine.js',), tick_rate=60, input_schema='fps-command-v1', backend='authoritative-host-v1')}


# Native synchronized-input runtime, verified in the isolated multiplayer fixture.
PERFECTDARK_SYNC = Game('perfectdark', 'Perfect Dark', 'perfectdark/build',
    ('pd.js', 'pd.wasm', 'LICENSE.txt'), 'roms/N64/Perfect Dark (U) [!].z64',
    'perfectdark', 'retro/perfectdark_player.html',
    ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/game_fullscreen.js', 'js/netplay/fps_input.js', 'js/netplay/perfectdark_engine.js',
     'js/netplay/synchronized.js', 'js/netplay/perfectdark_saves.js', 'js/netplay/perfectdark_adapter.js'),
    tick_rate=60, input_schema='fps-command-v1', backend='sync-input-v1',
    runtime_template='retro/perfectdark_runtime.html')

GAMES['perfectdark'] = PERFECTDARK_SYNC


GAMES['devilutionx'] = Game('devilutionx', 'Diablo · DevilutionX', 'devilutionx/build',
    ('devilutionx.js', 'devilutionx.wasm', 'devilutionx.data', 'LICENSE.md', 'sources.json'),
    'devilutionx/data/diabdat.mpq', 'devilutionx', 'retro/devilutionx_player.html',
    ('js/game_fullscreen.js', 'js/netplay/devilutionx_session.js', 'js/netplay/devilutionx_adapter.js',
     'js/netplay/account_saves.js', 'js/netplay/devilutionx_runtime.js'),
    tick_rate=20, input_schema='diablo-packet-v1', backend='devilution-native-v1',
    runtime_template='retro/devilutionx_runtime.html')


GAMES['oot'] = Game('oot', 'The Legend of Zelda: Ocarina of Time', 'oot/build',
    ('soh.js', 'soh.wasm', 'soh.data', 'soh.o2r', 'sources.json'),
    'roms/N64/Legend of Zelda, The - Ocarina of Time (U) [!].z64',
    'oot', 'retro/oot_player.html',
    ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/game_fullscreen.js',
     'js/netplay/solo_session.js', 'js/netplay/oot_adapter.js', 'js/netplay/account_saves.js', 'js/netplay/oot_runtime.js'),
    max_players=1, tick_rate=20, backend='solo-media-v1', runtime_template='retro/oot_runtime.html')

# Single-player source ports share the existing media spectator backend.
for _id, _title, _script, _data, _rate in (
    ('sm64', 'Super Mario 64', 'sm64', 'source.sha256', 30),
    ('sonic1', 'Sonic the Hedgehog', 'sonic', 'Data.rsdk', 60),
    ('sonic2', 'Sonic the Hedgehog 2', 'sonic', 'Data.rsdk', 60),
    ('zelda3', 'The Legend of Zelda: A Link to the Past', 'zelda3', 'zelda3_assets.dat', 60),
    ('driver2', 'Driver 2', 'driver2', 'streamed-assets-v1.json', 30),
):
    GAMES[_id] = Game(_id, _title, _id+'/build',
        (_script+'.js', _script+'.wasm', 'sources.json') + (('driver2.data',) if _id == 'driver2' else ()),
        _id+'/data/'+_data, _id, 'retro/solo_player.html',
        ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/game_fullscreen.js',
         'js/netplay/solo_session.js', 'js/netplay/account_saves.js', 'js/netplay/solo_adapter.js', 'js/netplay/solo_runtime.js'),
        max_players=1, tick_rate=_rate, backend='solo-media-v1',
        runtime_template='retro/solo_runtime.html', private_data=True)


# Development entry: probe/archive outputs never satisfy these release filenames.
GAMES['marioparty'] = Game('marioparty', 'Mario Party', 'marioparty/build',
    ('marioparty.js', 'marioparty.wasm', 'playable.json'),
    'roms/N64/Mario Party (U) [!].z64', 'marioparty', 'retro/marioparty_player.html',
    ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/n64_touch.js',
     'js/game_fullscreen.js', 'js/netplay/wasm_frame_adapter.js',
     'js/netplay/marioparty_runtime.js', 'js/netplay/marioparty_adapter.js'),
    max_players=4, tick_rate=60, runtime_template='retro/marioparty_runtime.html')

GAMES['marioparty2'] = Game('marioparty2', 'Mario Party 2', 'marioparty2/build',
    ('marioparty2.js', 'marioparty2.wasm', 'playable.json'),
    'roms/N64/Mario Party 2 (U) [!].z64', 'marioparty2', 'retro/marioparty2_player.html',
    ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/n64_touch.js',
     'js/game_fullscreen.js', 'js/netplay/wasm_frame_adapter.js',
     'js/netplay/marioparty_runtime.js', 'js/netplay/marioparty2_adapter.js'),
    max_players=4, tick_rate=60, runtime_template='retro/marioparty2_runtime.html')


GAMES['cmr2'] = Game('cmr2', 'Colin McRae Rally 2.0', 'cmr2/build',
    ('opencmr2.js', 'opencmr2.wasm', 'assets.json', 'sources.json', 'LICENSE', 'verified.json'),
    'cmr2/data/installed.json', 'cmr2', 'retro/cmr2_player.html',
    ('js/mk64_gamepad.js', 'js/retro_controller.js', 'js/game_fullscreen.js',
     'js/netplay/account_saves.js', 'js/netplay/cmr2_session.js', 'js/netplay/cmr2_adapter.js',
     'js/netplay/cmr2_runtime.js'), max_players=8, tick_rate=30,
    input_schema='cmr2-native-message-v1', backend='cmr2-server-relay-v1',
    runtime_template='retro/cmr2_runtime.html', private_data=True)
