"""Import XMLTV listings and conservatively match every channel. No stream requests."""
import argparse
import collections
import datetime as dt
import gzip
import json
import pathlib
import re
import sqlite3
import tempfile
import time
import difflib
import requests
try:
    from lxml import etree as ET
except ImportError:
    import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent
GUIDE = ROOT / 'instance/guide.db'
SOURCES = [
    'https://epg.pw/xmltv/epg.xml.gz',
    'https://iptv-epg.org/files/epg-us.xml.gz',
    'https://iptv-epg.org/files/epg-ca.xml.gz',
]

def normalize(value):
    value = value or ''
    return re.sub(r'\s+', ' ', re.sub(r'\b(?:HEVC|H\.?265|H\.?264|HD|FHD|UHD|4K|SD|1080P|720P)\b', '', value, flags=re.I)).strip().casefold()

def timestamp(value):
    value = (value or '').strip()
    match = re.match(r'^(\d{14})(?:\s*(Z|[+-]\d{2}:?\d{2}))?$', value)
    if not match:
        raise ValueError(f'Unsupported XMLTV timestamp: {value}')
    zone = match.group(2) or '+0000'
    zone = '+0000' if zone == 'Z' else zone.replace(':', '')
    return int(dt.datetime.strptime(f'{match.group(1)} {zone}', '%Y%m%d%H%M%S %z').timestamp())

def close_name(channel_name, guide_names, token_index=None):
    if not channel_name:
        return None
    target = normalize(channel_name)
    if len(target) < 5:
        return None
    target_tokens = set(target.split())
    candidates_to_check = guide_names.items()
    if token_index is not None:
        candidate_counts = collections.Counter()
        for token in target_tokens:
            for gid in token_index.get(token, ()):
                candidate_counts[gid] += 1
        # Fuzzy matching is useful for names with regional/resolution suffixes,
        # but one-word matches are too broad to be useful at this scale.
        minimum_overlap = 2 if len(target_tokens) > 1 else 99
        candidate_ids = {gid for gid, count in candidate_counts.items() if count >= minimum_overlap}
        candidates_to_check = ((gid, guide_names[gid]) for gid in candidate_ids if gid in guide_names)
    best = []
    for gid, candidate in candidates_to_check:
        candidate_tokens = set(candidate.split())
        if not candidate_tokens:
            continue
        overlap = len(target_tokens & candidate_tokens) / max(len(target_tokens), len(candidate_tokens))
        ratio = difflib.SequenceMatcher(None, target, candidate).ratio()
        score = max(ratio, overlap)
        if score >= .92:
            best.append((score, gid))
    best.sort(reverse=True)
    return best[0][1] if best and (len(best) == 1 or best[0][0] > best[1][0] + .04) else None

def parse_feed(source, now):
    guide_ids, guide_names = {}, {}
    names = collections.defaultdict(set)
    programmes = []
    malformed = outside_window = parsed = 0
    with tempfile.TemporaryFile() as compressed:
        with requests.get(source, stream=True, timeout=(15, 90)) as response:
            response.raise_for_status()
            size = 0
            started = time.monotonic()
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > 200_000_000:
                    raise ValueError(f'{source} exceeds download limit')
                compressed.write(chunk)
                if size % (10 * 1024 * 1024) < 65536:
                    print(f'{source}: downloaded {size / 1024 / 1024:.0f} MB in {time.monotonic() - started:.0f}s', flush=True)
        compressed.seek(0)
        with gzip.GzipFile(fileobj=compressed) as xml:
            parse_options = {'events': ('end',)}
            if ET.__name__.startswith('lxml'):
                parse_options['tag'] = ('channel', 'programme')
            for _, element in ET.iterparse(xml, **parse_options):
                parsed += 1
                if parsed % 100000 == 0:
                    print(f'{source}: parsed {parsed:,} XML records; retained {len(programmes):,}', flush=True)
                if element.tag == 'channel':
                    gid = element.get('id')
                    if gid:
                        guide_ids[gid.casefold()] = gid
                        display_names = [normalize(name.text or '') for name in element.findall('display-name') if name.text]
                        if display_names:
                            guide_names[gid] = display_names[0]
                        for display_name in display_names:
                            names[display_name].add(gid)
                    element.clear()
                elif element.tag == 'programme':
                    try:
                        start, stop = timestamp(element.get('start', '')), timestamp(element.get('stop', ''))
                        title = (element.findtext('title') or '').strip()
                        if now - 86400 < stop and start < now + 8 * 86400 and stop > start and title:
                            programmes.append((element.get('channel'), start, stop, title))
                        else:
                            outside_window += 1
                    except (ValueError, TypeError, AttributeError):
                        malformed += 1
                    element.clear()
                if hasattr(element, 'getparent'):
                    while element.getprevious() is not None:
                        del element.getparent()[0]
    return guide_ids, guide_names, names, programmes, malformed, outside_window

def refresh(playlist=None):
    with sqlite3.connect(GUIDE) as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS mapping(channel_id TEXT PRIMARY KEY, guide_id TEXT);
        CREATE TABLE IF NOT EXISTS guide_channels(guide_id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS programmes(guide_id TEXT, start INTEGER, stop INTEGER, title TEXT);
        CREATE INDEX IF NOT EXISTS programme_time ON programmes(guide_id,start,stop);
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS identifiers(channel_id TEXT PRIMARY KEY, tvg_id TEXT);''')
        with sqlite3.connect(ROOT / 'instance/channels.db') as channels:
            rows = channels.execute('SELECT id,name,url FROM channels').fetchall()
        if playlist:
            by_url = collections.defaultdict(set)
            info = None
            for line in pathlib.Path(playlist).read_text(encoding='utf-8-sig', errors='replace').splitlines():
                if line.startswith('#EXTINF:'):
                    match = re.search(r'tvg-id="([^"]+)"', line)
                    info = match.group(1) if match else None
                elif line and not line.startswith('#'):
                    if info:
                        by_url[line.strip()].add(info)
                    info = None
            for cid, _, url in rows:
                ids = by_url[url]
                if len(ids) == 1:
                    db.execute('INSERT OR REPLACE INTO identifiers VALUES (?,?)', (cid, next(iter(ids))))
            db.commit()
        identifiers = dict(db.execute('SELECT channel_id,tvg_id FROM identifiers'))
        names = collections.defaultdict(set)
        guide_ids = {}
        guide_names = {}
        all_names = collections.defaultdict(set)
        programmes = []
        malformed = 0
        outside_window = 0
        now = time.time()
        sources_used = []
        for source in SOURCES:
            try:
                ids, source_names, source_name_map, source_programmes, source_malformed, source_outside = parse_feed(source, now)
                guide_ids.update(ids)
                guide_names.update(source_names)
                for display_name, ids_for_name in source_name_map.items():
                    all_names[display_name].update(ids_for_name)
                programmes.extend(source_programmes)
                malformed += source_malformed
                outside_window += source_outside
                sources_used.append(source)
            except (requests.RequestException, OSError, ValueError) as error:
                print(f'Skipping unavailable guide source {source}: {error}', flush=True)
        names = all_names
        print(f'Programme parse complete: retained={len(programmes):,}, outside_window={outside_window:,}, malformed={malformed:,}', flush=True)
        if not programmes:
            print(f'No listings overlap the current date ({dt.datetime.fromtimestamp(now):%Y-%m-%d}); existing guide preserved.', flush=True)
            return
        mappings = []
        token_index = collections.defaultdict(set)
        for gid, guide_name in guide_names.items():
            for token in set(guide_name.split()):
                token_index[token].add(gid)
        for index, (cid, name, url) in enumerate(rows, 1):
            if index % 1000 == 0:
                print(f'Matching channels {index:,}/{len(rows):,}; found {len(mappings):,}', flush=True)
            if '/movie/' in (url or '') or '/series/' in (url or ''):
                continue
            gid = guide_ids.get(identifiers.get(str(cid), '').casefold())
            # Only exact unique names after removing resolution labels; never fuzzy-match regions.
            candidates = names.get(normalize(name or ''), set())
            if not gid and len(candidates) == 1:
                gid = next(iter(candidates))
            if not gid:
                gid = close_name(name, guide_names, token_index)
            if gid:
                mappings.append((cid, gid))
        # Preserve previously working assignments when a provider temporarily
        # omits a channel; current source matches take precedence.
        existing_mapping = dict(db.execute('SELECT channel_id, guide_id FROM mapping'))
        merged_mapping = existing_mapping.copy()
        merged_mapping.update(dict(mappings))
        with db:
            db.execute('DELETE FROM mapping')
            db.execute('DELETE FROM guide_channels')
            db.execute('DELETE FROM programmes')
            db.executemany('INSERT INTO mapping VALUES (?,?)', merged_mapping.items())
            db.executemany('INSERT INTO guide_channels VALUES (?,?)', guide_names.items())
            db.executemany('INSERT INTO programmes VALUES (?,?,?,?)', programmes)
            db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('updated', str(time.time())))
        print(json.dumps(dict(channels=len(rows), matched=len(merged_mapping), new_matches=len(mappings), programmes=len(programmes), sources=sources_used)))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--playlist')
    refresh(parser.parse_args().playlist)
