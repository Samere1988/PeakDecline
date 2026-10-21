"""Live endpoints against the imported TEXT-ID schema used in production."""
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from channel_preferences_test import ChannelPreferencesTest
from app import db
from app.models import Channel
from app.services.streamer import streamer


class LegacyChannelIdsTest(ChannelPreferencesTest):
    def setUp(self):
        super().setUp()
        db.session.remove()
        with db.engines['channels_db'].begin() as connection:
            connection.exec_driver_sql('DROP TABLE channels')
            connection.exec_driver_sql('CREATE TABLE channels (id TEXT, name TEXT, url TEXT, Favorites TEXT, is_playing TEXT, logo TEXT, brand TEXT)')
            connection.exec_driver_sql("INSERT INTO channels (id, name, url) VALUES ('1', 'Alpha', 'fixture'), ('2', 'Beta', 'fixture')")

    def test_text_id_stream_has_numeric_consistent_api_ids(self):
        self.assertIsInstance(db.session.get(Channel, 1).id, str)
        playlist = Path(self.directory.name) / 'native.m3u8'
        playlist.write_text('#EXTM3U\n#EXTINF:2,\n#EXT-X-PROGRAM-DATE-TIME:2026-09-09T09:48:22.405-0400\nseg_legacy_000.ts\n')
        with patch.object(streamer, 'current_channel_id', '1'), patch.object(streamer, 'process', Mock(poll=lambda: None)), patch.object(streamer, 'clock_playlist_path', str(playlist)):
            status = self.client.get('/api/status').json
            self.assertEqual(status['current_channel_id'], 1)
            self.assertIs(type(status['current_channel_id']), int)
            clock = self.client.get('/api/live-clock/1')
            self.assertEqual(clock.status_code, 200)
            self.assertEqual(clock.json['channel_id'], status['current_channel_id'])
            self.assertEqual(self.client.post('/api/play/1').status_code, 200)
            self.start.assert_not_called()
            self.assertEqual(self.client.get('/api/live-clock/2').status_code, 503)
        channels = self.client.get('/api/channels').json
        self.assertTrue(all(type(channel['id']) is int for channel in channels))
        self.assertEqual(channels[0]['play_count'], 1)
        favorite = self.client.put('/api/channels/1/favorite', json={'favorite': True}).json
        self.assertIs(type(favorite['id']), int)
        self.client.post('/api/play/2')
        self.assertIs(type(self.start.call_args.args[0]), int)


if __name__ == '__main__':
    unittest.main()
