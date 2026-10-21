"""Server-owned OpenCMR2 sessions; clients retain their local car simulation."""
import struct
from .native import NativeRelay

BACKEND = 'cmr2-server-relay-v1'
CREATE, DESTROY, PLAYER_DATA, SESSION_DESC, HOST = 3, 5, 0x102, 0x104, 0x101


class CMR2Relay(NativeRelay):
    def __init__(self, players):
        super().__init__(players)
        if not 1 <= players <= 8:
            raise ValueError('Invalid CMR2 player count.')
        self.coordinator = 0
        self.description = None
        self.roster = {}
        self.departed = set()

    def state(self):
        return dict(created=self.description is not None, description=self.description,
                    coordinator=self.coordinator, playerCount=len(self.roster))

    def command(self, slot, command):
        if slot in self.departed or type(slot) is not int or not 0 <= slot < self.players:
            raise ValueError('Invalid CMR2 seat.')
        if not isinstance(command, dict) or set(command) - {'kind', 'name', 'payload', 'epoch'}:
            raise ValueError('Invalid CMR2 command.')
        kind, payload = command.get('kind'), command.get('payload')
        if type(kind) is not int or kind not in (1, 2, 3, 4) or not isinstance(payload, bytes):
            raise ValueError('Invalid CMR2 command.')
        if not self.allow(('commands', slot), 1, 30, 60):
            raise ValueError('CMR2 command limit exceeded.')
        recipients = [seat for seat in self.roster if seat != slot and seat not in self.departed]
        if kind in (1, 2):
            if slot != self.coordinator or len(payload) != 24:
                raise ValueError('Only the room coordinator can change race settings.')
            values = list(struct.unpack('<6I', payload))
            # The server owns admission and capacity regardless of native menu values.
            values[1] = self.players
            self.description = values
            return [(seat, dict(type=SESSION_DESC)) for seat in recipients]
        if self.description is None or len(payload) not in (0, 16):
            raise ValueError('Invalid CMR2 player description.')
        if kind == 3:
            if slot in self.roster:
                raise ValueError('CMR2 player already joined.')
            name = command.get('name')
            if not isinstance(name, str) or not 1 <= len(name.encode('utf-8')) <= 63 or '\x00' in name:
                raise ValueError('Invalid CMR2 player name.')
            entry = dict(type=CREATE, player=slot+1, name=name, payload=payload)
            result = [(slot, dict(other, type=CREATE)) for seat, other in self.roster.items() if seat not in self.departed]
            result += [(seat, entry) for seat in recipients]
            self.roster[slot] = entry
            return result
        if slot not in self.roster or len(payload) != 16:
            raise ValueError('CMR2 player has not joined.')
        self.roster[slot]['payload'] = payload
        return [(seat, dict(type=PLAYER_DATA, player=slot+1, payload=payload)) for seat in recipients]

    def packet(self, slot, message):
        if slot not in self.roster or slot in self.departed or not isinstance(message, dict):
            raise ValueError('CMR2 player has not joined.')
        source, destination, payload = message.get('from'), message.get('to'), message.get('payload')
        if (type(source) is not int or source != slot+1 or type(destination) is not int or
                not 0 <= destination <= self.players or type(message.get('reliable')) is not bool or
                not isinstance(payload, bytes) or not 1 <= len(payload) <= 65536):
            raise ValueError('Invalid CMR2 race message.')
        if not self.allow(('race-bytes', slot), len(payload), 128*1024, 256*1024) or not self.allow(('race-packets', slot), 1, 240, 480):
            raise ValueError('CMR2 race message limit exceeded.')
        return [(seat, dict(from_=source, to=seat+1, payload=payload, reliable=message['reliable']))
                for seat in self.roster if seat != slot and seat not in self.departed and destination in (0, seat+1)]

    def leave(self, slot):
        if slot in self.departed:
            return []
        self.departed.add(slot)
        entry = self.roster.pop(slot, dict(player=slot+1, name='Player', payload=b''))
        result = [(seat, dict(entry, type=DESTROY)) for seat in self.roster if seat not in self.departed]
        if slot == self.coordinator:
            # Only the settings controller changes; the server remains the session host.
            active = [seat for seat in range(self.players) if seat not in self.departed]
            if active:
                self.coordinator = min(active)
                result.append((self.coordinator, dict(type=HOST)))
        return result
