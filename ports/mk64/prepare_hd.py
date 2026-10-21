"""Convert the pinned MK64 Reloaded pack into content-matched browser textures.

Original decoded texels identify replacements; game memory and texture UVs keep
their native dimensions. Generated assets and ROM-derived data stay out of source.
"""
import argparse
import ctypes
from collections import Counter
import hashlib
import importlib.util
from io import BytesIO
import json
import math
from pathlib import Path
import re
import subprocess
import zlib
from zipfile import ZipFile

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / '.tmp/mk64/MKart360/mk64-master'
FORMATS = {'rgba16': 16, 'rgba32': 32, 'ci8': 8, 'ci4': 4,
           'ia16': 16, 'ia8': 8, 'ia4': 4, 'i8': 8, 'i4': 4}


def texture_key(rgba, width, height):
    return f'{width}x{height}:{zlib.crc32(rgba):08x}:{zlib.adler32(rgba):08x}'


def decode(data, kind, palette=b''):
    kind = kind.lower()
    if kind == 'rgba32':
        return data
    if kind == 'rgba16':
        return b''.join(bytes(((v >> 11) * 255 // 31, ((v >> 6) & 31) * 255 // 31,
                              ((v >> 1) & 31) * 255 // 31, (v & 1) * 255))
                        for v in (int.from_bytes(data[i:i + 2], 'big') for i in range(0, len(data), 2)))
    if kind.startswith('ci'):
        colors = decode(palette, 'rgba16')
        table = [colors[i:i + 4] for i in range(0, len(colors), 4)]
        indices = data if kind == 'ci8' else [n for v in data for n in (v >> 4, v & 15)]
        if not table or max(indices, default=0) >= len(table):
            raise ValueError('Texture refers to an unavailable palette entry')
        return b''.join(table[v] for v in indices)
    if kind == 'ia16':
        return b''.join(bytes((data[i], data[i], data[i], data[i + 1])) for i in range(0, len(data), 2))
    values = data if kind in ('ia8', 'i8') else [n for v in data for n in (v >> 4, v & 15)]
    if kind == 'ia8':
        return b''.join(bytes((v >> 4,) * 3 + (v & 15,)) for v in values).translate(
            bytes(v * 17 if v < 16 else v for v in range(256)))
    if kind == 'ia4':
        return b''.join(bytes(((v >> 1) * 36,) * 3 + ((v & 1) * 255,)) for v in values)
    if kind == 'i4':
        return b''.join(bytes((v * 17,) * 4) for v in values)
    if kind == 'i8':
        return b''.join(bytes((v,) * 4) for v in values)
    raise ValueError('Unsupported texture format: ' + kind)


def yaml_metadata():
    records = {}
    for path in sorted((SOURCE / 'yamls').rglob('*.yml')):
        for block in re.split(r'(?m)^(?=[A-Za-z_]\w*:)', path.read_text()):
            name = re.match(r'(\w+):', block)
            if not name:
                continue
            fields = dict(re.findall(r'^  (\w+):\s*([^\n#]+)', block, re.M))
            if fields.get('type', '').strip() == 'texture':
                records[name[1]] = {k: v.strip() for k, v in fields.items()}
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pack', type=Path, required=True)
    parser.add_argument('--rom', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--extend', action='store_true', help='Add newly mapped assets to an existing generated manifest')
    parser.add_argument('--retile', action='store_true', help='Extend bounded strips for existing non-kart atlases')
    args = parser.parse_args()
    pins = json.loads((ROOT / 'ports/mk64/sources.json').read_text())
    rom = args.rom.read_bytes()
    if hashlib.sha1(rom).hexdigest() != '579c48e211ae952530ffc8738709f078d5dd215e':
        raise SystemExit('The original US ROM is required to match texture identities.')
    pack_digest = hashlib.sha256(args.pack.read_bytes()).hexdigest()
    if pack_digest != pins['MK64Reloaded']['sha256']:
        raise SystemExit('HD pack does not match the pinned release SHA-256.')
    spec = importlib.util.spec_from_file_location('asset_prepare', SOURCE / 'PUBLIC_PREPARE_MK64_ASSETS.py')
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)
    cache = {}
    decoder = None
    def raw(meta):
        offset = int(str(meta['rom_offset']), 0)
        block = int(str(meta.get('block_offset', 0)), 0)
        if rom[offset:offset + 6] == b'TKMK00':
            key = (offset, meta.get('alpha_color', 1))
            if key not in cache:
                width, height = int.from_bytes(rom[offset + 8:offset + 10], 'big'), int.from_bytes(rom[offset + 10:offset + 12], 'big')
                source = ctypes.create_string_buffer(rom[offset:])
                temporary = ctypes.create_string_buffer(width * height)
                result = ctypes.create_string_buffer(width * height * 2)
                decoder.tkmk00decode(source, temporary, result, key[1])
                cache[key] = result.raw
            return cache[key][block:]
        return upstream.source_bytes(rom, offset, cache)[block:]

    recipes = json.loads((SOURCE / 'PUBLIC_ASSET_RECIPES.json').read_text())
    by_name = {Path(r['path']).name.split('.')[0]: r for r in recipes}
    yaml = yaml_metadata()
    metadata = {}
    for path in sorted((SOURCE / 'assets').rglob('*.json')):
        scoped = json.loads(path.read_text())
        for name, meta in scoped.items():
            if isinstance(meta, dict) and 'rom_offset' in meta and meta.get('type') in FORMATS:
                metadata[name] = (meta, scoped)
    for name, recipe in by_name.items():
        if name in metadata:
            continue
        meta = {**recipe, **yaml.get(name, {})}
        kind = re.search(r'\.(rgba16|rgba32|ci8|ci4|ia16|ia8|ia4|i8|i4)\.', recipe['path'])
        meta['type'] = meta.get('format', kind[1] if kind else '').lower()
        if meta['type'] in FORMATS:
            metadata[name] = (meta, {})

    initial_metadata_names = set(metadata)
    # Menu banks include MIO0 and TKMK00 compressed resources absent from the
    # extracted-asset recipes. Their ROM identity and native menu dimensions
    # come from the same pinned bank map and MenuTexture tables as the game.
    banks = json.loads((SOURCE / 'PUBLIC_GENERATED_BANK_MAP.json').read_text())
    menu = {}
    for kind, symbol, width, height in re.findall(r'\{\s*(\d+),\s*(\w+),\s*(\d+),\s*(\d+),', (SOURCE / 'src/data/textures.c').read_text()):
        menu[symbol] = (int(width), int(height), int(kind))
    for bank in banks:
        if bank['bank'] not in ('texture_tkmk00.c', 'texture_data_2.c', 'course_player_selection.c', 'other_textures.c'):
            continue
        name = bank['symbol']
        if name in metadata:
            continue
        meta = {**bank, 'type': 'rgba16'}
        if name in menu:
            meta['width'], meta['height'], menu_kind = menu[name]
            meta['alpha_color'] = 0xBE if menu_kind == 1 else 1
        offset = bank['rom_offset']
        if rom[offset:offset + 6] == b'TKMK00':
            meta['width'] = int.from_bytes(rom[offset + 8:offset + 10], 'big')
            meta['height'] = int.from_bytes(rom[offset + 10:offset + 12], 'big')
        elif rom[offset:offset + 4] == b'MIO0':
            meta['size'] = int.from_bytes(rom[offset + 4:offset + 8], 'big')
        metadata[name] = (meta, {})

    # The race/title logo is a decoded RGBA32 atlas (render_objects.c), unlike
    # the RGBA16 menu banks. Preserve its true256x128 identity and strip sizes.
    if 'logo_mario_kart_64' in metadata:
        metadata['logo_mario_kart_64'][0].update(type='rgba32', width=256, height=128)

    work = ROOT / '.tmp/mk64/hd-tools'
    work.mkdir(parents=True, exist_ok=True)
    native_source = work / 'tkmk_decode.c'
    native_source.write_text((SOURCE / 'src/xbox360/xbox360_tkmk00.cpp').read_text().replace('extern "C" ', ''))
    library = work / 'tkmk_decode.so'
    subprocess.run([str(ROOT / '.tmp/mk64/emsdk/upstream/bin/clang'), '-x', 'c', '-std=c11', '-O2', '-fPIC',
                    '-shared', '-nostdlib', str(native_source), '-lc', '-o', str(library)], check=True)
    decoder = ctypes.CDLL(str(library))
    decoder.tkmk00decode.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int32]
    def normalized(name):
        name = re.sub(r'^(gTexture|common_texture_|texture_)', '', name)
        return re.sub(r'[^a-z0-9]', '', name.lower())
    aliases = {}
    for name in metadata:
        aliases.setdefault(normalized(name), []).append(name)
    explicit = {'logo_mario_kart_64': 'gTextureMarioKart64Logo',
                'startup_reflection_map_gold': 'reflection_map_gold'}

    output = args.output_dir
    (output / 'textures').mkdir(parents=True, exist_ok=True)
    manifest = {'schema': 1, 'assetId': 'reloaded-2026.04.03-' + pack_digest[:12],
                'pack': 'MK64 Reloaded', 'release': pins['MK64Reloaded']['release'],
                'source': pins['MK64Reloaded']['url'], 'packSha256': pack_digest, 'textures': {}}
    if args.extend:
        manifest = json.loads((output / 'manifest.json').read_text())
    previous_paths = {entry[2] for entry in manifest['textures'].values()}
    statistics = Counter()
    newly_mapped = 0
    z = ZipFile(args.pack)
    names = {Path(n).stem: n for n in z.namelist() if n.endswith('.png')}
    source_hashes = {}
    encoded_cache = {}
    def register(original, hd, name, source_path):
        w, h = original.size
        pixels = original.tobytes()
        if all(lo == hi for lo, hi in original.getextrema()):
            statistics['uniform_skipped'] += 1
            return
        key = texture_key(pixels, w, h)
        original_hash = hashlib.sha256(pixels).hexdigest()
        if key in source_hashes:
            if source_hashes[key] != original_hash:
                raise ValueError('Texture checksum collision: ' + key)
            statistics['duplicate_original'] += 1
            return
        if key in manifest['textures']:
            statistics['duplicate_original'] += 1
            return
        source_hashes[key] = original_hash
        encoded = BytesIO()
        hd.save(encoded, format='WEBP', quality=92, method=4, exact=True)
        data = encoded.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        filename = 'textures/' + digest[:32] + '.webp'
        if digest not in encoded_cache:
            (output / filename).write_bytes(data)
            encoded_cache[digest] = True
            statistics['bytes'] += len(data)
        manifest['textures'][key] = [filename, name, source_path, hd.width, hd.height]
        statistics['entries'] += 1

    for image_name, source_path in sorted(names.items()):
        wheel = re.match(r'(.+_kart_frame\d+)_wheel([0-3])$', image_name)
        name = wheel[1] if wheel else image_name
        if args.extend and (source_path in previous_paths or name in initial_metadata_names) and not (args.retile and not wheel):
            continue
        if name not in metadata:
            alias = explicit.get(name)
            candidates = aliases.get(normalized(name), [])
            name = alias if alias in metadata else candidates[0] if len(candidates) == 1 else name
        if name not in metadata and re.fullmatch(r'[0-9A-Fa-f]{6}', name):
            name = 'gTexture' + name
        if name not in metadata:
            statistics['unmapped_png'] += 1
            continue
        meta, scoped = metadata[name]
        kind = meta['type']
        hd = Image.open(BytesIO(z.read(source_path))).convert('RGBA')
        data = raw(meta)
        if 'width' in meta and 'height' in meta:
            w, h = int(str(meta['width']), 0), int(str(meta['height']), 0)
        else:
            count = int(meta['size']) * 8 // FORMATS[kind]
            ratio = math.sqrt(hd.width * hd.height / count)
            scale = round(ratio)
            if not scale or abs(ratio - scale) > .0001 or hd.width % scale or hd.height % scale:
                statistics['unknown_dimensions'] += 1
                continue
            w, h = hd.width // scale, hd.height // scale
        data = data[:w * h * FORMATS[kind] // 8]
        palette = b''
        palette_name = meta.get('tlut', meta.get('tlut_symbol'))
        if isinstance(palette_name, list):
            base, wheel_name = palette_name
            if wheel:
                wheel_name = re.sub(r'_wheel_\d$', '_wheel_' + wheel[2], wheel_name)
            palette = raw(scoped[base])[:384] + raw(scoped[wheel_name])[:128]
        elif palette_name:
            palette_meta = scoped.get(palette_name, metadata.get(palette_name, (None,))[0])
            if palette_meta:
                palette = raw(palette_meta)[:512]
        try:
            decoded = decode(data, kind, palette)
            original = Image.frombytes('RGBA', (w, h), decoded)
        except (ValueError, IndexError):
            statistics['decode_unavailable'] += 1
            continue
        register(original, hd, image_name, source_path)
        # Native kart billboards upload separate upper/lower halves. Other
        # large sprites and tile atlases also load bounded strips from RAM.
        tile_sizes = {(w, min(h, limit * 8 // FORMATS[kind] // w)) for limit in (4096,8192)}
        if wheel:
            tile_sizes = {(64, 32)}
        else:
            for tw, th in ((32, 32), (64, 32), (32, 64), (16, 16), (8, 16)):
                if w % tw == 0 and h % th == 0 and (tw == w or th == h):
                    tile_sizes.add((tw, th))
        for tw, th in sorted(tile_sizes):
            if tw <= 0 or th <= 0 or (tw == w and th == h) or w % tw:
                continue
            # Native kart halves overlap one row: lower begins at byte0x7C0,
            # not0x800. Match those exact decoded texels before replacing them.
            starts_y = (0, 31) if wheel else range(0, h, th)
            for y in starts_y:
                for x in range(0, w, tw):
                    end_y = min(h, y + th)
                    box = (x, y, x + tw, end_y)
                    scaled = (x * hd.width // w, y * hd.height // h,
                              (x + tw) * hd.width // w, end_y * hd.height // h)
                    register(original.crop(box), hd.crop(scaled), image_name, source_path)
        statistics['mapped_png'] += 1
        if source_path not in previous_paths and image_name not in initial_metadata_names:
            newly_mapped += 1
        if statistics['mapped_png'] % 500 == 0:
            print('Prepared', statistics['mapped_png'], 'HD images;', statistics['entries'], 'lookup entries', flush=True)
    manifest['textures'] = dict(sorted(manifest['textures'].items()))
    if args.extend:
        original_statistics = manifest['statistics']
        original_statistics['mapped_png'] += newly_mapped if args.retile else statistics['mapped_png']
        if args.retile:
            original_statistics['retiled_png'] = statistics['mapped_png']
        original_statistics['bytes'] += statistics['bytes']
        original_statistics['entries'] = len(manifest['textures'])
        original_statistics['unmapped_png'] = statistics['unmapped_png']
    else:
        manifest['statistics'] = dict(statistics)
    (output / 'manifest.json').write_text(json.dumps(manifest, separators=(',', ':'), sort_keys=True) + '\n')
    (output / 'credits.txt').write_bytes(z.read('mk64-reloaded-v2026.04.03.txt'))
    print(json.dumps({'assetId': manifest['assetId'], **statistics}, indent=2))


if __name__ == '__main__':
    main()
