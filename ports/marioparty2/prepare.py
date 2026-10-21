"""Validate the US ROM and derive translation metadata from pinned splat output.

Run the pinned decomp with splat --disassemble-all first. Outputs remain in .tmp;
this script does not publish a game or touch services.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import yaml

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
SOURCE = ROOT / '.tmp/marioparty2-native'
RECOMP = ROOT / '.tmp/marioparty-recompiler'
OUT = ROOT / '.tmp/marioparty2-port'
SPEC = json.loads((PORT / 'sources.json').read_text())


def main():
    for key, folder in [('decomp', SOURCE), ('recompiler', RECOMP)]:
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=folder, text=True).strip()
        if revision != SPEC[key]['commit']:
            raise SystemExit('Unexpected revision: ' + str(folder))
    rom_path = SOURCE / 'baserom.us.z64'
    rom = rom_path.read_bytes()
    if hashlib.sha1(rom).hexdigest() != SPEC['rom_sha1']:
        raise SystemExit('Expected original big-endian US Mario Party ROM.')
    layout = yaml.safe_load((SOURCE / 'marioparty2.yaml').read_text())['segments']
    sections = []
    for i, segment in enumerate(layout[:-1]):
        if not isinstance(segment, dict) or segment.get('type') != 'code':
            continue
        following = layout[i+1]
        end = following['start'] if isinstance(following, dict) else following[0]
        sections.append(dict(name=segment['name'], rom=segment['start'], vram=segment['vram'], size=end-segment['start'], functions=[]))
    seen = {}
    untranslated_blocks = []
    for path in sorted((SOURCE / 'asm').rglob('*.s')):
        text = path.read_text()
        for match in re.finditer(r'^glabel (\w+)\n(.*?)^endlabel \1', text, re.M | re.S):
            name, body = match.groups()
            instructions = re.findall(r'^\s*/\* ([0-9A-F]+) ([0-9A-F]+) ([0-9A-F]{8}) \*/\s+\w', body, re.M)
            if not instructions:
                raw = re.findall(r'^\s*/\* ([0-9A-F]+) ([0-9A-F]+) ([0-9A-F]{8}) \*/', body, re.M)
                if raw: untranslated_blocks.append(dict(name=name, rom=int(raw[0][0],16), size=len(raw)*4))
                continue
            words = [(int(a,16),int(b,16),bytes.fromhex(c)) for a,b,c in instructions]
            start, vram, _ = words[0]
            for n,(offset, address, word) in enumerate(words):
                if offset != start+n*4 or address != vram+n*4 or rom[offset:offset+4] != word:
                    raise SystemExit('Noncontiguous or mismatched instruction data: ' + str(path))
            func = dict(name=name,vram=vram,size=len(words)*4)
            key = (start,vram)
            if key in seen:
                if seen[key] != func:
                    raise SystemExit('Conflicting function boundaries: ' + str(path))
                continue
            seen[key]=func
            matches=[s for s in sections if s['rom']<=start and start+func['size']<=s['rom']+s['size'] and vram-s['vram']==start-s['rom']]
            if len(matches)!=1:
                raise SystemExit('Ambiguous section: '+name)
            matches[0]['functions'].append(func)
    if not any(f['name']=='rand8' for s in sections for f in s['functions']):
        raise SystemExit('Missing matched functions; run splat --disassemble-all.')
    # Splat labels the squared-vector-length body one instruction late. Its
    # actual caller at 0x800B1878 targets the leading NOP at 0x800B1840.
    # Without including that NOP, N64Recomp synthesizes a one-NOP function
    # which returns without falling through into the calculation.
    length = [f for section in sections for f in section['functions']
              if f['name'] == 'func_800B1844_B2444']
    if len(length) != 1 or length[0]['vram'] != 0x800B1844 or length[0]['size'] != 40:
        raise SystemExit('Unexpected vector-length function boundary')
    if rom[0xB2440:0xB2448] != bytes.fromhex('00000000460c6002'):
        raise SystemExit('Unexpected vector-length entry instructions')
    length[0].update(name='func_800B1840_B2440', vram=0x800B1840, size=44)
    OUT.mkdir(parents=True,exist_ok=True)
    def write_symbols(path, selected):
        lines=[]
        for s in selected:
            lines += ['[[section]]',f'name = {json.dumps(s["name"])}',f'rom = {s["rom"]}',f'vram = {s["vram"]}',f'size = {s["size"]}','functions = [']
            for f in sorted(s['functions'],key=lambda f:f['vram']):
                lines.append('  { name = "%s", vram = %d, size = %d },' % (f['name'],f['vram'],f['size']))
            lines += [']','']
        path.write_text('\n'.join(lines))
    write_symbols(OUT/'all-symbols.toml',sections)
    probe=[dict(s,functions=[f for f in s['functions'] if f['name']=='rand8']) for s in sections if any(f['name']=='rand8' for f in s['functions'])]
    write_symbols(OUT/'probe-symbols.toml',probe)
    for name in ('probe','all'):
        (OUT/(name+'.toml')).write_text('[input]\nsymbols_file_path = "'+name+'-symbols.toml"\nrom_file_path = '+json.dumps(str(rom_path))+'\noutput_func_path = "'+name+'-generated"\n')
    # Disk boot decodes and executes writable code. The cartridge prototype
    # requires an explicit failing runtime replacement, never a silent stub.
    with (OUT/'all.toml').open('a') as config:
        config.write('\n[patches]\nignored = ["LeoBootGame", "__LeoBootGame2", "__LeoBootGame3", "func_8009D24C_9DE4C", "HuPrcCall", "HuPrcSleep", "HuPrcChildWatch", "HuPrcTerminate"]\n')
    report=dict(rom_sha1=SPEC['rom_sha1'],sections=len(sections),functions=len(seen),instruction_bytes=sum(f['size'] for f in seen.values()),untranslated_blocks=untranslated_blocks,status='metadata only; full translation and runtime unverified')
    (OUT/'audit.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__=='__main__':main()
