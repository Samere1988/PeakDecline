"""Install the reviewed Live TV release, or restore its local deployment backup.

Run with sudo after tests. Copies only manifest-listed files, validates nginx,
restarts the service, and verifies both direct and nginx media protections.
Existing unrelated work and database contents are preserved.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import time
import urllib.error
import urllib.request

SOURCE = Path(__file__).resolve().parents[1]
TARGET = Path('/home/samer/servers/peakdecline')
NGINX = Path('/etc/nginx/sites-enabled/peakdecline').resolve()
BACKUPS = Path('/home/samer/Documents/ChatGPT/migration')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(*args):
    subprocess.run(args, check=True)


def nginx_config(original):
    snippet = (SOURCE / 'deploy/nginx-live-tv.conf').read_text().rstrip()
    if '# BEGIN LIVE TV ACCESS' in original:
        return re.sub(r'# BEGIN LIVE TV ACCESS.*?# END LIVE TV ACCESS', lambda _: snippet, original, flags=re.S)
    match = re.search(r'location /static/stream/\s*\{', original)
    if not match:
        raise RuntimeError('Expected nginx stream location not found; no changes made')
    depth, end = 1, match.end()
    while depth and end < len(original):
        if original[end] == '{':
            depth += 1
        elif original[end] == '}':
            depth -= 1
        end += 1
    if depth:
        raise RuntimeError('Cannot parse existing nginx stream location')
    return original[:match.start()] + snippet + original[end:]


def status(url):
    request = urllib.request.Request(url, method='HEAD', headers={'Host': 'peakdecline.com'})
    try:
        with urllib.request.urlopen(request, timeout=3, context=ssl._create_unverified_context()) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def validate_live():
    for _ in range(20):
        try:
            if status('http://127.0.0.1:8000/static/stream/1/index.m3u8') == 401:
                break
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(1)
    else:
        raise RuntimeError('Application did not start with protected media access')
    for base in ['http://127.0.0.1:8000', 'https://127.0.0.1']:
        for path, expected in [('/static/stream/1/index.m3u8', 401), ('/static/stream/1/ffmpeg_error.log', 404)]:
            actual = status(base + path)
            if actual != expected:
                raise RuntimeError(f'{base}{path}: expected {expected}, got {actual}')


def restore(backup):
    manifest = json.loads((backup / 'manifest.json').read_text())
    for relative in manifest['files']:
        shutil.copy2(backup / 'files' / relative, TARGET / relative)
    shutil.copy2(backup / 'nginx.conf', NGINX)
    command('nginx', '-t')
    command('systemctl', 'restart', 'peakdecline')
    command('systemctl', 'reload', 'nginx')
    print(f'Restored code and nginx configuration from {backup}')


def install():
    release = json.loads((SOURCE / 'deploy/live_tv_release.json').read_text())
    for relative, hashes in release['files'].items():
        if digest(SOURCE / relative) != hashes['release']:
            raise RuntimeError(f'Release file changed since validation: {relative}')
        if digest(TARGET / relative) not in [hashes['baseline'], hashes['release']]:
            raise RuntimeError(f'Production file changed since backup: {relative}')
    original = NGINX.read_text()
    replacement = nginx_config(original)
    backup = BACKUPS / ('live-tv-deploy-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700)
    (backup / 'manifest.json').write_text(json.dumps(release, indent=2))
    shutil.copy2(NGINX, backup / 'nginx.conf')
    for relative in release['files']:
        saved = backup / 'files' / relative
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(TARGET / relative, saved)
    print(f'Rollback backup: {backup}', flush=True)
    try:
        for relative in release['files']:
            # Write in place so existing ownership and mode are preserved.
            (TARGET / relative).write_bytes((SOURCE / relative).read_bytes())
        NGINX.write_text(replacement)
        command('nginx', '-t')
        command('systemctl', 'restart', 'peakdecline')
        command('systemctl', 'reload', 'nginx')
        validate_live()
        # Retain old diagnostics privately for rollback investigations.
        for log in (TARGET / 'static/stream').rglob('*.log'):
            destination = backup / 'old-stream-logs' / log.relative_to(TARGET / 'static/stream')
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.move(str(log), destination)
            destination.chmod(0o600)
    except Exception:
        restore(backup)
        raise
    print('Live TV deployed. Direct and nginx authentication checks passed.')
    print(f'Rollback: sudo python3 {__file__} --rollback {backup}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('System nginx configuration and service restart require sudo')
    if args.rollback:
        restore(args.rollback.resolve())
    else:
        install()
