"""Validate YouTube links without fetching user-supplied URLs."""
import re
from urllib.parse import parse_qs, urlsplit


def parse_youtube_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('Paste a valid YouTube video link.')
    try:
        url = urlsplit(value.strip())
        host = (url.hostname or '').lower()
        parts = url.path.strip('/').split('/')
        query = parse_qs(url.query)
        if url.scheme not in ('https', 'http') or url.username or url.password:
            raise ValueError()
        if host == 'youtu.be' and len(parts) == 1:
            video_id = parts[0]
        elif host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'):
            if url.path == '/watch':
                video_id = query.get('v', [''])[0]
            elif len(parts) == 2 and parts[0] in ('shorts', 'embed', 'live'):
                video_id = parts[1]
            else:
                raise ValueError()
        else:
            raise ValueError()
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            raise ValueError()
        timestamp = query.get('t', query.get('start', ['0']))[0]
        if timestamp.isdigit():
            offset = int(timestamp)
        else:
            match = re.fullmatch(r'(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?', timestamp)
            if not match or not timestamp:
                raise ValueError()
            offset = sum(int(n or 0) * factor for n, factor in zip(match.groups(), (3600, 60, 1)))
        if offset > 604800:
            raise ValueError()
        return video_id, offset
    except (ValueError, OverflowError):
        raise ValueError('Paste a valid YouTube video link with a valid start time.') from None
