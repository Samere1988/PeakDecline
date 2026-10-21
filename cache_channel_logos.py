"""Download unique channel logos locally; retain original URLs on failure."""
import concurrent.futures
import hashlib
import pathlib
import sqlite3
import requests

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / 'static/img/channel-cache'

def download(url):
    key = hashlib.sha256(url.encode()).hexdigest()
    try:
        with requests.get(url, timeout=(5, 12), stream=True) as response:
            response.raise_for_status()
            kind = response.headers.get('Content-Type', '').split(';')[0]
            extension = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif'}.get(kind)
            if not extension:
                return None
            content = bytearray()
            for chunk in response.iter_content(65536):
                content.extend(chunk)
                if len(content) > 2_000_000:
                    return None
            valid = (content.startswith(b'\x89PNG\r\n\x1a\n') or content.startswith(b'\xff\xd8\xff')
                     or content.startswith((b'GIF87a', b'GIF89a'))
                     or (content[:4] == b'RIFF' and content[8:12] == b'WEBP'))
            if not valid:
                return None
            filename = key + extension
            (CACHE / filename).write_bytes(content)
            return '/channel-logos/' + filename, url
    except requests.RequestException:
        return None

if __name__ == '__main__':
    CACHE.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(ROOT / 'instance/channels.db', timeout=30) as db:
        urls = [row[0] for row in db.execute("SELECT DISTINCT logo FROM channels WHERE logo LIKE 'https://%' OR logo LIKE 'http://%'")]
        backup = ROOT / 'instance/channels-before-logo-cache.db'
        if not backup.exists():
            with sqlite3.connect(backup) as target:
                db.backup(target)
        count = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            for result in pool.map(download, urls):
                if result:
                    count += db.execute('UPDATE channels SET logo=? WHERE logo=?', result).rowcount
                    db.commit()
        print(f'Cached logos for {count} channel rows; checked {len(urls)} unique URLs.')
