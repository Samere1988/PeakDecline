"""Remap playlist names against the already-downloaded guide without redownloading it."""
import collections
import datetime
import pathlib
import re
import shutil
import sqlite3
import argparse

ROOT = pathlib.Path(__file__).resolve().parent
CHANNELS = ROOT / 'instance/channels.db'
GUIDE = ROOT / 'instance/guide.db'

def normalize(value):
    value = value or ''
    value = re.sub(r'\b(?:HEVC|H\.?265|H\.?264|HD|FHD|UHD|4K|SD|1080P|720P)\b', '', value, flags=re.I)
    return re.sub(r'[^a-z0-9]+', ' ', value.casefold()).strip()

parser = argparse.ArgumentParser()
parser.add_argument('--csv', type=pathlib.Path)
parser.add_argument('--category', default='likely_schedulable')
args = parser.parse_args()

with sqlite3.connect(GUIDE) as guide, sqlite3.connect(CHANNELS) as channels:
    names = collections.defaultdict(list)
    for gid, name in guide.execute('select guide_id,name from guide_channels'):
        names[normalize(name)].append(gid)
    counts = dict(guide.execute('select guide_id,count(*) from programmes group by guide_id'))
    current = dict(guide.execute('select channel_id,guide_id from mapping'))
    allowed = None
    if args.csv:
        with args.csv.open(encoding='utf-8-sig', newline='') as handle:
            allowed = {row['channel_id'] for row in __import__('csv').DictReader(handle) if row.get('category') == args.category}
    additions = {}
    for cid, name, url in channels.execute('select id,name,url from channels'):
        if allowed is not None and str(cid) not in allowed:
            continue
        if not name or '/movie/' in (url or '') or '/series/' in (url or ''):
            continue
        candidates = names.get(normalize(name), [])
        if not candidates:
            continue
        ranked = sorted(((counts.get(gid, 0), gid) for gid in set(candidates)), reverse=True)
        if ranked and (len(ranked) == 1 or ranked[0][0] > ranked[1][0] * 1.15):
            additions[str(cid)] = ranked[0][1]
    backup = GUIDE.with_name('guide-before-local-remap-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.db')
    shutil.copy2(GUIDE, backup)
    current.update(additions)
    with guide:
        guide.execute('delete from mapping')
        guide.executemany('insert into mapping values (?,?)', current.items())
    print(f'Added or confirmed {len(additions)} normalized matches; total mappings: {len(current)}')
    print(f'Backup: {backup}')
