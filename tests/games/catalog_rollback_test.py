"""Smash latency options are agreed capabilities; other game defaults stay stable."""
from dataclasses import replace
from types import SimpleNamespace
import unittest
from retro_test import ROOT
from retro_package.catalog import SMASH64


class RollbackCatalogTests(unittest.TestCase):
    app = SimpleNamespace(instance_path=str(ROOT / '.tmp/catalog-missing-instance'),
                          static_folder=str(ROOT / 'static'), root_path=str(ROOT),
                          template_folder='templates')

    def test_smash_agrees_latency_and_transport_settings(self):
        descriptor = SMASH64.descriptor(self.app)
        self.assertEqual(descriptor['rollback'], dict(maxPrediction=6, inputDelay=1, confirmedInputDelay=8,
                                                     hashInterval=60, peerInputs=True))
        self.assertIn('js/netplay/rollback_transport.js', SMASH64.scripts)

    def test_existing_rollback_defaults_keep_their_descriptor(self):
        ordinary = replace(SMASH64, input_delay=2, rollback_hash_interval=1, peer_inputs=False,
                           confirmed_input_delay=None)
        self.assertEqual(ordinary.descriptor(self.app)['rollback'], dict(maxPrediction=6, inputDelay=2))

    def test_sparse_hashes_must_cover_each_published_checkpoint(self):
        for interval in (0, 7, 129):
            with self.subTest(interval=interval), self.assertRaises(ValueError):
                replace(SMASH64, rollback_hash_interval=interval).descriptor(self.app)

    def test_confirmed_delay_is_bounded_and_not_less_than_combat_delay(self):
        for delay in (0, 13, True, 1.5):
            with self.subTest(delay=delay), self.assertRaises(ValueError):
                replace(SMASH64, confirmed_input_delay=delay).descriptor(self.app)


if __name__ == '__main__':
    unittest.main()
