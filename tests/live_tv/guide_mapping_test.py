"""Guide refresh/remap regressions with isolated databases and fixture feeds."""
import collections
import contextlib
import importlib.util
import io
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import guide_mapping
import refresh_guide
import remap_guide_channels


class GuideMappingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='guide-mapping-test-')
        self.root = Path(self.temp.name)
        (self.root / 'instance').mkdir()
        self.guide = self.root / 'instance/guide.db'
        self.channels = self.root / 'instance/channels.db'
        self.rows = [(2823, 'HBO HD', '/live/2823'), (11561, 'HBO', '/live/11561'),
                     (10, 'HBO HD', '/live/10'), (11, 'HBO', '/live/11'),
                     (12, 'Unique HD', '/live/12'), (13, 'Unrelated', '/live/13')]
        with sqlite3.connect(self.channels) as db:
            db.execute('CREATE TABLE channels(id INTEGER PRIMARY KEY, name TEXT, url TEXT)')
            db.executemany('INSERT INTO channels VALUES (?,?,?)', self.rows)
        with sqlite3.connect(self.guide) as db:
            db.executescript('''CREATE TABLE mapping(channel_id TEXT PRIMARY KEY,guide_id TEXT);
                CREATE TABLE identifiers(channel_id TEXT PRIMARY KEY,tvg_id TEXT);
                CREATE TABLE guide_channels(guide_id TEXT PRIMARY KEY,name TEXT);
                CREATE TABLE programmes(guide_id TEXT,start INTEGER,stop INTEGER,title TEXT);
                CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);''')
            db.executemany('INSERT INTO identifiers VALUES (?,?)', [('11561', 'hbo.ca'), ('11', 'hbo.US')])
            db.executemany('INSERT INTO mapping VALUES (?,?)', [('2823', 'foreign'), ('13', 'preserved')])
            db.executemany('INSERT INTO guide_channels VALUES (?,?)', self.feed()[1].items())
            db.executemany('INSERT INTO programmes VALUES (?,?,?,?)', self.feed()[3])
        for module, attribute, value in [
                (refresh_guide, 'ROOT', self.root), (refresh_guide, 'GUIDE', self.guide),
                (refresh_guide, 'SOURCES', ['fixture']), (remap_guide_channels, 'GUIDE', self.guide),
                (remap_guide_channels, 'CHANNELS', self.channels)]:
            p = patch.object(module, attribute, value)
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.temp.cleanup)

    def feed(self, include_verified=True):
        guide_names = {'foreign': 'hbo', 'unique': 'unique'}
        if include_verified:
            guide_names['HBO.us'] = 'hbo'
        names = collections.defaultdict(set)
        for gid, name in guide_names.items():
            names[name].add(gid)
        now = int(time.time())
        programmes = [('foreign', now - 100, now + 100, 'Wrong movie')] * 30
        programmes.append(('unique', now - 100, now + 100, 'Other programme'))
        if include_verified:
            programmes.append(('HBO.us', now - 100, now + 100, 'Evil Dead Burn'))
        return ({gid.casefold(): gid for gid in guide_names}, guide_names, names, programmes, 0, 0)

    def mappings(self):
        with sqlite3.connect(self.guide) as db:
            return dict(db.execute('SELECT channel_id,guide_id FROM mapping'))

    def refresh(self, feed=None):
        with patch.object(refresh_guide, 'parse_feed', return_value=feed or self.feed()), contextlib.redirect_stdout(io.StringIO()):
            refresh_guide.refresh()

    def remap(self, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            remap_guide_channels.remap(**kwargs)

    def set_overrides(self):
        with sqlite3.connect(self.guide) as db:
            guide_mapping.set_override(db, '2823', 'HBO HD', 'HBO.us', 'Confirmed against playing movie')
            guide_mapping.set_override(db, '11561', 'HBO', None, 'Region unverified')

    def test_refresh_respects_identifiers_and_ambiguous_names(self):
        self.refresh()
        mappings = self.mappings()
        self.assertEqual(mappings['11'], 'HBO.us')
        self.assertNotIn('10', mappings)  # Same brand in two regions.
        self.assertNotIn('11561', mappings)  # Missing hbo.ca cannot fall back.
        self.assertEqual(mappings['12'], 'unique')
        self.assertEqual(mappings['13'], 'preserved')

    def test_remap_does_not_choose_feed_by_programme_count(self):
        self.remap()
        mappings = self.mappings()
        self.assertNotIn('10', mappings)  # Foreign feed has 30x more listings.
        self.assertNotIn('11561', mappings)
        self.assertEqual(mappings['11'], 'HBO.us')

    def test_refresh_and_remap_keep_verified_override_and_block(self):
        self.set_overrides()
        with sqlite3.connect(self.guide) as db:
            db.execute('INSERT INTO mapping VALUES (?,?)', ('11561', 'foreign'))
        for run in [self.refresh, self.remap, self.refresh]:
            run()
            self.assertEqual(self.mappings()['2823'], 'HBO.us')
            self.assertNotIn('11561', self.mappings())
        with sqlite3.connect(self.guide) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM mapping_overrides').fetchone()[0], 2)

    def test_missing_verified_source_never_substitutes_foreign_feed(self):
        self.set_overrides()
        self.refresh(self.feed(include_verified=False))
        self.assertEqual(self.mappings()['2823'], 'HBO.us')
        self.assertNotIn('11561', self.mappings())
        self.assertNotIn('11', self.mappings())
        self.remap()
        self.assertEqual(self.mappings()['2823'], 'HBO.us')

    def test_targeted_override_preserves_unrelated_channels_and_backup(self):
        before = self.mappings()
        self.remap(override=('2823', 'hbo.us', 'Observed playing title matches'))
        self.assertEqual(self.mappings(), {**before, '2823': 'HBO.us'})
        backup = next(self.guide.parent.glob('guide-before-local-remap-*.db'))
        with sqlite3.connect(backup) as db:
            self.assertEqual(dict(db.execute('SELECT channel_id,guide_id FROM mapping')), before)
        self.remap(override=('2823', None, 'Temporarily unverified'))
        self.assertNotIn('2823', self.mappings())

    def test_invalid_override_leaves_mapping_unchanged(self):
        before = self.mappings()
        for override in [('2823', 'unknown', 'Reason'), ('9999', 'HBO.us', 'Reason'), ('2823', 'HBO.us', '')]:
            with self.assertRaises(ValueError):
                self.remap(override=override)
        self.assertEqual(self.mappings(), before)
        self.assertFalse(list(self.guide.parent.glob('guide-before-local-remap-*.db')))

    def test_reused_channel_id_does_not_inherit_verified_mapping(self):
        self.set_overrides()
        self.refresh()
        with sqlite3.connect(self.channels) as db:
            db.execute("UPDATE channels SET name='New Channel' WHERE id=2823")
        self.remap()
        self.assertNotIn('2823', self.mappings())

    def test_failed_refresh_preserves_existing_data(self):
        self.set_overrides()
        before = self.mappings()
        with patch.object(refresh_guide, 'parse_feed', side_effect=OSError('fixture failure')), contextlib.redirect_stdout(io.StringIO()):
            refresh_guide.refresh()
        self.assertEqual(self.mappings(), before)
        with sqlite3.connect(self.guide) as db:
            self.assertGreater(db.execute('SELECT count(*) FROM programmes').fetchone()[0], 0)

    def test_live_lookup_returns_verified_title(self):
        self.set_overrides()
        self.refresh()
        spec = importlib.util.spec_from_file_location('guide_service_test', ROOT / 'app/services/guide.py')
        service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(service)
        service.ROOT = self.root
        service.next_check = float('inf')
        self.assertEqual(service.lookup(2823)['now']['title'], 'Evil Dead Burn')
        self.assertIsNone(service.lookup(11561)['now'])


if __name__ == '__main__':
    unittest.main()
