"""Audit every playlist entry against region-aware guide identities; no stream requests.

Reports contain names and guide IDs, never provider URLs or credentials. --apply
uses only the explicit proposals in a previously reviewed audit and rechecks its
channel snapshot. Ordinary inspection is read-only.
"""
import argparse
import collections
import datetime as dt
import hashlib
import concurrent.futures
import gzip
import xml.etree.ElementTree as ET
import requests
import json
import pathlib
import re
import sqlite3
import time

from guide_mapping import apply_overrides, ensure_overrides, set_override

ROOT = pathlib.Path(__file__).resolve().parent
COUNTRIES = {'us': 'US', 'usa': 'US', 'ca': 'CA', 'canada': 'CA', 'uk': 'GB',
             'gb': 'GB', 'fr': 'FR', 'france': 'FR', 'de': 'DE', 'germany': 'DE',
             'mx': 'MX', 'mex': 'MX', 'au': 'AU', 'australia': 'AU', 'br': 'BR',
             'brazil': 'BR', 'it': 'IT', 'italy': 'IT', 'es': 'ES', 'spain': 'ES',
             'se': 'SE', 'sweden': 'SE', 'nz': 'NZ', 'ru': 'RU', 'ph': 'PH',
             'sg': 'SG', 'in': 'IN', 'pe': 'PE', 'ae': 'AE', 'uy': 'UY'}
CALL = re.compile(r'\b([kw][a-z]{2,3})(?:[- ]?(?:dt|d|ld|tv)[- ]?([1-9][0-9]*))?\b', re.I)
NOT_CALLS = {'west', 'with', 'wild', 'kids', 'city', 'cook', 'club', 'cars', 'care', 'cool', 'crew', 'class', 'cave', 'wine', 'walk', 'work', 'will', 'war', 'cafe', 'cat'}
NETWORK = re.compile(r'\b(abc|cbs|nbc|fox|pbs|cw|cnbc|cgtn|ctv|cbc|global|telemundo|univision|my(?:networktv|tv|net)?|mnt|tmo|ion(?: mystery)?|me ?tv|antenna(?: tv)?|rewind(?: tv)?|create|the florida channel)(?=\b|[0-9])', re.I)
# These aliases refer to the same brand and feed; they do not erase +1, West,
# language, station, or regional distinctions.
ALIASES = {'aande.us': 'AandENetwork.us', 'historychannel.us': 'History.us',
           'lifetimenetwork.us': 'Lifetime.us', 'hallmark.us': 'HallmarkChannel.us',
           'natgeo.us': 'NationalGeographic.us', 'natgeowild.us': 'NationalGeographicWild.us',
           'travel.us': 'TravelChannel.us', 'discoveryscience.us': 'ScienceChannel.us',
           'fyi.us': 'FYIChannel.us', 'tvlandeast.us': 'TVLand.us',
           'tvlandwest.us': 'TVLandPacific.us',
           'smithsonianchannel.us': 'SmithsonianNetwork.us',
           'turnerclassicmovies.ca': 'TCM.ca',
           'nationalgeographiccanada.ca': 'NationalGeographic.ca',
           'msnbc.us': 'MSNOW.us'}


def key(value):
    # A 4K-branded guide can be a separate event feed, not a simulcast.
    value = re.sub(r'\b(?:HEVC|H\.?265|H\.?264|HD|FHD|UHD|SD|1080P|720P)\b', '', value or '', flags=re.I).casefold().replace('&', 'and')
    value = re.sub(r'\b(?:fhd|uhd|hevc|vip)\b', '', value)
    return re.sub(r'[^a-z0-9+]', '', value)


def label(value):
    """Return country and unadorned label, keeping every feed qualifier."""
    value = (value or '').strip()
    value = re.sub(r'^\(SP2\)\s*', '', value, flags=re.I)
    match = re.match(r'^\((US|CA|FR|UK|DE)\)\s*', value, re.I)
    if not match:
        match = re.match(r'^(USA|US|CA|UK|GB|FR|DE|MEX)(?:HD|SD|FHD)?\s*[:\s]\s*', value, re.I)
    country = COUNTRIES.get(match.group(1).casefold()) if match else None
    if match:
        value = value[match.end():]
    # Provider transport tiers do not change a schedule. Bracketed city names do.
    value = re.sub(r'^\((?:H|A|D|RK|GLB)\)\s*', '', value, flags=re.I)
    value = re.sub(r'\s*\((?:H|A|D|F)\)\s*$', '', value, flags=re.I)
    value = re.sub(r'\[vip\]', '', value, flags=re.I).strip()
    return country, value


def identifier_region(value):
    match = re.search(r'\.([a-z]{2})(?:[0-9]+|_locals[0-9]*)?$', value or '', re.I)
    return COUNTRIES.get(match.group(1).casefold()) if match else None


def calls(value, strict=False):
    found = {(m.group(1).casefold(), m.group(2) or '1') for m in CALL.finditer(value or '')
             if m.group(1).casefold() not in NOT_CALLS and
             (not strict or m.group(1).isupper())}
    # A label may repeat the station before specifying its actual subchannel.
    explicit = {base for base, sub in found if sub != '1'}
    return {(base, sub) for base, sub in found if sub != '1' or base not in explicit}


def networks(value):
    aliases = {'mnt': 'my', 'mynet': 'my', 'mytv': 'my', 'mynetworktv': 'my', 'tmo': 'telemundo',
               'me tv': 'metv', 'antenna tv': 'antenna', 'rewind tv': 'rewind'}
    return {aliases.get(x.casefold(), x.casefold()) for x in NETWORK.findall(value)}


def fingerprint(row):
    return hashlib.sha256(json.dumps(row, ensure_ascii=False).encode()).hexdigest()


class Catalog:
    def __init__(self, guides, country_catalog, listings):
        self.guides, self.listings = guides, listings
        self.ids = {gid.casefold(): gid for gid in guides}
        self.regions = collections.defaultdict(set)
        self.names = collections.defaultdict(set)
        self.stations = collections.defaultdict(set)
        self.guide_calls = {}
        for country, rows in country_catalog.get('countries', {}).items():
            for gid in rows:
                if gid in guides:
                    self.regions[gid].add(country)
        for gid, name in guides.items():
            country = identifier_region(gid)
            if country:
                self.regions[gid].add(country)
            display = re.sub(r'^(?:us|ca)\s*-\s*', '', name, flags=re.I)
            self.names[key(display)].add(gid)
            if country:
                self.names[key(gid.rsplit('.', 1)[0])].add(gid)
            station_calls = calls(display)
            self.guide_calls[gid] = station_calls
            # Prefer station-specific IDs to alternate national relay IDs.
            station_id = re.sub(r'^(?:ABC|CBS|NBC|FOX|PBS(?:Kids|Knowledge)?|CW|TV[0-9]+|MY|Telemundo|Univision)', '', gid.rsplit('.', 1)[0], flags=re.I)
            is_station = re.fullmatch(r'(?:[kw][a-z]{2,3}|c[a-z]{3})(?:dt[0-9]+)?', station_id, re.I)
            is_canadian_station = gid.endswith('.ca') and re.search(r'-C[A-Z]{3}$', station_id, re.I)
            if (is_station or is_canadian_station) and gid.casefold().endswith(('.us', '.ca')) and '_' not in gid:
                for call in station_calls:
                    self.stations[call].add(gid)

    def choose(self, candidates, country):
        candidates = set(candidates)
        if country:
            candidates = {gid for gid in candidates if self.regions[gid] == {country}}
        elif len({country for gid in candidates for country in self.regions[gid]}) != 1:
            return None, sorted(candidates)
        # Country-qualified IDs give the provider-compatible identity. Numeric
        # sources are a fallback only when unambiguous within the same country.
        structured = {gid for gid in candidates if identifier_region(gid)}
        if len(structured) == 1:
            return next(iter(structured)), sorted(candidates)
        if len(candidates) == 1:
            return next(iter(candidates)), sorted(candidates)
        return None, sorted(candidates)

    def resolve(self, name, tvg_id):
        name = name or ''
        country, plain = label(name)
        id_country = identifier_region(tvg_id)
        if country and id_country and country != id_country:
            # FR and MEX also occur as language/category labels for Canadian
            # French and US Spanish stations; their exact IDs take precedence.
            if country in {'FR', 'MX'} and self.ids.get((tvg_id or '').casefold()):
                country = id_country
            else:
                return None, 'conflicting_country_labels', []
        country = country or id_country
        exact = self.ids.get((tvg_id or '').casefold())
        if exact:
            if country and self.regions[exact] and country not in self.regions[exact]:
                return None, 'conflicting_country_labels', [exact]
            # Explicit call signs and networks must agree even for exact IDs.
            named_calls = calls(plain, strict=True) & set(self.stations)
            if named_calls and not named_calls & self.guide_calls[exact]:
                return None, 'conflicting_station_identifier', [exact]
            return exact, 'exact_playlist_identifier', [exact]
        alias = self.ids.get(ALIASES.get((tvg_id or '').casefold(), '').casefold())
        if alias:
            return alias, 'explicit_identifier_alias', [alias]
        # Preserve provider event slots / movie loops / platform-specific feeds.
        if re.search(r'^(?:/7|PPV\b|NCAAF\b|RallyTV\b|DAZNCA\s*[0-9])|24/7|24x7|no event scheduled|replay available|\b(?:UFC|NFL|MLB|NBA|NHL|Tennis TV|FIFAWC)\s*\d', name, re.I):
            return None, 'event_or_loop_without_matching_identifier', []
        if re.search(r'^\(PLUTO|^Roku\b|\(RK\)|\(MAX ', name, re.I):
            return None, 'platform_feed_requires_exact_identifier', []
        named_calls = calls(plain, strict=True) & set(self.stations)
        raw_id_calls = calls(tvg_id) & set(self.stations)
        if not named_calls and raw_id_calls and key(plain) in {'pbs', 'nbc', 'cbs', 'abc', 'fox', 'cw'}:
            named_calls = raw_id_calls
        if named_calls:
            candidates = set().union(*(self.stations[c] for c in named_calls))
            if country:
                candidates = {g for g in candidates if self.regions[g] == {country}}
            elif any(g.endswith('.us') for g in candidates):
                candidates = {g for g in candidates if g.endswith('.us')}
            requested_networks = networks(plain)
            if requested_networks:
                candidates = {g for g in candidates if requested_networks & networks(self.guides[g])}
            city = re.search(r'\[([^]]+)\]', plain)
            if city:
                city_words = {x for x in re.findall(r'[a-z]+', city.group(1).casefold()) if len(x) > 3}
                if city_words:
                    candidates = {g for g in candidates if city_words & set(re.findall(r'[a-z]+', self.guides[g].casefold()))}
            # A requested subchannel must match; a network on DT2 can be selected
            # by its network and base call sign only when that combination is unique.
            chosen, choices = self.choose(candidates, country)
            if chosen:
                return chosen, 'station_call_sign_and_network', choices
            return None, 'ambiguous_station', choices
        if not country and key(plain) in {'network', 'entertainment', 'movies', 'nature', 'family', 'news', 'sports', 'pbs', 'nbc', 'cbs', 'abc', 'fox', 'cw', 'ctv', 'cbc', 'hbo', 'history'}:
            return None, 'generic_name_without_region', []
        candidates = set(self.names.get(key(plain), ()))
        if tvg_id and id_country:
            stem = re.sub(r'\.[a-z]{2}(?:[0-9]+|_locals[0-9]*)?$', '', tvg_id, flags=re.I)
            by_id = set(self.names.get(key(stem), ()))
            if by_id and candidates and not by_id & candidates:
                return None, 'conflicting_name_and_identifier', sorted(by_id | candidates)
            if by_id:
                candidates = by_id if not candidates else by_id & candidates
            elif candidates:
                # An unknown ID cannot be silently discarded for a brand name.
                simplified_id = re.sub(r'(?:television|channel|network|tv)$', '', key(stem))
                simplified_name = re.sub(r'(?:television|channel|network|tv)$', '', key(plain))
                if simplified_id != simplified_name:
                    return None, 'unresolved_identifier_alias', sorted(candidates)
        elif tvg_id and not tvg_id.isdigit() and candidates:
            # Unqualified station IDs or opaque IDs can contradict the label.
            if key(tvg_id) != key(plain):
                return None, 'unresolved_identifier_alias', sorted(candidates)
        chosen, choices = self.choose(candidates, country)
        if chosen:
            return chosen, 'exact_name_with_country' if country else 'unique_name_and_country_in_catalog', choices
        return None, 'ambiguous_or_missing_guide', choices


def fetch_catalog(output):
    """Fetch only the channel headers from the publisher's country XMLTV files."""
    codes = 'AU BR CA CN DE FR GB HK ID IN JP MY NZ PH RU SG TW US VN ZA'.split()
    def fetch(code):
        rows = {}
        with requests.get(f'https://epg.pw/xmltv/epg_{code}.xml.gz', stream=True, timeout=(10, 30)) as response:
            response.raise_for_status()
            with gzip.GzipFile(fileobj=response.raw) as xml:
                for _, element in ET.iterparse(xml, events=('end',)):
                    if element.tag == 'programme':
                        break
                    if element.tag == 'channel':
                        rows[element.get('id')] = [e.text for e in element.findall('display-name') if e.text]
                        element.clear()
        return code, rows
    countries = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for code, rows in pool.map(fetch, codes):
            countries[code] = rows
    # A partial download raises before replacing an existing catalog.
    output.write_text(json.dumps({'fetched': time.time(), 'source': 'https://epg.pw/xmltv.html?lang=en', 'countries': countries}))


def audit(channels_path, guide_path, catalog_path, output):
    with sqlite3.connect(f'file:{channels_path}?mode=ro', uri=True) as channels, sqlite3.connect(f'file:{guide_path}?mode=ro', uri=True) as guide:
        channels_rows = channels.execute('SELECT id,name,url FROM channels').fetchall()
        mappings = dict(guide.execute('SELECT channel_id,guide_id FROM mapping'))
        identifiers = dict(guide.execute('SELECT channel_id,tvg_id FROM identifiers'))
        guides = dict(guide.execute('SELECT guide_id,name FROM guide_channels'))
        overrides = {cid: (name, gid, reason) for cid, name, gid, reason in guide.execute('SELECT channel_id,channel_name,guide_id,reason FROM mapping_overrides')}
        now = time.time()
        listings = dict(guide.execute('SELECT guide_id,count(*) FROM programmes WHERE stop>? AND start<? GROUP BY guide_id', (now, now + 86400)))
        current_titles = dict(guide.execute('SELECT guide_id,title FROM programmes WHERE start<=? AND stop>?', (now, now)))
    catalog = Catalog(guides, json.loads(catalog_path.read_text()), listings)
    rows = []
    for cid, name, url in channels_rows:
        old = mappings.get(cid)
        tvg_id = identifiers.get(cid, '')
        chosen, method, candidates = catalog.resolve(name, tvg_id)
        action = 'unchanged'
        if cid in overrides and overrides[cid][0] == name:
            chosen = overrides[cid][1]
            method = 'existing_override' if chosen else 'existing_block'
        elif chosen and listings.get(chosen):
            if method == 'unique_name_and_country_in_catalog':
                # Absence of another country in this catalog does not establish
                # the stream's region. Keep these as reviewable suggestions.
                action = 'review'
            else:
                action = 'confirm' if chosen == old else 'assign'
        elif old and ((catalog.regions[old] and (label(name)[0] or identifier_region(tvg_id)) and
                       (label(name)[0] or identifier_region(tvg_id)) not in catalog.regions[old]) or
                      method.startswith('conflicting_')):
            chosen = None
            method = 'existing_mapping_needs_review'
        elif chosen and not listings.get(chosen):
            method = 'matched_identity_without_current_listings'
            chosen = None
        rows.append({'channel_id': cid, 'name': name, 'playlist_identifier': tvg_id,
                     'before': old, 'proposed': chosen, 'method': method, 'action': action,
                     'candidates': candidates, 'current_title': current_titles.get(chosen),
                     'snapshot': fingerprint([cid, name, url, tvg_id, old, overrides.get(cid)])})
    result = {'created': dt.datetime.now(dt.timezone.utc).isoformat(), 'channels': len(rows),
              'actions': dict(collections.Counter(r['action'] for r in rows)),
              'methods': dict(collections.Counter(r['method'] for r in rows)), 'rows': rows}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    output.chmod(0o600)
    print(json.dumps({k: v for k, v in result.items() if k != 'rows'}, indent=2))
    return result


def apply_report(channels_path, guide_path, report_path):
    report = json.loads(report_path.read_text())
    if time.time() - dt.datetime.fromisoformat(report['created']).timestamp() > 86400:
        raise ValueError('Audit is older than 24 hours; run it again')
    if len({r['channel_id'] for r in report['rows']}) != len(report['rows']):
        raise ValueError('Duplicate channel IDs in audit')
    with sqlite3.connect(f'file:{channels_path}?mode=ro', uri=True) as channels, sqlite3.connect(guide_path) as guide:
        channels.execute('BEGIN')  # Keep channel identities stable through the guide commit.
        live = {cid: (name, url) for cid, name, url in channels.execute('SELECT id,name,url FROM channels')}
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
        backup = guide_path.with_name(f'guide-before-audit-{stamp}.db')
        with sqlite3.connect(backup) as copy:
            guide.backup(copy)
        backup.chmod(0o600)
        with guide:
            guide.execute('BEGIN IMMEDIATE')
            ensure_overrides(guide)
            mappings = dict(guide.execute('SELECT channel_id,guide_id FROM mapping'))
            ids = dict(guide.execute('SELECT channel_id,tvg_id FROM identifiers'))
            overrides = {cid: (name, gid, reason) for cid, name, gid, reason in guide.execute('SELECT channel_id,channel_name,guide_id,reason FROM mapping_overrides')}
            changes = [r for r in report['rows'] if r['action'] in {'assign', 'block', 'confirm'}]
            for row in changes:
                cid = row['channel_id']
                name, url = live[cid]
                snap = fingerprint([cid, name, url, ids.get(cid, ''), mappings.get(cid), overrides.get(cid)])
                if snap != row['snapshot']:
                    raise ValueError(f'Channel {cid} changed after audit; no changes applied')
                gid = row['proposed']
                if gid and not guide.execute('SELECT 1 FROM guide_channels WHERE guide_id=?', (gid,)).fetchone():
                    raise ValueError(f'Guide for channel {cid} is no longer available')
                set_override(guide, cid, name, gid,
                             f'Channel audit {report["created"]}: {row["method"]}; evidence is playlist/catalog identity, not visual playback verification.')
            updated = apply_overrides(guide, mappings, {cid: name for cid, (name, _) in live.items()})
            guide.execute('DELETE FROM mapping')
            guide.executemany('INSERT INTO mapping VALUES (?,?)', updated.items())
        print(json.dumps({'backup': str(backup), 'saved_assignments_or_blocks': len(changes), 'mapped_channels': len(updated)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--channels', type=pathlib.Path, default=ROOT / 'instance/channels.db')
    parser.add_argument('--guide', type=pathlib.Path, default=ROOT / 'instance/guide.db')
    parser.add_argument('--catalog', type=pathlib.Path)
    parser.add_argument('--fetch-catalog', type=pathlib.Path, help='Download country/channel headers to this file')
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--apply', type=pathlib.Path, help='Apply an inspected report with snapshot checks and backup')
    args = parser.parse_args()
    if args.fetch_catalog:
        fetch_catalog(args.fetch_catalog)
    elif args.apply:
        apply_report(args.channels, args.guide, args.apply)
    elif args.catalog and args.output:
        audit(args.channels, args.guide, args.catalog, args.output)
    else:
        parser.error('Use --catalog and --output, or --apply')
