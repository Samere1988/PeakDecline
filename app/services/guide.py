"""Nonblocking local guide queries; refresh at most every six hours."""
import pathlib
import sqlite3
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
lock = threading.Lock()
worker = None
next_check = 0

def lookup(channel_id):
    global worker, next_check
    result = {'now': None, 'next': None, 'updated': None, 'source': 'EPG.PW'}
    path = ROOT / 'instance/guide.db'
    if path.exists():
        try:
            with sqlite3.connect(path, timeout=1) as db:
                row = db.execute("SELECT value FROM metadata WHERE key='updated'").fetchone()
                result['updated'] = float(row[0]) if row else None
                gid = db.execute('SELECT guide_id FROM mapping WHERE channel_id=?', (str(channel_id),)).fetchone()
                if gid:
                    now = time.time()
                    for key, condition, args in [('now', 'start<=? AND stop>?', (now, now)), ('next', 'start>?', (now,))]:
                        row = db.execute('SELECT title,start,stop FROM programmes WHERE guide_id=? AND ' + condition + ' ORDER BY start LIMIT 1', (gid[0], *args)).fetchone()
                        if row:
                            result[key] = dict(zip(('title', 'start', 'stop'), row))
        except sqlite3.Error:
            pass
    with lock:
        if time.time() > next_check and (worker is None or worker.poll() is not None):
            next_check = time.time() + 900
            if not result['updated'] or time.time() - result['updated'] > 21600:
                with (ROOT / 'instance/guide-refresh.log').open('a') as log:
                    worker = subprocess.Popen([sys.executable, str(ROOT / 'refresh_guide.py')], cwd=ROOT, stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return result
