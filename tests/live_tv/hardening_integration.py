"""Run against tests/live_tv/server.py on loopback, never the production app."""
import json
import os
from pathlib import Path
import time
import requests

base = 'http://127.0.0.1:' + os.environ.get('LIVE_TEST_PORT', '18781')
client = requests.Session()
assert client.get(base + '/test/login/0', allow_redirects=False).status_code == 302
report = []


def check(name, condition, **details):
    report.append(dict(name=name, passed=bool(condition), **details))
    print(name, condition, details, flush=True)
    assert condition, name


try:
    check('anonymous HLS blocked', requests.get(base + '/static/stream/1/index.m3u8').status_code == 401)
    check('logs never served', client.get(base + '/static/stream/1/ffmpeg_error.log').status_code == 404)
    result = client.post(base + '/api/play/4').json()
    check('video-only source starts', result.get('status') == 'success')
    master = client.get(base + '/static/stream/4/index.m3u8')
    check('all three video-only variants published', master.status_code == 200 and master.text.count('#EXT-X-STREAM-INF:') == 3)
    for mode in ['exit', 'freeze']:
        client.post(base + '/api/play/4')  # Refresh the test's empty-room grace.
        session = client.post(base + '/test/fail/' + mode).json()['session']
        began = time.monotonic()
        while time.monotonic() - began < 50:
            state = client.get(base + '/api/status').json()
            if state['is_streaming'] and state['stream_session'] and state['stream_session'] != session and not state['stream_recovering']:
                break
            time.sleep(1)
        check('watchdog recovers ' + mode, state['is_streaming'] and state['stream_session'] != session,
              seconds=round(time.monotonic() - began, 2))
    client.post(base + '/api/live/stop', json={'stream_session': state['stream_session']})
    time.sleep(3)
    check('explicit stop prevents resurrection', not client.get(base + '/api/status').json()['is_streaming'])
finally:
    output = Path(os.environ.get('LIVE_TEST_RESULTS', '.tmp/live-tv-results'))
    output.mkdir(parents=True, exist_ok=True)
    (output / 'backend-integration.json').write_text(json.dumps(report, indent=2))
