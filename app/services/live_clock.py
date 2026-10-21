"""Map the published HLS timeline onto one monotonic server clock."""
from datetime import datetime
from pathlib import Path
import re
import time


class LiveClock:
    def __init__(self):
        self.anchors = {}
        self.playlists = {}

    def snapshot(self, playlist, channel_id):
        path = Path(playlist)
        stat = path.stat()
        signature = (str(path), stat.st_mtime_ns, stat.st_size)
        cached = self.playlists.get(str(channel_id))
        if cached and cached[0] == signature:
            segments = cached[1]
        else:
            segments = self._parse(path.read_text(encoding='utf-8').splitlines())
            self.playlists[str(channel_id)] = (signature, segments)
        return self._snapshot(segments, channel_id, stat.st_mtime)

    @staticmethod
    def _parse(lines):
        segments = []
        stamp = duration = None
        for line in lines:
            if line.startswith('#EXT-X-PROGRAM-DATE-TIME:'):
                stamp = datetime.fromisoformat(line.split(':', 1)[1].replace('Z', '+00:00')).timestamp()
            elif line.startswith('#EXTINF:'):
                duration = float(line.split(':', 1)[1].split(',')[0])
            elif line and not line.startswith('#') and stamp is not None and duration is not None:
                segments.append((stamp, duration, line))
                stamp += duration
                duration = None
        if not segments:
            raise ValueError('No dated media segments available')
        return segments

    def _snapshot(self, segments, channel_id, modified):
        first, last = segments[0], segments[-1]
        edge = last[0] + last[1]
        # FFmpeg uses a unique segment prefix per stream restart.
        session = re.sub(r'_\d+\.ts$', '', first[2].replace('\\', '/').split('/')[-1])
        now = time.monotonic()
        key = str(channel_id)
        anchor = self.anchors.get(key)
        if anchor is None or anchor['session'] != session or edge < anchor['edge']:
            anchor = dict(session=session, origin=edge, started=now, edge=edge, updated=now,
                          stream_start_pdt=first[0])
            self.anchors[key] = anchor
        if edge > anchor['edge']:
            # Encoder time may stop while monotonic wall time keeps advancing.
            # Rebase after a stall instead of chasing the first new segment.
            if now - anchor['updated'] >= 8:
                anchor.update(origin=edge, started=now)
            anchor.update(edge=edge, updated=now)
        fresh = now - anchor['updated'] < 8 and time.time() - modified < 8
        # Smooth progression between publications, without running beyond media.
        target = max(first[0], min(anchor['origin'] + now - anchor['started'] - 6, edge - 0.25))
        return dict(channel_id=channel_id, session=session, target_pdt=target,
                    stream_start_pdt=anchor['stream_start_pdt'],
                    edge_pdt=edge, first_pdt=first[0], fresh=fresh,
                    target_delay=6, max_extrapolation=3)


live_clock = LiveClock()
