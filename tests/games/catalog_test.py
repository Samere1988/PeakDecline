"""Catalog fingerprints stay fresh without blocking the gevent relay."""
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from flask_socketio import SocketIO
import retro_test  # Registers the isolated package without importing the app.
from retro_package.catalog import Game, _digest


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = Flask(__name__, static_folder=str(self.root / 'static'), instance_path=str(self.root))
        self.game = Game('fixture', 'Fixture', 'build', tuple('asset-' + str(i) for i in range(48)),
                         'rom.bin', 'fixture', '', (), backend='fixture')
        self.paths = [self.root / 'build' / name for name in self.game.files]
        self.paths += [self.root / 'static' / name for name in ('rom.bin', 'js/netplay/session.js', 'js/netplay/telemetry.js', 'js/account_sync.js', 'js/netplay/lobby.js', 'js/netplay/spectators.js', 'js/netplay/spectator_stream.js', 'js/netplay/game_audio.js')]
        for number, path in enumerate(self.paths):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(bytes([number]))
        _digest.cache_clear()

    def test_warm_catalog_larger_than_32_files_avoids_rehashing(self):
        first = self.game.descriptor(self.app)
        self.assertTrue(first['available'])
        with patch('hashlib.file_digest', side_effect=AssertionError('A warm unchanged asset was rehashed')):
            self.assertEqual(self.game.descriptor(self.app), first)

    def test_same_size_replacement_invalidates_fingerprint_and_missing_asset_disables(self):
        first = self.game.descriptor(self.app)
        asset = self.paths[0]
        previous = asset.stat()
        asset.write_bytes(b'X')
        os.utime(asset, ns=(previous.st_atime_ns, previous.st_mtime_ns + 1_000_000))
        second = self.game.descriptor(self.app)
        self.assertNotEqual(second['build'], first['build'])
        asset.unlink()
        missing = self.game.descriptor(self.app)
        self.assertFalse(missing['available'])
        self.assertEqual(missing['build'], '')

    def test_cold_file_hash_does_not_block_gevent_callbacks(self):
        import gevent
        import hashlib
        SocketIO(self.app, async_mode='gevent')
        entered = threading.Event()
        release = threading.Event()
        digest = hashlib.file_digest

        def delayed_digest(*args, **kwargs):
            entered.set()
            if not release.wait(2):
                raise AssertionError('The gevent callback could not run during hashing')
            return digest(*args, **kwargs)

        def release_from_hub():
            deadline = time.monotonic() + 1
            while not entered.is_set() and time.monotonic() < deadline:
                gevent.sleep(.001)
            release.set()

        callback = gevent.spawn(release_from_hub)
        try:
            with patch.object(hashlib, 'file_digest', delayed_digest):
                self.assertTrue(self.game.descriptor(self.app)['available'])
            self.assertTrue(entered.is_set())
        finally:
            release.set()
            callback.join()


if __name__ == '__main__':
    unittest.main()
