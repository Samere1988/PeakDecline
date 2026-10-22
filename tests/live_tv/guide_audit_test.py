"""Region/station matching and atomic audit application; isolated fixtures only."""
import contextlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from audit_guide_channels import Catalog, audit, apply_report
from guide_mapping import set_override


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.guides = {'HBO.us': 'us - hbo east', 'HBO1.ca': 'ca - hbo 1',
            'HBOBrazil': 'hbo', 'History.us': 'us - history', 'History.ca': 'ca - history',
            'TVLand.us': 'us - tv land', 'TVLandPacific.us': 'us - tv land west',
            'NBCWRC.us': 'us - nbc wrc washington dc', 'FOXWBFF.us': 'us - fox wbff baltimore md',
            'MYWBFFDT2.us': 'us - my wbff-dt2 baltimore md', 'CBSWIVB.us': 'us - cbs wivb buffalo ny',
            'PBSWNED.us': 'us - pbs wned buffalo ny', 'ScienceChannel.us': 'us - discovery science',
            'RDS2.ca': 'ca - rds 2', 'LocalNews.us': 'us - local news'}
        self.catalog = Catalog(self.guides, {'countries': {'BR': {'HBOBrazil': ['hbo']}}}, {})

    def test_national_brands_and_titles_are_not_call_signs(self):
        self.catalog.guides.update({'CNBC.us': 'us - cnbc', 'NBCWHO.us': 'us - nbc who des moines ia'})
        catalog = Catalog(self.catalog.guides, {}, {})
        self.assertIsNone(catalog.resolve('CNBC World', '')[0])
        self.assertIsNone(catalog.resolve('Classic Doctor Who', '')[0])
        self.assertIsNone(catalog.resolve('DAZNCA 16: Union Berlin vs. Koln', '')[0])
        self.assertEqual(catalog.resolve('MyTV (WBFF)', '')[0], 'MYWBFFDT2.us')

    def test_explicit_subchannel_and_4k_are_preserved(self):
        from audit_guide_channels import calls, key
        self.assertEqual(calls('WBFF (WBFF D2)'), {('wbff', '2')})
        self.assertNotEqual(key('USA'), key('USA 4K'))
        self.assertIsNone(self.catalog.resolve('MeTV (WBFF)', '')[0])
        self.assertIsNone(self.catalog.resolve('Movies! (WBFF)', '')[0])

    def test_country_collision_is_not_a_match(self):
        self.assertIsNone(self.catalog.resolve('HBO', '')[0])
        self.assertIsNone(self.catalog.resolve('UK: History', 'history.us')[0])

    def test_exact_and_aliased_identifiers_preserve_feeds(self):
        self.assertEqual(self.catalog.resolve('History Channel', 'historychannel.us')[:2], ('History.us', 'explicit_identifier_alias'))
        self.assertEqual(self.catalog.resolve('TV Land (West)', 'tvlandwest.us')[0], 'TVLandPacific.us')
        self.assertEqual(self.catalog.resolve('History', 'HISTORY.CA')[0], 'History.ca')

    def test_numbered_event_does_not_match_station_acronym(self):
        self.assertIsNone(self.catalog.resolve('RallyTV 001: WRC 2026 Replay available', '')[0])
        self.assertIsNone(self.catalog.resolve('UFC 02', '')[0])

    def test_network_and_subchannel_do_not_cross(self):
        self.assertEqual(self.catalog.resolve('MY 24 Baltimore (WBFF)', '')[0], 'MYWBFFDT2.us')
        self.assertEqual(self.catalog.resolve('MY (WBFF-DT2)', '')[0], 'MYWBFFDT2.us')
        self.assertEqual(self.catalog.resolve('FOX (WBFF)', '')[0], 'FOXWBFF.us')
        self.assertIsNone(self.catalog.resolve('FOX (WBFF-DT2)', '')[0])
        self.assertIsNone(self.catalog.resolve('MY (WBFF-DT1)', '')[0])

    def test_station_index_ignores_sister_station_mentions(self):
        catalog = Catalog({'FOXKTVU.us': 'us - fox ktvu san francisco',
                           'FOXKICU.us': 'us - fox kicu ktvu plus san francisco',
                           'MYWBFFDT2.us': 'us - mynetwork wbff-dt2 baltimore'}, {}, {})
        self.assertEqual(catalog.resolve('FOX (KTVU)', '')[0], 'FOXKTVU.us')
        self.assertEqual(catalog.resolve('MY24 (WBFF)', '')[0], 'MYWBFFDT2.us')

    def test_regional_name_establishes_country_only_for_named_feed(self):
        catalog = Catalog({'CBCToronto-CBLT.ca': 'ca - cbc toronto',
                           'SportsnetWest.ca': 'ca - sportsnet west',
                           'NBCSportsBoston.us': 'us - nbc sports boston',
                           'CTV.ca': 'ca - ctv'}, {}, {})
        self.assertEqual(catalog.resolve('CBC TORONTO HD', '')[:2], ('CBCToronto-CBLT.ca', 'explicit_regional_identity'))
        self.assertEqual(catalog.resolve('Sportsnet West', '')[:2], ('SportsnetWest.ca', 'explicit_regional_identity'))
        self.assertEqual(catalog.resolve('NBC Sports Boston', '')[:2], ('NBCSportsBoston.us', 'explicit_regional_identity'))
        self.assertIsNone(catalog.resolve('CTV', '')[0])

    def test_fallback_preserves_time_shift_and_4k(self):
        catalog = Catalog({'AnimalPlanetGB.uk': 'animal planet',
                           'NBCSportsChicago4K.us': 'us - nbc sports chicago'}, {}, {})
        self.assertIsNone(catalog.resolve('UK: Animal Planet +1', 'AnimalPlanetGB.uk_missing')[0])
        self.assertIsNone(catalog.resolve('UK: Animal Planet +1', 'AnimalPlanet.uk')[0])
        self.assertIsNone(catalog.resolve('NBC Sports Chicago', '')[0])

    def test_alias_preserves_feed_and_country(self):
        catalog = Catalog({'RacerNetwork.us': 'us - racer network'}, {}, {})
        self.assertEqual(catalog.resolve('Racer Network', 'mavtv.us')[0], 'RacerNetwork.us')
        self.assertIsNone(catalog.resolve('UK: Racer Network', 'mavtv.us')[0])
        self.assertIsNone(catalog.resolve('Racer Network +1', 'mavtv.us')[0])

    def test_local_station_and_generic_network(self):
        self.assertEqual(self.catalog.resolve('CBS (WIVB Buffalo NY)', '')[0], 'CBSWIVB.us')
        self.assertEqual(self.catalog.resolve('PBS', 'WNED')[0], 'PBSWNED.us')
        self.assertIsNone(self.catalog.resolve('PBS', '')[0])

    def test_station_identifier_conflict(self):
        self.assertIsNone(self.catalog.resolve('CBS (WIVB Buffalo NY)', 'NBCWRC.us')[0])

    def test_language_label_is_not_country_override(self):
        self.assertEqual(self.catalog.resolve('FR: RDS 2', 'rds2.ca')[0], 'RDS2.ca')

    def test_platform_feed_not_substituted(self):
        self.assertIsNone(self.catalog.resolve('(PLUTO UK) History', '')[0])
        self.assertIsNone(self.catalog.resolve('Roku Local News', '')[0])

    def test_unidentified_alias_does_not_fall_back_to_name(self):
        self.assertIsNone(self.catalog.resolve('History', 'unrelated.us')[0])


class AuditApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.channels = self.root / 'channels.db'
        self.guide = self.root / 'guide.db'
        self.catalog = self.root / 'countries.json'
        self.output = self.root / 'audit.json'
        self.catalog.write_text('{"countries":{}}')
        with sqlite3.connect(self.channels) as db:
            db.execute('CREATE TABLE channels(id TEXT,name TEXT,url TEXT)')
            db.executemany('INSERT INTO channels VALUES (?,?,?)', [('1','CBS (WIVB Buffalo NY)','https://example.test/private/secret/1'),('2','Local News','https://example.test/private/secret/2'),('3','HBO','https://example.test/private/secret/3')])
        with sqlite3.connect(self.guide) as db:
            db.executescript('CREATE TABLE mapping(channel_id TEXT PRIMARY KEY,guide_id TEXT);CREATE TABLE identifiers(channel_id TEXT,tvg_id TEXT);CREATE TABLE guide_channels(guide_id TEXT,name TEXT);CREATE TABLE programmes(guide_id TEXT,start INTEGER,stop INTEGER,title TEXT);')
            db.executemany('INSERT INTO guide_channels VALUES (?,?)',[('CBSWIVB.us','us - cbs wivb buffalo ny'),('LocalNews.us','us - local news'),('HBO.us','us - hbo')])
            db.executemany('INSERT INTO programmes VALUES (?,?,?,?)', [(gid,time.time()-100,time.time()+3600,'Example title') for gid in ['CBSWIVB.us','LocalNews.us','HBO.us']])
            set_override(db,'3','HBO',None,'Unverified region')
        self.make_report()

    def make_report(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return audit(self.channels,self.guide,self.catalog,self.output)

    def apply(self):
        with contextlib.redirect_stdout(io.StringIO()):
            apply_report(self.channels,self.guide,self.output)

    def test_audits_every_entry_without_leaking_urls(self):
        report=json.loads(self.output.read_text())
        self.assertEqual(report['channels'],3)
        self.assertNotIn('private/secret',self.output.read_text())
        self.assertEqual(report['rows'][1]['action'],'review')
        self.assertEqual(report['rows'][2]['method'],'existing_block')

    def test_apply_only_supported_matches_and_preserve_block(self):
        self.apply()
        with sqlite3.connect(self.guide) as db:
            self.assertEqual(dict(db.execute('SELECT * FROM mapping')),{'1':'CBSWIVB.us'})
            self.assertEqual(db.execute("SELECT guide_id FROM mapping_overrides WHERE channel_id='3'").fetchone(),(None,))
        backup=next(self.root.glob('guide-before-audit-*.db'))
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM mapping').fetchone()[0],0)

    def test_changed_stream_rejects_all_changes(self):
        with sqlite3.connect(self.channels) as db:
            db.execute("UPDATE channels SET url='changed' WHERE id='1'")
        with self.assertRaises(ValueError):
            self.apply()
        with sqlite3.connect(self.guide) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM mapping').fetchone()[0],0)

    def test_new_override_is_not_overwritten(self):
        with sqlite3.connect(self.guide) as db:
            set_override(db,'1','CBS (WIVB Buffalo NY)',None,'New evidence since audit')
        with self.assertRaises(ValueError):
            self.apply()
        with sqlite3.connect(self.guide) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM mapping').fetchone()[0],0)

    def test_expired_report_rejected(self):
        report=json.loads(self.output.read_text())
        report['created']='2000-01-01T00:00:00+00:00'
        self.output.write_text(json.dumps(report))
        with self.assertRaises(ValueError):self.apply()

    def test_placeholder_programmes_do_not_enable_new_mapping(self):
        with sqlite3.connect(self.guide) as db:
            db.execute("UPDATE programmes SET title='Channel No Longer Available' WHERE guide_id='CBSWIVB.us'")
        row = self.make_report()['rows'][0]
        self.assertEqual(row['action'], 'unchanged')
        self.assertIsNone(row['proposed'])


if __name__=='__main__':
    unittest.main()
