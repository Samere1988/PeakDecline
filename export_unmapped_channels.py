import csv
import pathlib
import sqlite3

ROOT = pathlib.Path(__file__).resolve().parent
output = ROOT / 'instance/unmapped_channels.csv'

with sqlite3.connect(ROOT / 'instance/channels.db') as channels, sqlite3.connect(ROOT / 'instance/guide.db') as guide:
    mapped = {str(row[0]) for row in guide.execute('select channel_id from mapping')}
    identifiers = dict(guide.execute('select channel_id,tvg_id from identifiers'))
    rows = channels.execute('select id,name,url from channels order by lower(name),id').fetchall()
    with output.open('w', newline='', encoding='utf-8-sig') as handle:
        writer = csv.writer(handle)
        writer.writerow(['channel_id', 'name', 'tvg_id'])
        writer.writerows((cid, name or '', identifiers.get(str(cid), '')) for cid, name, _ in rows if str(cid) not in mapped)
print(f'Wrote {sum(str(cid) not in mapped for cid, _, _ in rows):,} unmapped channels to {output}')
