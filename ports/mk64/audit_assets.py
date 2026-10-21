"""Read-only audit of every pinned asset recipe, bank object and local include."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / '.tmp/mk64/MKart360/mk64-master'
BUILD = ROOT / '.tmp/mk64/build'


def audit_hd(directory):
    """Verify every referenced replacement, not only files hit in a test race."""
    from PIL import Image

    directory = directory.resolve(strict=True)
    manifest = json.loads((directory / 'manifest.json').read_text())
    decoded = {}
    pot_mismatches = 0
    for key, entry in manifest['textures'].items():
        match = re.fullmatch(r'([1-9][0-9]*)x([1-9][0-9]*):[0-9a-f]{8}:[0-9a-f]{8}', key)
        assert match, key
        filename = entry[0]
        assert re.fullmatch(r'textures/[0-9a-f]{32}\.webp', filename), filename
        path = directory / filename
        if filename not in decoded:
            assert hashlib.sha256(path.read_bytes()).hexdigest()[:32] == path.stem, path
            with Image.open(path) as image:
                image.load()
                decoded[filename] = image.size
        assert decoded[filename] == tuple(entry[3:5]), (key, entry)
        original = tuple(map(int, match.groups()))
        is_pot = lambda size: all(value > 0 and not value & (value - 1) for value in size)
        pot_mismatches += is_pot(original) and not is_pot(decoded[filename])
    return dict(mappings_verified=len(manifest['textures']), files_verified=len(decoded),
                missing_or_corrupt_assets=0, pot_to_npot_replacements=pot_mismatches)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hd-dir", type=Path, help="Also verify the prepared HD manifest and all referenced files")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('upstream_assets', SOURCE / 'PUBLIC_PREPARE_MK64_ASSETS.py')
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)
    recipes = json.loads((SOURCE / 'PUBLIC_ASSET_RECIPES.json').read_text())
    banks = json.loads((SOURCE / 'PUBLIC_GENERATED_BANK_MAP.json').read_text())
    gold = json.loads((SOURCE / 'PUBLIC_SOURCE_GOLD_HASHES.json').read_text())
    upstream.verify_gold_source(SOURCE, gold)
    assert (SOURCE.parent / 'MK64/MK64.vcxproj').is_file()
    upstream.verify_project(SOURCE)
    overlays = 0
    for recipe in recipes:
        path = SOURCE / recipe['path']
        data = upstream.payload_from_text(path.read_text(), recipe['representation'])
        assert len(data) == recipe['size'], path
        assert hashlib.sha256(data).hexdigest() == recipe['sha256'], path
        if recipe['representation'] == 'u16be':
            overlay = BUILD / 'include' / recipe['path']
            values = re.findall(r'0x[0-9a-fA-F]+', overlay.read_text())
            data = b''.join(int(value, 16).to_bytes(2, 'little') for value in values)
            assert hashlib.sha256(data).hexdigest() == recipe['sha256'], overlay
            overlays += 1
    bank_files = {}
    for record in banks:
        name = record['bank']
        if name not in bank_files:
            text = (SOURCE / 'src/xbox360/generated_banks' / name).read_text()
            bank_files[name] = dict(re.findall(r'unsigned char (\w+)\[\] = \{(.*?)\};', text, re.S))
        data = upstream.payload_from_text(bank_files[name][record['symbol']], 'u8')
        assert len(data) == record['size'], record['symbol']
        assert hashlib.sha256(data).hexdigest() == record['sha256'], record['symbol']
    report = {
        'media_fragments_verified': len(recipes),
        'bank_objects_verified': len(banks),
        'bank_files_verified': len(bank_files),
        'wasm_texture_overlays_verified': overlays,
        'pinned_source_files_verified': len(gold),
        'project_sources_and_recursive_local_includes': 'passed',
        'missing_or_corrupt_assets': 0,
        'scope': 'All assets in the pinned upstream manifests; file integrity does not prove rendering in every course.',
    }
    if args.hd_dir:
        report['hd'] = audit_hd(args.hd_dir)
    (ROOT / '.tmp/mk64/asset-audit.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
