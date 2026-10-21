"""Bounded DevilutionX packet relay; authenticated room seats own player IDs.

Packet layout follows the pinned upstream dvlnet/packet.h. TLS and the existing
session cookie secure the browser transport, so native packet encryption is off.
Spectators receive presentation only and never enter the four-player protocol.
"""
from time import monotonic

BACKEND = 'devilution-native-v1'


class NativeRelay:
    def __init__(self, players):
        self.players = players
        self.joined = set()
        self.pending = {}
        self.info = None
        self.rates = {}

    def allow(self, key, amount, per_second, burst):
        now = monotonic()
        remaining, at = self.rates.get(key, (burst, now))
        remaining = min(burst, remaining + (now - at) * per_second)
        if amount > remaining:
            return False
        self.rates[key] = remaining - amount, now
        return True

    def receive(self, slot, packet):
        """Return (recipient seat, native packet) pairs, or raise ValueError."""
        if (type(slot) is not int or not 0 <= slot < self.players or
                not isinstance(packet, bytes) or not 3 <= len(packet) <= 65536):
            raise ValueError('Invalid Diablo packet.')
        if not self.allow(('packet', slot), len(packet), 256 * 1024, 512 * 1024):
            raise ValueError('Diablo packet limit exceeded.')
        kind, source, destination = packet[:3]
        if kind == 0x11:
            if source != 255 or destination != 254 or not 7 <= len(packet) <= 135 or slot in self.joined:
                raise ValueError('Invalid Diablo join.')
            if slot == 0:
                info = packet[7:]
                if len(info) != 40 or int.from_bytes(info[:4], 'little') != 40 or info[4] != 0:
                    raise ValueError('Full Diablo game data required.')
                self.info = info
            self.pending[slot] = packet[3:7]
            if self.info is None:
                return []
            result = []
            for newcomer, cookie in sorted(self.pending.items()):
                for other in sorted(self.joined):
                    result.append((other, bytes([0x13, 254, 255, newcomer])))
                    result.append((newcomer, bytes([0x13, 254, 255, other])))
                result.append((newcomer, bytes([0x12, 254, 255]) + cookie + bytes([newcomer]) + self.info))
                self.joined.add(newcomer)
            self.pending.clear()
            return result
        if slot not in self.joined or source != slot:
            raise ValueError('Diablo sender does not own this seat.')
        lengths = {0x02: 8, 0x31: 7, 0x32: 7, 0x14: 8}
        if kind not in (0x01, *lengths) or kind in lengths and len(packet) != lengths[kind]:
            raise ValueError('Invalid Diablo packet type or length.')
        if kind == 0x14:
            if packet[3] != slot:
                raise ValueError('A player cannot drop another player.')
            raise ValueError('A player left Diablo. Return to lobbies to start another game.')
        if destination != 255 and destination not in range(4):
            raise ValueError('Invalid Diablo destination.')
        return [(other, packet) for other in sorted(self.joined)
                if other != slot and destination in (255, other)]
