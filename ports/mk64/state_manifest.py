"""Candidate-only static simulation regions; never copy libc/GL/Asyncify state."""
import hashlib
import json
import re
from pathlib import Path


def write_manifest(link_map, output):
    regions = []
    for line in Path(link_map).read_text().splitlines():
        match = re.match(r'\s*([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S*/([^/]+\.o):\(\.(?:data|bss)\.([^)]*)\)', line)
        if not match:
            continue
        address, size, obj, symbol = match.groups()
        # Platform state belongs to this process, except its fixed game arena
        # and EEPROM. Renderer/audio output host resources must never migrate.
        game = obj.startswith(('src_', 'courses_')) and not obj.startswith('src_xbox360_xbox360_gfx')
        platform = obj == 'web_web_platform.c.o' and symbol in ('x360_game_heap', 'eeprom', 'osAppNmiBuffer')
        # GPU readback and depth pixels belong to each renderer, not the simulation.
        presentation = symbol in ('gFramebuffers', 'gZBuffer')
        if (game or platform) and not presentation and int(size, 16):
            regions.append(dict(address=int(address,16), size=int(size,16), symbol=symbol, object=obj))
    if not regions or not any(r['symbol'] == 'gPlayers' for r in regions):
        raise ValueError('Missing simulation regions in link map')
    regions.sort(key=lambda r:r['address'])
    for left, right in zip(regions, regions[1:]):
        assert left['address'] + left['size'] <= right['address']
    wasm_hash = hashlib.sha256((output / 'mk64.wasm').read_bytes()).hexdigest()
    (output / 'state-manifest.json').write_text(json.dumps(dict(schema=1, wasm=wasm_hash, regions=regions), indent=2)+'\n')
    print(f'Candidate snapshot: {len(regions)} regions, {sum(r["size"] for r in regions)} bytes')
