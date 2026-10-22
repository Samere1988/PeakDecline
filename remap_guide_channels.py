"""Remap cached listings, or persist a verified assignment without a download."""
import argparse
import collections
import csv
import datetime
import pathlib
import sqlite3

from guide_mapping import apply_overrides, ensure_overrides, match_channel, normalize, set_override

ROOT = pathlib.Path(__file__).resolve().parent
CHANNELS = ROOT / 'instance/channels.db'
GUIDE = ROOT / 'instance/guide.db'


def remap(allowed=None, override=None):
    with sqlite3.connect(GUIDE) as guide, sqlite3.connect(CHANNELS) as channels:
        rows = channels.execute('SELECT id,name,url FROM channels').fetchall()
        channel_names = {str(cid): name for cid, name, _ in rows}
        guide_ids = {}
        names = collections.defaultdict(set)
        for gid, name in guide.execute('SELECT guide_id,name FROM guide_channels'):
            guide_ids[gid.casefold()] = gid
            names[normalize(name)].add(gid)
        if override:
            cid, gid, reason = override
            if cid not in channel_names:
                raise ValueError(f'Unknown channel ID: {cid}')
            if gid is not None:
                if gid.casefold() not in guide_ids:
                    raise ValueError(f'Unknown guide ID: {gid}')
                gid = guide_ids[gid.casefold()]
            if not reason.strip():
                raise ValueError('A reason is required for a verified assignment or block')
            override = cid, gid, reason
            allowed = {cid}
        backup = GUIDE.with_name('guide-before-local-remap-' +
                                 datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.db')
        # SQLite's backup API also captures committed WAL data consistently.
        with sqlite3.connect(backup) as copy:
            guide.backup(copy)
        backup.chmod(0o600)
        with guide:
            guide.execute('BEGIN IMMEDIATE')
            ensure_overrides(guide)
            guide.execute('CREATE TABLE IF NOT EXISTS identifiers(channel_id TEXT PRIMARY KEY, tvg_id TEXT)')
            identifiers = dict(guide.execute('SELECT channel_id,tvg_id FROM identifiers'))
            current = dict(guide.execute('SELECT channel_id,guide_id FROM mapping'))
            additions = {}
            for cid, name, url in rows:
                cid = str(cid)
                if allowed is not None and cid not in allowed:
                    continue
                if not name or '/movie/' in (url or '') or '/series/' in (url or ''):
                    continue
                gid = match_channel(name, identifiers.get(cid), guide_ids, names)
                if gid:
                    additions[cid] = gid
            if override:
                cid, gid, reason = override
                set_override(guide, cid, channel_names[cid], gid, reason)
            current.update(additions)
            current = apply_overrides(guide, current, channel_names)
            guide.execute('DELETE FROM mapping')
            guide.executemany('INSERT INTO mapping VALUES (?,?)', current.items())
        print(f'Added or confirmed {len(additions)} automatic matches; total mappings: {len(current)}')
        print(f'Backup: {backup}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--csv', type=pathlib.Path)
    parser.add_argument('--category', default='likely_schedulable')
    parser.add_argument('--channel-id', help='Set a persistent override for only this channel')
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument('--guide-id', help='Verified XMLTV channel ID')
    choice.add_argument('--block', action='store_true', help='Keep an unverified channel unmapped')
    parser.add_argument('--reason', default='')
    args = parser.parse_args()
    override_requested = args.channel_id is not None or args.guide_id is not None or args.block or bool(args.reason)
    if override_requested and not (args.channel_id and (args.guide_id or args.block) and args.reason.strip()):
        parser.error('An override requires --channel-id, --guide-id or --block, and --reason')
    if override_requested and args.csv:
        parser.error('--csv cannot be combined with a channel override')
    allowed = None
    if args.csv:
        with args.csv.open(encoding='utf-8-sig', newline='') as handle:
            allowed = {row['channel_id'] for row in csv.DictReader(handle)
                       if row.get('category') == args.category}
    override = (args.channel_id, args.guide_id, args.reason) if override_requested else None
    remap(allowed, override)
