"""Wire validation for the optional host-authoritative FPS backend.

This relay validates membership/ordering/bounds, not game physics. Slot zero is
the trusted simulation authority; a dedicated authoritative process is a future
transport integration, not something this relay pretends to provide.
"""
from collections import deque
import json
import math
from time import monotonic

BACKEND = 'authoritative-host-v1'
MAX_SNAPSHOT_BYTES = 65536


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def valid_command(command):
    return (isinstance(command, dict) and set(command) == {'buttons', 'moveX', 'moveY', 'lookX', 'lookY'}
            and integer(command['buttons'], 0, 65535)
            and all(integer(command[key], -127, 127) for key in ('moveX', 'moveY'))
            and all(integer(command[key], -32767, 32767) for key in ('lookX', 'lookY')))


def valid_state(state):
    budget = [12000]

    def walk(value, depth=0):
        budget[0] -= 1
        if budget[0] < 0 or depth > 12:
            return False
        if value is None or type(value) is bool:
            return True
        if type(value) in (int, float):
            return -1e15 <= value <= 1e15 and math.isfinite(value)
        if isinstance(value, str):
            return len(value) <= 4096
        if isinstance(value, list):
            return len(value) <= 4096 and all(walk(item, depth + 1) for item in value)
        if isinstance(value, dict):
            return len(value) <= 4096 and all(isinstance(key, str) and len(key) <= 128 and walk(item, depth + 1)
                                              for key, item in value.items())
        return False

    return (isinstance(state, dict) and walk(state)
            and len(json.dumps(state, separators=(',', ':'), allow_nan=False).encode('utf-8')) <= MAX_SNAPSHOT_BYTES)


class AuthorityRelay:
    def __init__(self, players, tick_rate, config, clock=monotonic):
        self.players, self.tick_rate, self.config, self.clock = players, tick_rate, config, clock
        self.started = clock()
        self.tick = -1
        self.state = None
        self.event_id = 0
        self.received = [0] * players
        self.acks = [0] * players
        self.pending = [deque() for _ in range(players)]
        self.event_history = deque()
        self.event_history_bytes = 0

    def command(self, slot, data):
        seq, view_tick, command = data.get('seq'), data.get('viewTick'), data.get('command')
        if (not integer(seq, self.received[slot] + 1, self.received[slot] + 1)
                or seq > self.acks[slot] + self.config['maxPending']
                or not integer(view_tick, 0, max(0, self.tick)) or not valid_command(command)):
            return None
        self.received[slot] = seq
        packet = dict(seq=seq, viewTick=view_tick, command=dict(command), slot=slot)
        self.pending[slot].append(packet)
        return packet

    def snapshot(self, data):
        tick, acks, state = data.get('tick'), data.get('acks'), data.get('state')
        delta = 'state' not in data
        if delta:
            changed, removed = data.get('changed'), data.get('removed')
            if (data.get('baseTick') != self.tick or self.state is None
                    or not valid_state(changed) or not isinstance(removed, list)
                    or len(removed) > 4096 or not all(isinstance(key, str) and len(key) <= 128 for key in removed)):
                return None
            state = {**self.state, **changed}
            for key in removed:
                state.pop(key, None)
        events = data.get('events', [])
        if not isinstance(events, list) or len(events) > 256:
            return None
        event_id = self.event_id
        for event in events:
            if (not isinstance(event, dict) or not integer(event.get('id'), event_id + 1, event_id + 1)
                    or not integer(event.get('tick'), max(0, self.tick + 1), tick if type(tick) is int else -1)
                    or event.get('type') not in ('shot', 'explosion', 'pickup', 'death', 'respawn')
                    or not valid_state(event.get('data'))
                    or ('prediction' in event and (not isinstance(event['prediction'], str) or len(event['prediction']) > 96))):
                return None
            event_id += 1
        try:
            if len(json.dumps(data, separators=(',', ':'), allow_nan=False).encode('utf-8')) > MAX_SNAPSHOT_BYTES:
                return None
        except (ValueError, TypeError, RecursionError):
            return None
        max_tick = int((self.clock() - self.started) * self.tick_rate) + 8
        if (not integer(tick, self.tick + 1, min(max_tick, max(0, self.tick) + self.tick_rate * 2))
                or (self.tick < 0 and tick != 0)
                or not isinstance(acks, list) or len(acks) != self.players
                or not all(integer(ack, self.acks[slot], min(self.received[slot], self.acks[slot] + tick - max(0, self.tick)))
                           for slot, ack in enumerate(acks)) or not valid_state(state)):
            return None
        self.tick, self.acks, self.state, self.event_id = tick, list(acks), state, event_id
        for slot, queue in enumerate(self.pending):
            while queue and queue[0]['seq'] <= self.acks[slot]:
                queue.popleft()
        for event in events:
            size = len(json.dumps(event,separators=(',',':')).encode('utf-8'))
            self.event_history.append((event,size)); self.event_history_bytes += size
        while len(self.event_history)>512 or self.event_history_bytes>131072:
            self.event_history_bytes -= self.event_history.popleft()[1]
        result = dict(tick=tick, acks=list(acks))
        if events:
            result['events'] = events
        if delta:
            result.update(baseTick=data['baseTick'], changed=data['changed'], removed=data['removed'])
        else:
            result['state'] = state
        return result

    def bootstrap(self):
        """Latest full world for a newly connected spectator, without old effects."""
        if self.state is None:
            return None
        packet = dict(tick=self.tick, acks=list(self.acks), state=self.state,
                      eventCursor=self.event_id)
        if len(json.dumps(packet, separators=(',', ':'), allow_nan=False).encode('utf-8')) > MAX_SNAPSHOT_BYTES:
            return None
        return packet

    def recovery(self, after_event):
        if not integer(after_event,0,self.event_id):
            return None
        packet = self.bootstrap()
        if packet is None:
            return None
        events = [event for event,_ in self.event_history if event['id']>after_event]
        complete = len(events)==self.event_id-after_event
        if complete:
            packet = {**packet,'events':events}
        if not complete or len(json.dumps(packet,separators=(',',':')).encode('utf-8'))>MAX_SNAPSHOT_BYTES:
            # A full world still recovers gameplay when transient cosmetic
            # events have aged out of the bounded history.
            packet = {**self.bootstrap(),'resetEffects':True}
        return packet
