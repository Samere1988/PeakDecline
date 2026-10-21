"""Clock continuity, freshness and restart tests; no application databases."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('live_clock', Path(__file__).resolve().parents[2] / 'app/services/live_clock.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ClockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='live-clock-unit-')
        self.path = Path(self.temp.name) / 'index.m3u8'
        self.clock = module.LiveClock()
        self.write()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, session='one', count=5):
        self.path.write_text('#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-09-08T12:00:00Z\n' +
            ''.join(f'#EXTINF:2.0,\nseg_{session}_{i:03}.ts\n' for i in range(count)))

    def snapshot(self, mono):
        with patch.object(module.time, 'monotonic', return_value=mono):
            return self.clock.snapshot(self.path, 1)

    def test_same_target_for_all_viewers(self):
        rows = [self.snapshot(100) for _ in range(15)]
        self.assertEqual(len({x['target_pdt'] for x in rows}), 1)

    def test_continuous_across_playlist_publications(self):
        first = self.snapshot(100)
        middle = self.snapshot(101)
        self.write(count=6)
        last = self.snapshot(102)
        self.assertEqual(middle['target_pdt'] - first['target_pdt'], 1)
        self.assertEqual(last['target_pdt'] - first['target_pdt'], 2)

    def test_stale_encoder_and_published_edge_cap(self):
        self.snapshot(100)
        last = self.snapshot(110)
        self.assertFalse(last['fresh'])
        self.assertLess(last['target_pdt'], last['edge_pdt'])

    def test_restart_gets_new_session(self):
        first = self.snapshot(100)
        self.write(session='two')
        last = self.snapshot(110)
        self.assertNotEqual(first['session'], last['session'])
        self.assertEqual(first['target_pdt'], last['target_pdt'])

    def test_missing_dates_fail_closed(self):
        self.path.write_text('#EXTM3U\n#EXTINF:2,\nseg.ts\n')
        with self.assertRaises(ValueError):
            self.snapshot(100)

    def test_stall_recovery_restores_safety_buffer(self):
        self.write(count=10)
        self.snapshot(100)
        self.assertFalse(self.snapshot(112)['fresh'])
        self.write(count=11)
        resumed = self.snapshot(113)
        self.assertTrue(resumed['fresh'])
        self.assertEqual(resumed['edge_pdt'] - resumed['target_pdt'], 6)

    def test_one_playlist_read_for_fifteen_viewers(self):
        with patch.object(Path, 'read_text', wraps=self.path.read_text) as read:
            for i in range(15):
                self.snapshot(100 + i / 100)
            self.assertEqual(read.call_count, 1)

    def test_elapsed_zero_survives_deleted_chunks(self):
        first = self.snapshot(100)
        self.path.write_text('#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-09-08T12:00:08Z\n' +
            ''.join(f'#EXTINF:2.0,\nseg_one_{i:03}.ts\n' for i in range(4, 9)))
        later = self.snapshot(108)
        self.assertEqual(first['stream_start_pdt'], later['stream_start_pdt'])
        self.assertGreater(later['target_pdt'] - later['stream_start_pdt'], 0)

    def test_fractional_chunk_durations_are_preserved(self):
        self.path.write_text('#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-09-08T12:00:00Z\n' +
            '#EXTINF:2.4,\nseg_one_000.ts\n#EXTINF:1.6,\nseg_one_001.ts\n')
        value = self.snapshot(100)
        self.assertAlmostEqual(value['edge_pdt'] - value['stream_start_pdt'], 4)


if __name__ == '__main__':
    unittest.main()
