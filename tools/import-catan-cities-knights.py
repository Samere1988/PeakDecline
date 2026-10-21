"""Import Colonist Cities & Knights artwork from its public asset CDN.

Run from the repository root. Source bundles are cached under .tmp/catan-ck.
The project owner has confirmed permission to use Colonist art.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from hashlib import sha256
from pathlib import Path
import json
import re
import sys
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / '.tmp' / 'catan-ck'
TARGET = ROOT / 'static' / 'assets' / 'catan' / 'colonist' / 'cities-knights'
CDN = 'https://cdn.colonist.io/dist/assets/'
SOURCES = {
    'gameBundle': 'https://cdn.colonist.io/dist/js/shared.124dde6991b0f7b9af54.js',
    'rulesPage': 'https://colonist.io/catan-rules/cities-and-knights',
    'spriteAtlasIndex': 'https://cdn.colonist.io/dist/assets/game_spritesheet_0.eed8dd9beaec437fcf0c.json',
    'spriteAtlasImage': 'https://cdn.colonist.io/dist/assets/game_spritesheet_0.094536749cb2bc828533.webp',
}
FILE_PATTERN = re.compile(r'([A-Za-z][A-Za-z0-9_-]+)\.([a-f0-9]{20})\.(svg|png|webp)')
RULE_URL_PATTERN = re.compile(r'https://cdn\.colonist\.io/dist/assets/([A-Za-z][A-Za-z0-9_-]+\.[a-f0-9]{20}\.(?:svg|png|webp))')
ATLAS_FRAMES = ('knight_active_level1', 'knight_move_white')


def source_bytes(key, cache_name):
    cache = SOURCE_DIR / cache_name
    if cache.exists():
        return cache.read_bytes()
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    request = Request(SOURCES[key], headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://colonist.io/'})
    with urlopen(request, timeout=60) as response:
        data = response.read()
    cache.write_bytes(data)
    return data


def category(name):
    if name in ('card_paper', 'card_cloth', 'card_coin'):
        return 'commodities'
    if name.startswith('card_progress_'):
        return 'progress-cards'
    if name.startswith(('dice_red_', 'dice_event_')):
        return 'dice'
    if name.startswith('knight_level'):
        return 'knights'
    if name.startswith('city_wall_'):
        return 'city-walls'
    if name.startswith('icon_merchant_'):
        return 'merchant'
    if name.startswith('metropolis_') or name == 'stat_metropolis':
        return 'metropolises'
    if name in ('icon_barbarian_ship', 'barbarian_tracker_hex_attack', 'ck_barbarian_tracker_example', 'icon_swords', 'icon_defender'):
        return 'barbarians'
    if name in ('icon_aqueduct', 'icon_fortress', 'icon_tradehouse', 'icon_helmet', 'icon_square_framed_politics', 'icon_square_framed_science', 'icon_square_framed_trade', 'pageck_city_improvement_tracker', 'pageck_how_to_get_progress_cards', 'pageck_placing_knights'):
        return 'reference'
    if name in ('icon_book', 'icon_info', 'icon_settings', 'icon_fullscreen_expand', 'icon_fullscreen_contract', 'icon_player', 'icon_send', 'icon_longest_road', 'city_white', 'road_white', 'settlement_white') or name in ('player_bg_red', 'player_bg_blue', 'player_bg_orange', 'player_bg_green'):
        return 'interface'
    if name in ('cities_and_knights', 'cities_and_knights_56player'):
        return 'emblem'
    return None


def validate_svg(data, name):
    root = ElementTree.fromstring(data)
    if root.tag.split('}')[-1] != 'svg':
        raise ValueError(f'{name} is not an SVG')
    for element in root.iter():
        if element.tag.split('}')[-1] in ('script', 'foreignObject'):
            raise ValueError(f'{name} contains executable content')
        for key, value in element.attrib.items():
            attribute = key.split('}')[-1].lower()
            if attribute.startswith('on') or attribute in ('href', 'src') and value.lstrip().lower().startswith(('http:', 'https:', 'javascript:')):
                raise ValueError(f'{name} contains an external or executable reference')
    return root.attrib.get('viewBox', '')


def fetch(item):
    filename, source, group = item
    request = Request(source, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://colonist.io/'})
    try:
        with urlopen(request, timeout=30) as response:
            data = response.read()
    except Exception as error:
        raise RuntimeError(f'Could not download {source}') from error
    if len(data) > 5_000_000:
        raise ValueError(f'{filename} is unexpectedly large')
    if filename.endswith('.svg'):
        view_box = validate_svg(data, filename)
    elif filename.endswith('.png') and data.startswith(b'\x89PNG\r\n\x1a\n'):
        view_box = None
    elif filename.endswith('.webp') and data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        view_box = None
    else:
        raise ValueError(f'{filename} has an unexpected image format')
    return filename, data, {
        'file': filename,
        'source': source,
        'sha256': sha256(data).hexdigest(),
        'bytes': len(data),
        'category': group,
        **({'viewBox': view_box} if view_box is not None else {}),
    }


def extract_atlas():
    from io import BytesIO

    index = json.loads(source_bytes('spriteAtlasIndex', 'game_spritesheet_0.json'))
    image = Image.open(BytesIO(source_bytes('spriteAtlasImage', 'game_spritesheet_0.webp'))).convert('RGBA')
    declared_size = tuple(index['meta']['size'][axis] for axis in ('w', 'h'))
    if any(actual - declared not in (0, 1) for actual, declared in zip(image.size, declared_size)):
        raise ValueError('Sprite atlas dimensions do not match its index')
    entries = []
    for name in ATLAS_FRAMES:
        sprite = index['frames'][name]
        if sprite['rotated']:
            raise ValueError(f'Unsupported rotated sprite: {name}')
        frame = sprite['frame']
        source = sprite['spriteSourceSize']
        size = sprite['sourceSize']
        crop = image.crop((frame['x'], frame['y'], frame['x'] + frame['w'], frame['y'] + frame['h']))
        canvas = Image.new('RGBA', (size['w'], size['h']))
        canvas.paste(crop, (source['x'], source['y']))
        filename = f'{name}.png'
        from io import BytesIO as Buffer
        output = Buffer()
        canvas.save(output, format='PNG')
        data = output.getvalue()
        (TARGET / filename).write_bytes(data)
        entries.append({
            'file': filename,
            'source': SOURCES['spriteAtlasImage'],
            'sha256': sha256(data).hexdigest(),
            'bytes': len(data),
            'category': 'knights',
            'atlasFrame': name,
            'frame': frame,
            'sourceSize': size,
            'spriteSourceSize': source,
        })
    return entries


def extract_tracker_step():
    """Restore an ordinary track hex from Colonist's tracker reference image."""
    from io import BytesIO

    source = TARGET / 'ck_barbarian_tracker_example.png'
    image = Image.open(source).convert('RGBA').crop((11, 6, 89, 97))
    # The example ship overlaps the lower-right tip; restore it from the
    # unobscured, symmetrical lower-left half of the same Colonist hex.
    for y in range(70, image.height):
        for x in range(39, image.width):
            image.putpixel((x, y), image.getpixel((78 - x, y)))
    scale = 4
    mask = Image.new('L', (image.width * scale, image.height * scale))
    points = [(39, 2), (76, 23), (76, 66), (39, 89), (2, 66), (2, 23)]
    ImageDraw.Draw(mask).polygon([(x * scale, y * scale) for x, y in points], fill=255)
    image.putalpha(mask.resize(image.size, Image.Resampling.LANCZOS))
    buffer = BytesIO()
    image.save(buffer, format='PNG')
    data = buffer.getvalue()
    filename = 'barbarian_tracker_hex_step.png'
    (TARGET / filename).write_bytes(data)
    origin = CDN + 'ck_barbarian_tracker_example.c527478dfd470fd53fa7.png'
    return {'file': filename, 'source': origin, 'sha256': sha256(data).hexdigest(), 'bytes': len(data), 'category': 'barbarians', 'derivedFrom': source.name, 'crop': [11, 6, 89, 97]}


def import_ui_only():
    selected = [
        ('icon_book.svg', CDN + 'icon_book.74e42a5caf5ecc35edc2.svg', 'interface'),
        ('icon_info.svg', CDN + 'icon_info.0f1a765945c77be429ac.svg', 'interface'),
        ('city_white.svg', CDN + 'city_white.cca576079023a2bdc80f.svg', 'interface'),
        ('road_white.svg', CDN + 'road_white.78e66baab120779d5c30.svg', 'interface'),
        ('settlement_white.svg', CDN + 'settlement_white.a642a431b4bb73d63dae.svg', 'interface'),
        ('icon_settings.svg', CDN + 'icon_settings.79564d9f7bfde870611f.svg', 'interface'),
        ('icon_fullscreen_expand.svg', CDN + 'icon_fullscreen_expand.8142bdc24178fb978f67.svg', 'interface'),
        ('icon_fullscreen_contract.svg', CDN + 'icon_fullscreen_contract.7af56c892561691f8505.svg', 'interface'),
        ('icon_player.svg', CDN + 'icon_player.823fcffb830b912c3bc5.svg', 'interface'),
        ('icon_send.svg', CDN + 'icon_send.0395fe5de05351959b13.svg', 'interface'),
        ('icon_longest_road.svg', CDN + 'icon_longest_road.5cfdeb3352b20463e64b.svg', 'interface'),
        ('player_bg_red.svg', CDN + 'player_bg_red.e23255a1eaac03a05c9d.svg', 'interface'),
        ('player_bg_blue.svg', CDN + 'player_bg_blue.ccf3b0e2738233b4e592.svg', 'interface'),
        ('player_bg_orange.svg', CDN + 'player_bg_orange.501a7e983f1b0c42c2b0.svg', 'interface'),
        ('player_bg_green.svg', CDN + 'player_bg_green.3caf586360d8a53b7520.svg', 'interface'),
    ]
    imported = [fetch(item) for item in selected]
    for filename, data, _ in imported:
        (TARGET / filename).write_bytes(data)
    manifest_path = TARGET / 'sources.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    new_entries = [item[2] for item in imported] + [extract_tracker_step()]
    names = {item['file'] for item in new_entries}
    manifest['assets'] = sorted([item for item in manifest['assets'] if item['file'] not in names] + new_entries, key=lambda item: item['file'])
    manifest['retrieved'] = date.today().isoformat()
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print('Imported ' + ', '.join(sorted(names)))


def main():
    bundle = source_bytes('gameBundle', 'shared.js').decode('utf-8')
    rules = source_bytes('rulesPage', 'rules.html').decode('utf-8')
    found = {match.group(0) for match in FILE_PATTERN.finditer(bundle)}
    found.update(RULE_URL_PATTERN.findall(rules))
    selected = {}
    for original in sorted(found):
        match = FILE_PATTERN.fullmatch(original)
        name, extension = match.group(1), match.group(3)
        group = category(name)
        if group is None:
            continue
        filename = f'{name}.{extension}'
        if filename in selected and selected[filename][1] != CDN + original:
            raise ValueError(f'Conflicting source versions for {filename}')
        selected[filename] = (filename, CDN + original, group)
    TARGET.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        downloaded = list(pool.map(fetch, selected.values()))
    for filename, data, _ in downloaded:
        (TARGET / filename).write_bytes(data)
    atlas_entries = extract_atlas()
    manifest = {
        'retrieved': date.today().isoformat(),
        'sources': SOURCES,
        'assets': sorted([item[2] for item in downloaded] + atlas_entries, key=lambda entry: entry['file']),
    }
    (TARGET / 'sources.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    manifest['assets'].append(extract_tracker_step())
    manifest['assets'].sort(key=lambda entry: entry['file'])
    (TARGET / 'sources.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    counts = {}
    for item in manifest['assets']:
        counts[item['category']] = counts.get(item['category'], 0) + 1
    print(f"Imported {len(manifest['assets'])} Cities & Knights assets: {counts}")


if __name__ == '__main__':
    import_ui_only() if '--ui-only' in sys.argv else main()
