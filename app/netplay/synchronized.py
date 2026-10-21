"""Ordered controller history. No simulation, prediction, or game-state snapshots."""
import base64
import struct
import tempfile

BACKEND = 'sync-input-v1'
WINDOW = 64
CHUNK = 600
NEUTRAL = dict(buttons=0, moveX=0, moveY=0, lookX=0, lookY=0)
PAD = struct.Struct('<Hbbhh')
MAX_FRAMES = 60 * 60 * 60 * 24


def valid_command(value):
    return (isinstance(value, dict) and set(value) == set(NEUTRAL)
            and all(type(value[k]) is int and -limit <= value[k] <= limit
                    for k, limit in [('moveX', 127), ('moveY', 127), ('lookX', 32767), ('lookY', 32767)])
            and type(value['buttons']) is int and 0 <= value['buttons'] <= 2047)


class InputHistory:
    def __init__(self, players):
        self.players = players
        self.frame = 0
        self.pending = {}
        self.active = [1] * players
        self.history = tempfile.TemporaryFile()
        self.hashes = {}

    def close(self):
        self.history.close()

    def seat(self, slot, active):
        self.active[slot] = self.frame + 6 if active else None
        for row in self.pending.values():
            row.pop(slot, None)
        return self.active[slot]

    def input(self, slot, frame, command):
        if (type(frame) is not int or not self.frame < frame <= self.frame + WINDOW
                or not valid_command(command) or self.active[slot] is None):
            return False
        row = self.pending.setdefault(frame, {})
        previous = row.get(slot)
        if previous is not None and previous != command:
            raise ValueError('Conflicting controller inputs.')
        row[slot] = dict(command)
        return True

    def drain(self):
        start = self.frame + 1
        # Without any player there is no clock driver. A reconnect resumes it.
        if not any(at is not None for at in self.active):
            return None
        while self.frame < MAX_FRAMES:
            frame = self.frame + 1
            row = self.pending.get(frame, {})
            if any(at is not None and frame >= at and slot not in row
                   for slot, at in enumerate(self.active)):
                break
            # Never run ahead solely on inactive seats or activation grace.
            if not row:
                break
            commands = [row.get(slot, NEUTRAL) if at is not None and frame >= at else NEUTRAL
                        for slot, at in enumerate(self.active)]
            self.history.seek(self.frame * self.players * PAD.size)
            self.history.write(b''.join(PAD.pack(*(cmd[key] for key in NEUTRAL)) for cmd in commands))
            self.pending.pop(frame, None)
            self.frame = frame
        return self.packet(start) if self.frame >= start else None

    def packet(self, start):
        if type(start) is not int or start < 1 or start > self.frame + 1:
            return None
        count = min(CHUNK, self.frame - start + 1)
        self.history.seek((start - 1) * self.players * PAD.size)
        data = self.history.read(count * self.players * PAD.size)
        return dict(start=start, count=count, through=self.frame,
                    data=base64.b64encode(data).decode('ascii'))

    def idle(self, count):
        """Keep the original game ticking for viewers with no active controller."""
        if any(at is not None for at in self.active):
            return None
        count = min(max(0, count), 4, MAX_FRAMES - self.frame)
        if not count:
            return None
        start = self.frame + 1
        self.history.seek(self.frame * self.players * PAD.size)
        self.history.write(bytes(count * self.players * PAD.size))
        self.frame += count
        return self.packet(start)

    def check_hash(self, slot, frame, value):
        if (type(frame) is not int or not max(0, self.frame - 600) < frame <= self.frame
                or type(value) is not int or not 0 <= value <= 0xffffffff):
            return True
        self.hashes = {tick: row for tick, row in self.hashes.items() if tick >= self.frame - 600}
        row = self.hashes.setdefault(frame, {})
        row[slot] = value
        return len(set(row.values())) <= 1
