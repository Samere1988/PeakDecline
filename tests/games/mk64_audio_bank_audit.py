"""Audit the US ROM's raw audio-bank layout used by the browser conversion."""
from pathlib import Path

ROM = Path(__file__).resolve().parents[2] / 'static/roms/N64/Mario Kart 64 (U) [!].z64'
data = ROM.read_bytes()

def u32(blob, at):
    return int.from_bytes(blob[at:at + 4], 'big')

header = data[0x966260:]
count = int.from_bytes(header[2:4], 'big')
assert count == 21
for bank_id in range(count):
    offset, length = u32(header, 4 + bank_id * 8), u32(header, 8 + bank_id * 8)
    raw = header[offset:offset + length]
    instruments, drums = u32(raw, 0), u32(raw, 4)
    bank = raw[16:]
    drum_table = u32(bank, 0)
    samples = set()
    books = set()
    loops = set()
    envelopes = set()
    bad = []

    def sound(at):
        sample_at = u32(bank, at)
        if sample_at == 0:
            return
        if sample_at + 20 > len(bank):
            bad.append(('sample', sample_at))
            return
        samples.add(sample_at)
        loop_at, book_at = u32(bank, sample_at + 8), u32(bank, sample_at + 12)
        if loop_at:
            loops.add(loop_at)
        if book_at:
            books.add(book_at)

    for index in range(instruments):
        at = u32(bank, 4 + index * 4)
        if not at:
            continue
        if at + 32 > len(bank):
            bad.append(('instrument', at))
            continue
        envelopes.add(u32(bank, at + 4))
        for base in (8, 16, 24):
            sound(at + base)
    if drum_table:
        for index in range(drums):
            at = u32(bank, drum_table + index * 4)
            if not at:
                continue
            if at + 16 > len(bank):
                bad.append(('drum', at))
                continue
            sound(at + 4)
            envelopes.add(u32(bank, at + 12))
    for at in books:
        if at + 8 > len(bank):
            bad.append(('book', at))
            continue
        order, predictors = u32(bank, at), u32(bank, at + 4)
        if order > 8 or predictors > 16 or at + 8 + 16 * order * predictors > len(bank):
            bad.append(('book dimensions', at, order, predictors))
    assert not bad, (bank_id, bad)
    assert samples and books and envelopes, bank_id
print(f'PASS {count} audio banks and their referenced samples/books/envelopes')
