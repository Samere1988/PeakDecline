"""Adapt the upstream host soundfont decoder to the cartridge audio engine."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.tmp/fzerox'
SOURCE = WORK / 'G-Diffuser/decomp/src/audio'
OUTPUT = WORK / 'browser-source/decomp/src/audio/rom'


def main():
    (OUTPUT / 'lib').mkdir(parents=True, exist_ok=True)
    # The native EK port gates its disk-only startup on drive presence. The
    # cartridge implementation starts its ROM sound-effects sequence here too.
    gfx = (SOURCE.parent / 'sys/sys_gfx.c').read_text(encoding='utf-8')
    gate = 'if (gLeoDriveConnectionState != 0) {\n        Audio_GuitarSeqStart();\n    }'
    if gfx.count(gate) != 1:
        raise SystemExit('Cartridge audio startup gate changed upstream.')
    gfx = gfx.replace(gate, 'Audio_GuitarSeqStart(); /* Cartridge sequences need no disk. */')
    sys_output = OUTPUT.parents[1] / 'sys'
    sys_output.mkdir(parents=True, exist_ok=True)
    (sys_output / 'sys_gfx.c').write_text(gfx, encoding='utf-8')
    hle = (WORK / 'G-Diffuser/port/n64_audio_hle.c').read_text(encoding='utf-8')
    hle = hle.replace('GDX_A_HILOGAIN     = 14,', 'GDX_A_HILOGAIN     = 24, /* cartridge ABI */')
    (WORK / 'browser-source/port/n64_audio_hle.c').write_text(hle, encoding='utf-8')
    heap = (SOURCE / 'rom/lib/heap.c').read_text(encoding='utf-8')
    before = '    gPermanentCache.entries[index].size = size;\n}'
    if heap.count(before) != 1:
        raise SystemExit('Cartridge permanent audio allocator changed upstream.')
    heap = heap.replace(before, '    gPermanentCache.entries[index].size = size;\n'
        '    return ramAddr; /* The original MIPS return register was implicit. */\n}')
    (OUTPUT / 'lib/heap.c').write_text(heap, encoding='utf-8')
    external = (SOURCE / 'rom/external.c').read_text(encoding='utf-8')
    external, count = re.subn(r'#ifdef PORT\n(?:    \(void\) soundMode;\n)?    return; // Audio_Init is skipped on PORT[^\n]*\n#endif\n', '', external)
    if count != 3:
        raise SystemExit('Cartridge audio disable guards changed upstream.')
    (OUTPUT / 'external.c').write_text(external, encoding='utf-8')

    disk = (SOURCE / 'disk/lib/load.c').read_text(encoding='utf-8')
    start = disk.index('/* Host soundfont conversion.')
    end = disk.index('#endif /* PORT */', start)
    decoder = disk[start:end]
    for before, after in {
        'gAudioCtx.soundFontList': 'gSoundFontList',
        'gAudioCtx.numUsedSamples': 'gNumUsedSamples',
        'gAudioCtx.usedSamples': 'gUsedSamples',
        '    sample->unk0 = flags >> 31;\n': '',
        'gdx_rdram_persist_alloc_raw(unsigned long long size, unsigned long long align)': 'gdx_rdram_persist_alloc_raw(size_t size, size_t align)',
        '(unsigned long long) size': '(size_t) size',
        'sample->codec = (flags >> 28) & 7;': 'sample->codec = (flags >> 28) & 15;',
        '    s32 numSfx = gSoundFontList[fontId].numSfx;\n': '',
        '    u32 sfxBaseOffset;\n': '',
        '    SoundEffect* sfxArr = NULL;\n': '',
        '    sfxBaseOffset = gdx_rd_u32(fontData + 4);\n': '',
        'fontData + 8 + i * 4': 'fontData + 4 + i * 4',
        '    gSoundFontList[fontId].soundEffects = sfxArr;\n': '',
        '    GdxSoundfontPackApply(fontId, &gSoundFontList[fontId]);\n': '',
    }.items():
        decoder = decoder.replace(before, after)
    decoder = re.sub(r'#ifdef PORT\n    /\* Audio modding stage 3:.*?#endif\n', '', decoder, flags=re.S)
    start = decoder.index('    if (numSfx > 0) {')
    end = decoder.index('    if (numInstruments > 126)', start)
    decoder = decoder[:start] + decoder[end:]
    decoder = decoder.replace(' *   u32[1]            sound-effect array offset (8-byte {u32 sample, f32\n *                     tuning} entries)\n *   u32[2 + i]        instrument i offset',
                              ' *   u32[1 + i]        cartridge instrument i offset')
    load = (SOURCE / 'rom/lib/load.c').read_text(encoding='utf-8')
    start = load.index('void AudioLoad_RelocateFont(')
    end = load.index('void AudioLoad_SyncDma(', start)
    load = load[:start] + decoder + '\nvoid AudioLoad_RelocateFont(s32 fontId, uintptr_t fontBaseAddr, void* relocData) {\n    gdx_audio_convert_font(fontId, (const u8*)fontBaseAddr, relocData);\n}\n\n' + load[end:]
    # The sequence font index is stored as big-endian bytes even in static C data.
    load = load.replace('gSeqFontTable = gSequenceFontTableData;',
        'gSeqFontTable = gSequenceFontTableData;\n'
        '    for (i = 0; i < gSequenceTable->header.numEntries; ++i) {\n'
        '        u16 value = ((u16)gSeqFontTable[i * 2] << 8) | gSeqFontTable[i * 2 + 1];\n'
        '        ((u16*)gSeqFontTable)[i] = value;\n'
        '    }')
    # WASM starts with zeroed globals; linker boundary tokens are not a BSS arena.
    load, count = re.subn(r'    \{\n        s32 i;\n        s64\* audioContextPtr.*?\n    \}\n', '', load, count=1, flags=re.S)
    if count != 1:
        raise SystemExit('Cartridge audio BSS initialization changed upstream.')
    (OUTPUT / 'lib/load.c').write_text(load, encoding='utf-8')
    thread = (SOURCE / 'rom/lib/thread.c').read_text(encoding='utf-8')
    thread = thread.replace('audioCmd->opArgs = opArgs;',
        'audioCmd->op = opArgs >> 24;\n    audioCmd->arg0 = opArgs >> 16;\n'
        '    audioCmd->arg1 = opArgs >> 8;\n    audioCmd->arg2 = opArgs;')
    thread = thread.replace('u32 uData = data << 0x18;', 'u32 uData = (u8)data;')
    thread = thread.replace('u32 uData = data << 0x10;', 'u32 uData = data;')
    (OUTPUT / 'lib/thread.c').write_text(thread, encoding='utf-8')
    disk_seq = (SOURCE / 'disk/lib/seqplayer.c').read_text(encoding='utf-8')
    start = disk_seq.index('/* Envelopes referenced by the layer/channel ENV ops')
    end = disk_seq.index('#endif', start)
    seq = (SOURCE / 'rom/lib/seqplayer.c').read_text(encoding='utf-8')
    insertion = seq.index('\nu16 AudioSeq_')
    seq = seq[:insertion] + '\n' + disk_seq[start:end] + seq[insertion:]
    seq = seq.replace('(EnvelopePoint*) (seqPlayer->seqData + (u16) cmdArg)',
        'AudioSeq_PortConvertSeqEnvelope(seqPlayer->seqData + (u16) cmdArg)')
    seq = seq.replace('(EnvelopePoint*) &seqPlayer->seqData[cmdArgU16]',
        'AudioSeq_PortConvertSeqEnvelope(&seqPlayer->seqData[cmdArgU16])')
    (OUTPUT / 'lib/seqplayer.c').write_text(seq, encoding='utf-8')
    print('Cartridge audio enabled with host-native soundfont conversion.')


if __name__ == '__main__':
    main()
