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

    def test_provider_labels_keep_brand_and_feed_distinctions(self):
        from audit_guide_channels import label, key
        self.assertEqual(label('USA Network HD'), (None, 'USA Network HD'))
        self.assertEqual(label('USA: History (S)'), ('US', 'History'))
        self.assertEqual(label('NEW UKHD Sky History (SD)'), ('GB', 'Sky History'))
        self.assertEqual(label('(US) (GT) MSG (Zone3) (FHD)'), ('US', 'MSG (Zone3)'))
        self.assertEqual(label('(FR) France 24 (S)'), ('FR', 'France 24'))
        self.assertEqual(label('(CA) (CITY) City TV Montreal (FHD)'), ('CA', 'City TV Montreal'))
        self.assertEqual(key('Sportsnet Ontario (60FPS)'), key('Sportsnet Ontario'))
        self.assertNotEqual(key('Sky Cinema +1'), key('Sky Cinema'))

    def test_joined_station_suffixes_preserve_explicit_subchannel(self):
        from audit_guide_channels import calls
        self.assertEqual(calls('KDKADT', strict=True, implicit=None), {('kdka', None)})
        self.assertEqual(calls('WOHL CD2', strict=True, implicit=None), {('wohl', '2')})
        self.assertEqual(calls('KRQEDT2', strict=True, implicit=None), {('krqe', '2')})
        self.assertIsNone(self.catalog.resolve('FOX (WBFFDT2)', '')[0])

    def test_canadian_city_province_and_call_sign_must_agree(self):
        catalog = Catalog({'CBCOttawa-CBOT.ca': 'ca - cbc ottawa',
                           'CBCMontreal-CBMT.ca': 'ca - cbc montreal',
                           'CBCPrinceEdwardIsland-CBCT.ca': 'ca - cbc charlottetown prince edward island'}, {}, {})
        self.assertEqual(catalog.resolve('CBC Ottawa Ontario (CBOT DT) (D)', '')[0], 'CBCOttawa-CBOT.ca')
        self.assertEqual(catalog.resolve('CBC Montréal QC (CBMT DT) (D)', '')[0], 'CBCMontreal-CBMT.ca')
        self.assertEqual(catalog.resolve('CBC Ottawa', 'CBOT')[0], 'CBCOttawa-CBOT.ca')
        self.assertEqual(catalog.resolve('CBC Charlottetown PE (D)', '')[0], 'CBCPrinceEdwardIsland-CBCT.ca')
        self.assertIsNone(catalog.resolve('CBC Ottawa Alberta (D)', '')[0])
        self.assertIsNone(catalog.resolve('CBC Ottawa (CBMT DT)', '')[0])
        self.assertIsNone(catalog.resolve('CBC Ottawa (CBOT DT2)', '')[0])

    def test_local_news_stream_does_not_become_broadcast_station(self):
        catalog = Catalog({'GlobalMaritimes-CIHF.ca': 'ca - global halifax',
                           'CBCToronto-CBLT.ca': 'ca - cbc toronto'}, {}, {})
        self.assertIsNone(catalog.resolve('Global News Halifax', 'globalhalifaxcihf.ca')[0])
        self.assertIsNone(catalog.resolve('Global Halifax News', 'globalhalifaxcihf.ca')[0])
        self.assertIsNone(catalog.resolve('CBC News Toronto Channel', '')[0])

    def test_french_category_can_contain_explicit_canadian_identity(self):
        catalog = Catalog({'ReseaudesSports-RDS.ca': 'ca - rds', 'TSN1.ca': 'ca - tsn 1',
                           'CTVComedyChannel.ca': 'ca - ctv comedy'}, {}, {})
        self.assertEqual(catalog.resolve('FR: RDS', 'rds.ca')[0], 'ReseaudesSports-RDS.ca')
        self.assertEqual(catalog.resolve('(FR) RDS1 (HD) (D)', '')[0], 'ReseaudesSports-RDS.ca')
        self.assertEqual(catalog.resolve('TSN1 (FL)', '')[:2], ('TSN1.ca', 'explicit_regional_identity'))
        self.assertIsNone(catalog.resolve('CTV Comedy West', 'ctvcomedyeast.ca')[0])

    def test_west_city_name_is_not_a_west_coast_feed(self):
        catalog = Catalog({'NBCWPTV.us': 'us - nbc wptv west palm beach fl',
                           'TVLand.us': 'us - tv land', 'TVLandPacific.us': 'us - tv land west'}, {}, {})
        self.assertEqual(catalog.resolve('NBC (WPTV)', '')[0], 'NBCWPTV.us')
        self.assertIsNone(catalog.resolve('TV Land West', 'tvlandeast.us')[0])

    def test_station_brand_digit_is_not_a_subchannel(self):
        catalog = Catalog({'NBCKGW8.us': 'us - nbc kgw kgw8 portland or',
                           'FOXWTVC2.us': 'us - fox wtvc2 chattanooga tn'}, {}, {})
        self.assertEqual(catalog.resolve('NBC (KGW)', '')[0], 'NBCKGW8.us')
        self.assertIsNone(catalog.resolve('NBC (KGW DT8)', '')[0])
        self.assertEqual(catalog.resolve('FOX (WTVC DT2)', '')[0], 'FOXWTVC2.us')
        self.assertIsNone(catalog.resolve('FOX (WTVC DT1)', '')[0])

    def test_network_and_city_match_a_unique_station(self):
        catalog = Catalog({'CBSWCBS.us': 'us - cbs wcbs new york ny',
                           'FOXWUTV.us': 'us - fox wutv buffalo ny'}, {}, {})
        self.assertEqual(catalog.resolve('CBS (New York)', '')[:2], ('CBSWCBS.us', 'station_network_and_city'))
        self.assertEqual(catalog.resolve('FOX Buffalo', '')[0], 'FOXWUTV.us')
        self.assertIsNone(catalog.resolve('FOX 29 Buffalo', '')[0])
        self.assertIsNone(catalog.resolve('FOX NY', '')[0])
        self.assertIsNone(catalog.resolve('CBS News New York', '')[0])
        self.assertIsNone(catalog.resolve('CBS (New York)', 'unknown.us')[0])
        self.assertIsNone(catalog.resolve('UK: CBS New York', '')[0])

    def test_city_does_not_choose_between_stations_or_subchannels(self):
        catalog = Catalog({'PBSOne.us': 'us - pbs one',
                           'PBSWNED.us': 'us - pbs wned buffalo ny',
                           'PBSWBUF.us': 'us - pbs wbuf buffalo ny'}, {}, {})
        self.assertIsNone(catalog.resolve('PBS Buffalo', '')[0])
        self.assertIsNone(catalog.resolve('PBS (WNED DT2) Buffalo', '')[0])

    def test_partial_city_or_state_is_not_a_station_identity(self):
        catalog = Catalog({'FOXWDAF.us': 'us - fox wdaf kansas city mo',
                           'FOXWVBT.us': 'us - fox wvbt virginia beach portsmouth norfolk hampton roads va',
                           'CBSKTVT.us': 'us - cbs ktvt dallas fort worth tx'}, {}, {})
        self.assertIsNone(catalog.resolve('Fox Kansas', '')[0])
        self.assertIsNone(catalog.resolve('Fox Virginia', '')[0])
        self.assertIsNone(catalog.resolve('CBS Dallas', '')[0])
        self.assertEqual(catalog.resolve('FOX Kansas City', '')[0], 'FOXWDAF.us')

    def test_numbered_station_brand_is_not_discarded_for_city(self):
        catalog = Catalog({'PBSKRMA.us': 'us - pbs krma denver co'}, {}, {})
        self.assertIsNone(catalog.resolve('(US) (H) [Denver] PBS12', '')[0])

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

    def test_scope_only_audits_requested_entries(self):
        scope = self.root / 'scope.json'
        scope.write_text(json.dumps([{'id':'2', 'name':'Local News'}]))
        with contextlib.redirect_stdout(io.StringIO()):
            report = audit(self.channels,self.guide,self.catalog,self.output,scope)
        self.assertEqual(report['channels'], 1)
        self.assertEqual(report['playlist_channels'], 3)
        self.assertEqual([r['channel_id'] for r in report['rows']], ['2'])
        self.apply()
        with sqlite3.connect(self.guide) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM mapping').fetchone()[0], 0)

    def test_changed_scope_identity_is_rejected(self):
        scope = self.root / 'scope.json'
        scope.write_text(json.dumps([{'id':'1', 'name':'Different channel'}]))
        with self.assertRaises(ValueError):
            audit(self.channels,self.guide,self.catalog,self.output,scope)


if __name__=='__main__':
    unittest.main()
