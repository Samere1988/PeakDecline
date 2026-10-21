"""Small, validated diagnostics records; never stores inputs or game state."""
import hashlib
import json
import logging
import math

LOGGER = logging.getLogger('peakdecline.netplay')
LOGGER.setLevel(logging.INFO)
LOGGER.propagate = False
if not LOGGER.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter('NETPLAY %(message)s'))
    LOGGER.addHandler(handler)

LIMITS = dict(windowMs=600000, frames=1000000, frame=2147483647,
    displayFrames=1000000, noProgressMs=600000, hiddenMs=600000,
    inactiveMs=600000, catchupMs=600000, rttMs=60000, rttMaxMs=60000,
    probes=1000, probeTimeouts=1000, inputDelayFrames=128,
    rollbackCount=2147483647, confirmedFrame=2147483647)

RENDER_LIMITS = dict(samples=1000000, p95Ms=1000, p99Ms=1000, maxMs=600000,
    over50=1000000, over100=1000000, recordMs=600000, renderMs=600000,
    waitMs=600000, idleMs=600000)

def validate(data):
    if not isinstance(data, dict) or set(data) - {'render'} != set(LIMITS) | {'epoch','hidden','transport'}:
        return None
    if type(data['epoch']) is not int or type(data['hidden']) is not bool:
        return None
    if data['transport'] not in ('websocket','polling','disconnected','unknown'):
        return None
    for key, limit in LIMITS.items():
        value = data[key]
        if key in ('rttMs','rttMaxMs') and value is None:
            continue
        if type(value) not in (int,float) or not math.isfinite(value) or not 0 <= value <= limit:
            return None
    if data['windowMs'] < 100 or any(data[k] > data['windowMs'] + 1 for k in ('noProgressMs','hiddenMs','inactiveMs','catchupMs')):
        return None
    result = {k: data[k] for k in (*LIMITS, 'hidden','transport')}
    if 'render' in data:
        render = data['render']
        if not isinstance(render, dict) or set(render) != set(RENDER_LIMITS):
            return None
        for key, limit in RENDER_LIMITS.items():
            value = render[key]
            if type(value) not in (int,float) or not math.isfinite(value) or not 0 <= value <= limit:
                return None
        if not render['samples'] or not render['over100'] <= render['over50'] <= render['samples'] or render['p95Ms'] > render['p99Ms']:
            return None
        result['render'] = dict(render)
    return result

def record(event, code, room, sid=None, **values):
    person = room['members'].get(sid,{})
    row = dict(event=event, room=code, name=room['name'], game=room['game']['id'],
        backend=room['game']['backend'], epoch=room['epoch'], **values)
    if sid:
        row.update(peer=hashlib.sha256(sid.encode()).hexdigest()[:12],
                   role=person.get('role'), slot=person.get('slot'))
    LOGGER.info(json.dumps(row, ensure_ascii=True, separators=(',',':')))
