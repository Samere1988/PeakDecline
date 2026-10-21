"""Compact, bounded, process-local N64 input journal for native replay recovery."""
import struct
import tempfile

PAD = struct.Struct('<Hbb')
MAX_FRAMES = 24 * 60 * 60 * 60
CHUNK = 600


class PartyHistory:
    def __init__(self, players):
        self.players = players
        self.frame = 0
        self.file = tempfile.TemporaryFile()

    def append(self, frame, pads):
        if frame != self.frame + 1 or frame > MAX_FRAMES or len(pads) != self.players:
            raise ValueError('Mario Party input history limit or sequence error.')
        self.file.seek(self.frame * self.players * PAD.size)
        self.file.write(b''.join(PAD.pack(p['buttons'], p['x'], p['y']) for p in pads))
        self.frame = frame

    def packet(self, start, epoch):
        if type(start) is not int or not 1 <= start <= self.frame + 1:
            return None
        count = min(CHUNK, self.frame - start + 1)
        self.file.seek((start - 1) * self.players * PAD.size)
        raw = self.file.read(count * self.players * PAD.size)
        if len(raw) != count * self.players * PAD.size:
            raise ValueError('Mario Party input history is incomplete.')
        pads = [dict(buttons=b, x=x, y=y) for b, x, y in PAD.iter_unpack(raw)]
        return dict(epoch=epoch, start=start, through=self.frame, frames=[
            dict(epoch=epoch, frame=start+i, pads=pads[i*self.players:(i+1)*self.players])
            for i in range(count)])

    def close(self):
        self.file.close()
