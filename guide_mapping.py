"""Shared, conservative channel matching and operator-verified assignments."""
import re
import time


def normalize(value):
    value = re.sub(r'\b(?:HEVC|H\.?265|H\.?264|HD|FHD|UHD|4K|SD|1080P|720P)\b',
                   '', value or '', flags=re.I)
    return re.sub(r'\s+', ' ', value).strip().casefold()


def match_channel(name, tvg_id, guide_ids, names):
    # A playlist identifier is stronger evidence than a shared brand name.
    # If its feed is missing, do not substitute another region's schedule.
    if tvg_id:
        return guide_ids.get(tvg_id.casefold())
    candidates = names.get(normalize(name), set())
    return next(iter(candidates)) if len(candidates) == 1 else None


def ensure_overrides(db):
    db.execute('''CREATE TABLE IF NOT EXISTS mapping_overrides(
        channel_id TEXT PRIMARY KEY, channel_name TEXT NOT NULL,
        guide_id TEXT, reason TEXT NOT NULL, updated REAL NOT NULL)''')


def set_override(db, channel_id, channel_name, guide_id, reason):
    if not reason.strip():
        raise ValueError('A reason is required for a verified assignment or block')
    ensure_overrides(db)
    db.execute('INSERT OR REPLACE INTO mapping_overrides VALUES (?,?,?,?,?)',
               (str(channel_id), channel_name, guide_id, reason, time.time()))


def apply_overrides(db, mappings, channel_names):
    result = dict(mappings)
    for cid, expected_name, gid in db.execute(
            'SELECT channel_id,channel_name,guide_id FROM mapping_overrides'):
        # Channel IDs can be reused when a playlist is replaced.
        if channel_names.get(cid) != expected_name:
            if result.get(cid) == gid:
                result.pop(cid, None)
            continue
        if gid is None:
            result.pop(cid, None)
        else:
            # Preserve the assignment even if its source is temporarily absent.
            # Missing listings are preferable to another region's programmes.
            result[cid] = gid
    return result
