import csv
import pathlib
import re
import sqlite3
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent
source = pathlib.Path(r'C:\Users\Plex\Downloads\unmapped_channels_cleaned_final.csv')
output = ROOT / 'instance/unmapped_channels_classified.csv'
event_terms = re.compile(r'(?i)\b(?:vod|movie|film|episode|season|event|match|concert|ppv|catchup|replay|practice|qualifying)\b|\b\d{1,2}[./-]\d{1,2}\b|\b(?:19|20)\d{2}\b')
explicit_live = re.compile(r'(?i)\b(?:news|network|channel|tv|sports|sport|music|radio|live|24/7)\b')

with source.open(encoding='utf-8-sig', newline='') as handle:
    rows = list(csv.DictReader(handle))

names = Counter(re.sub(r'[^a-z0-9]+', ' ', (row['name'] or '').casefold()).strip() for row in rows)
classified = []
for row in rows:
    name = row['name'] or ''
    normalized = re.sub(r'[^a-z0-9]+', ' ', name.casefold()).strip()
    if not name.strip():
        category, reason = 'review', 'blank channel name'
    elif event_terms.search(name) and not explicit_live.search(name):
        category, reason = 'likely_event_or_vod', 'programme or event wording'
    elif names[normalized] > 1:
        category, reason = 'duplicate_name_review', f'{names[normalized]} channels share this normalized name'
    else:
        category, reason = 'likely_schedulable', 'network or channel name'
    classified.append({**row, 'category': category, 'reason': reason})

with output.open('w', encoding='utf-8-sig', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=['channel_id', 'name', 'tvg_id', 'category', 'reason'])
    writer.writeheader()
    writer.writerows(classified)

counts = Counter(row['category'] for row in classified)
print('Classification:', dict(counts))
print('Report:', output)
