"""Conservative local logo repair; backs up SQLite before applying changes."""
import collections
import datetime
import pathlib
import sqlite3

root = pathlib.Path(__file__).resolve().parents[2]
database = root / 'instance/channels.db'
with sqlite3.connect(database) as connection:
    rows = connection.execute('SELECT id, name, logo FROM channels').fetchall()
    known = collections.defaultdict(set)
    for _, name, logo in rows:
        if logo and logo.startswith(('https://', '/static/')):
            known[(name or '').strip().casefold()].add(logo)
    changes = []
    for channel_id, name, logo in rows:
        replacement = None
        if not logo and name:
            candidates = known[name.strip().casefold()]
            if len(candidates) == 1:
                replacement = next(iter(candidates))
        elif logo and '\\' in logo:
            candidate = root / 'static/img/logos' / logo.replace('\\', '/').split('/')[-1]
            if candidate.is_file():
                replacement = '/' + candidate.relative_to(root).as_posix()
        if replacement and replacement != logo:
            changes.append((replacement, channel_id))
    backup = database.with_name('channels-before-logo-repair-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.db')
    with sqlite3.connect(backup) as destination:
        connection.backup(destination)
    connection.executemany('UPDATE channels SET logo=? WHERE id=?', changes)
    connection.commit()
    print('Updated:', len(changes))
    print('Remaining empty:', connection.execute("SELECT COUNT(*) FROM channels WHERE logo IS NULL OR logo='' ").fetchone()[0])
    print('Backup:', backup)
