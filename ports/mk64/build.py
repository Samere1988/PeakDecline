"""Build the experimental MKart360 browser port from pinned local sources."""
import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import re
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
WORK = ROOT / '.tmp' / 'mk64'
SOURCE = WORK / 'MKart360' / 'mk64-master'
BUILD = WORK / 'build'
EMCC = Path(os.environ.get('PEAK_EMCC', WORK / 'emsdk' / 'upstream' / 'emscripten' / 'emcc.py'))

KEEP_PLATFORM = {'xbox360_memory_codec.c', 'xbox360_replay_codec.c',
                 'xbox360_tkmk00.cpp', 'xbox360_course_table.c', 'xbox360_gfx_bridge.c',
                 'xbox360_race8.c', 'xbox360_audio_hle.cpp'}


def generated(path, contents):
    if not path.exists() or path.read_text(encoding='utf-8') != contents:
        path.write_text(contents, encoding='utf-8')
    return path


def common_endian_table():
    """Read pinned metadata's flat asset records without interpreting YAML tags."""
    metadata = (SOURCE / 'yamls/us/common_data.yml').read_text()
    records = []
    for block in re.split(r'(?m)^(?=[A-Za-z_]\w*:)', metadata):
        kind = re.search(r'^  type: ([\w:]+)', block, re.M)
        offset = re.search(r'^  offset: (0x[0-9A-Fa-f]+)', block, re.M)
        if kind and offset:
            count = re.search(r'^  count: (\d+)', block, re.M)
            records.append((int(offset[1], 16) & 0xffffff, kind[1].lower(), int(count[1]) if count else 0))
    records.sort()
    rows = []
    for index, (offset, kind, count) in enumerate(records):
        if kind == 'vtx':
            assert count > 0
            rows.append((offset, count, 16, 6, 2))
        elif kind == 'mtx':
            rows.append((offset, count * 16, 4, 1, 4))
        elif kind in ('gfx', 'inc'):
            end = records[index + 1][0]
            assert (end - offset) % 4 == 0
            rows.append((offset, (end - offset) // 4, 4, 1, 4))
    assert len(rows) > 150
    return '/* Generated from pinned common_data.yml; textures remain byte data. */\n' + '\n'.join(
        '{%s},' % ','.join(str(value) for value in row) for row in rows) + '\n'


def texture_endian_overlays():
    """Preserve original texture bytes when compiling u16 assets for wasm32.

    The renderer decodes textures and TLUTs as big-endian byte streams. The
    upstream Xbox asset generator emits native u16 initializers for some of
    these assets, which reverse each byte pair on a little-endian target.
    Recipe metadata distinguishes them from byte arrays and game structures.
    """
    count = 0
    for recipe in json.loads((SOURCE / 'PUBLIC_ASSET_RECIPES.json').read_text()):
        if recipe['representation'] != 'u16be':
            continue
        relative = Path(recipe['path'])
        original = (SOURCE / relative).read_text()
        assert not re.sub(r'0x[0-9a-fA-F]+|[\s,]', '', original), relative
        values = [int(value, 16) for value in re.findall(r'0x[0-9a-fA-F]+', original)]
        swapped = [(value >> 8) | ((value & 255) << 8) for value in values]
        wasm_bytes = b''.join(value.to_bytes(2, 'little') for value in swapped)
        assert len(wasm_bytes) == recipe['size'], relative
        assert hashlib.sha256(wasm_bytes).hexdigest() == recipe['sha256'], relative
        target = BUILD / 'include' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        generated(target, '\n'.join(', '.join(f'0x{value:04x}' for value in swapped[i:i+8]) + ','
                                    for i in range(0, len(swapped), 8)) + '\n')
        count += 1
    assert count > 0
    print(f'Prepared {count} texture/palette endian overlays.', flush=True)


def main():
    global BUILD
    ap = argparse.ArgumentParser()
    ap.add_argument('--compile-only', action='store_true')
    ap.add_argument('--output-dir', type=Path, default=ROOT / 'instance/mk64/build')
    ap.add_argument('--hd-manifest', type=Path, help='Generated MK64 Reloaded browser texture manifest')
    ap.add_argument('--authority-candidate', action='store_true', help='Build experimental externally stepped simulation')
    args = ap.parse_args()
    if args.authority_candidate:
        if args.output_dir.resolve() == (ROOT / 'instance/mk64/build').resolve():
            ap.error('Authority candidates require a separate --output-dir.')
        BUILD = WORK / 'build-authority'
    if not EMCC.is_file() or not (SOURCE / 'src/xbox360/generated_banks').is_dir():
        raise SystemExit('Run ports/mk64/prepare.py --rom PATH first. See ports/mk64/README.md.')
    BUILD.mkdir(parents=True, exist_ok=True)
    texture_endian_overlays()
    os_header = (SOURCE / 'include/PR/os.h').read_text()
    for old, new in [
        ('extern u32 osVirtualToPhysical', 'extern uintptr_t osVirtualToPhysical'),
        ('bcmp(const void*, const void*, int)', 'bcmp(const void*, const void*, size_t)'),
        ('osPiRawStartDma(s32, u32, void*, u32)', 'osPiRawStartDma(s32, u32, void*, size_t)'),
        ('osPiRawWriteIo(u32, u32)', 'osPiRawWriteIo(uintptr_t, u32)'),
        ('osPiRawReadIo(u32, u32*)', 'osPiRawReadIo(uintptr_t, u32*)'),
        ('osPiWriteIo(u32, u32)', 'osPiWriteIo(uintptr_t, u32)'),
        ('osPiReadIo(u32, u32*)', 'osPiReadIo(uintptr_t, u32*)'),
        ('osPiStartDma(OSIoMesg*, s32, s32, u32, void*, u32, OSMesgQueue*)',
         'osPiStartDma(OSIoMesg*, s32, s32, uintptr_t, void*, size_t, OSMesgQueue*)'),
        ('osEPiRawStartDma(OSPiHandle*, s32, u32, void*, u32)',
         'osEPiRawStartDma(OSPiHandle*, s32, u32, void*, size_t)'),
    ]:
        os_header = os_header.replace(old, new)
    (BUILD / 'include/PR').mkdir(parents=True, exist_ok=True)
    generated(BUILD / 'include/PR/os.h', os_header)
    audio_internal = (SOURCE / 'src/audio/internal.h').read_text()
    audio_internal = audio_internal.replace(
        'struct EuAudioCmd {\n    union {\n        struct {\n            u8 op;\n            u8 bankId;\n            u8 arg2;\n            u8 arg3;\n        } s;',
        'struct EuAudioCmd {\n    union {\n        struct {\n            u8 arg3;\n            u8 arg2;\n            u8 bankId;\n            u8 op;\n        } s;')
    audio_internal = audio_internal.replace(
        '        u8 as_u8;\n        s8 as_s8;\n    } u2;\n};',
        '        struct { u8 pad_u8[3]; u8 as_u8; };\n'
        '        struct { u8 pad_s8[3]; s8 as_s8; };\n    } u2;\n};')
    (BUILD / 'include/audio').mkdir(parents=True, exist_ok=True)
    generated(BUILD / 'include/audio/internal.h', audio_internal)
    # Use the portable-width race-state declaration without enabling the
    # upstream GCC debug menu, which consumes normal title-screen controls.
    generated(BUILD / 'include/defines.h', (SOURCE / 'include/defines.h').read_text().replace(
        '#if defined(GCC) || defined(DEBUG)', '#if defined(DEBUG)'))
    generated(BUILD / 'include/web_common_endian.inc.h', common_endian_table())
    generated(BUILD / 'include/PR/gbi.h', (SOURCE / 'include/PR/gbi.h').read_text())
    tree = ET.parse(WORK / 'MKart360' / 'MK64' / 'MK64.vcxproj')
    units = []
    for item in tree.findall('.//{*}ClCompile'):
        name = item.get('Include')
        if not name:
            continue
        src = (WORK / 'MKart360' / 'MK64' / name.replace('\\', '/')).resolve()
        rel = src.relative_to(SOURCE).as_posix()
        if rel.startswith('src/xbox360/') and not ('/generated_banks/' in rel or src.name in KEEP_PLATFORM):
            continue
        lang = item.find('{*}CompileAs')
        cpp = src.suffix == '.cpp' or (lang is not None and lang.text == 'CompileAsCpp')
        if rel == 'src/racing/actors.c':
            # The decomp labels the shared segmented address 0x0600FC70 as a
            # Moo Moo Farm palette. In Luigi Raceway it is the tree display
            # list; native linking gives these distinct objects distinct addresses.
            tree_render = generated(BUILD / 'tree_render.inc.c',
                (SOURCE / 'src/actors/trees/render.inc.c').read_text().replace(
                    'gSPDisplayList(gDisplayListHead++, d_course_moo_moo_farm_mole_tlut);',
                    'gSPDisplayList(gDisplayListHead++, d_course_luigi_raceway_dl_FC70);'))
            contents = src.read_text().replace(
                '#include "actors/trees/render.inc.c"',
                '#include "' + tree_render.as_posix() + '"')
            # The shell palette comes from big-endian RGBA16 ROM bytes. The
            # red-shell conversion operates on 16-bit channels, so swap at
            # both boundaries on little-endian WebAssembly.
            assert contents.count('color_pixel = *green_shell_texture;') == 1
            contents = contents.replace('color_pixel = *green_shell_texture;',
                'color_pixel = __builtin_bswap16(*green_shell_texture);')
            shell_channels = 's16 color_pixel, red_color, green_color, blue_color, alpha_color;'
            assert contents.count(shell_channels) == 1
            contents = contents.replace(shell_channels,
                'u16 color_pixel, red_color, green_color, blue_color, alpha_color;')
            red_shell_color = '*red_shell_texture = (red_color >> 5) | (green_color << 5) | blue_color | alpha_color;'
            assert contents.count(red_shell_color) == 1
            contents = contents.replace(red_shell_color,
                '*red_shell_texture = __builtin_bswap16((red_color >> 5) | '
                '(green_color << 5) | blue_color | alpha_color);')
            contents = 'void web_register_item_matrices(int,int,int,int,int);\n' + contents
            for item, cast in (('banana', 'BananaActor'), ('green_shell', 'ShellActor'),
                               ('red_shell', 'ShellActor'), ('blue_shell', 'ShellActor')):
                call = f'                render_actor_{item}(camera, D_801502C0, (struct {cast}*) actor);'
                assert contents.count(call) == 1
                contents = contents.replace(call, '                { int first = gMatrixObjectCount;\n' + call +
                    '\n                web_register_item_matrices(camera-camera1, i, (actor->type<<16)|(unsigned short)actor->state, first, gMatrixObjectCount); }')
            call = '                render_actor_fake_item_box(camera, (struct FakeItemBox*) actor);'
            assert contents.count(call) == 1
            contents = contents.replace(call, '                { int first = gMatrixObjectCount;\n' + call +
                '\n                web_register_item_matrices(camera-camera1, i, (actor->type<<16)|(unsigned short)actor->state, first, gMatrixObjectCount); }')
            src = generated(BUILD / 'actors.c', contents)
        if rel in ('courses/luigi_raceway/course_displaylists.inc.c',
                   'courses/wario_stadium/course_displaylists.inc.c'):
            # The N64 course segment's six TV tiles are modified every frame.
            # The decomp's static symbolic aliases point to their original
            # white ROM images, so native builds must retain segment-5 links.
            course, first = ('luigi_raceway', 0xf800) if 'luigi_raceway' in rel else ('wario_stadium', 0x8800)
            prefix = 'gLRTexture' if course == 'luigi_raceway' else 'gWSTexture'
            names = ('68272C', '682928', '682B24', '682D20', '682F1C', '683118')
            contents = src.read_text()
            for local in ('course_displaylists.inc.h', 'course_textures.linkonly.h'):
                contents = contents.replace(f'"{local}"', f'"courses/{course}/{local}"')
            for index, suffix in enumerate(names):
                old = f'gsDPSetTextureImage(G_IM_FMT_RGBA, G_IM_SIZ_16b, 1, {prefix}{suffix})'
                assert contents.count(old) == 1, (rel, old)
                contents = contents.replace(old, 'gsDPSetTextureImage(G_IM_FMT_RGBA, G_IM_SIZ_16b, 1, '
                                            f'((u8*)0x05{first + index * 0x1000:06X}))')
            src = generated(BUILD / (course + '_displaylists.c'), contents)
        if rel == 'src/racing/memory.c':
            contents = src.read_text().replace('u8* dma_textures(u8 texture[], size_t arg1, size_t arg2)',
                                                'u8* dma_textures(u8 texture[], u32 arg1, u32 arg2)')
            contents = contents.replace('sp28 = *(u32*) (heapEnd + 4);', 'sp28 = __builtin_bswap32(*(u32*) (heapEnd + 4));')
            contents = contents.replace('set_segment_base_addr(9, load_data((uintptr_t) offsetRomStart, (uintptr_t) offsetRomEnd));',
                'u32 *web_offsets = load_data((uintptr_t) offsetRomStart, (uintptr_t) offsetRomEnd);\n'
                '    for (size_t i=0; i<(size_t)(offsetRomEnd-offsetRomStart)/4; ++i) web_offsets[i]=__builtin_bswap32(web_offsets[i]);\n'
                '    set_segment_base_addr(9, web_offsets);')
            contents = contents.replace('func_802A86A8((CourseVtx*) freeSpace, vertexCount);',
                'CourseVtx *web_vertices = freeSpace;\n'
                '    for (u32 i=0;i<vertexCount;++i) {\n'
                '        for(int j=0;j<3;++j) web_vertices[i].ob[j]=__builtin_bswap16(web_vertices[i].ob[j]);\n'
                '        for(int j=0;j<2;++j) web_vertices[i].tc[j]=__builtin_bswap16(web_vertices[i].tc[j]);\n'
                '    }\n'
                '    func_802A86A8((CourseVtx*) freeSpace, vertexCount);')
            src = BUILD / 'memory.c'
            generated(src, contents)
        if rel == 'src/audio/load.c':
            contents = 'extern void web_audio_bank_endian(void*,unsigned,unsigned,unsigned);\n' + src.read_text().replace(
                'audio_dma_copy_immediate((u8 *) X360_AUDIO_ROM(&_instrument_setsSegmentRomStart,0xBE90E0), gAlBankSets, 0x100);',
                'audio_dma_copy_immediate((u8 *) X360_AUDIO_ROM(&_instrument_setsSegmentRomStart,0xBE90E0), gAlBankSets, 0x100);\n'
                '    /* The ROM bank-set offsets are big-endian u16 values. */\n'
                '    for (i = 0; i < gSequenceCount; ++i) ((u16*)gAlBankSets)[i] = __builtin_bswap16(((u16*)gAlBankSets)[i]);')
            contents = contents.replace('gCtlEntries[i].numInstruments = buf[0];\n        gCtlEntries[i].numDrums = buf[1];',
                'gCtlEntries[i].numInstruments = __builtin_bswap32(buf[0]);\n        gCtlEntries[i].numDrums = __builtin_bswap32(buf[1]);')
            contents = contents.replace('audio_dma_copy_immediate(ctlData + 0x10, ret, (u32) alloc);',
                'audio_dma_copy_immediate(ctlData + 0x10, ret, (u32) alloc);\n'
                '    web_audio_bank_endian(ret, alloc, gCtlEntries[bankId].numInstruments, gCtlEntries[bankId].numDrums);')
            src = generated(BUILD / 'audio_load.c', contents)
        if rel == 'src/audio/effects.c':
            # WebAssembly is little-endian; ROM and embedded sequence envelopes
            # are byte streams in big-endian order, unlike the Xbox CPU.
            contents = src.read_text().replace('#define X360_ADSR16(v) (v)',
                                                '#define X360_ADSR16(v) BSWAP16(v)')
            src = generated(BUILD / 'audio_effects.c', contents)
        if rel == 'src/main.c':
            contents = src.read_text().replace(
                'textureSegSize = *(uintptr_t*) (textureSegStart + 4);',
                'textureSegSize = __builtin_bswap32(*(u32*) (textureSegStart + 4));')
            contents = '#include <stddef.h>\nvoid web_fix_common(void*,size_t);\nint web_should_stop(void);\n' + contents
            contents = contents.replace('mio0decode((u8*) textureSegStart, (u8*) allocatedMemory);',
                'mio0decode((u8*) textureSegStart, (u8*) allocatedMemory);\n    web_fix_common((void*)allocatedMemory, textureSegSize);')
            # The native loop yields with Asyncify; cancelling an Emscripten
            # callback cannot stop it. Return at each suspended input boundary
            # and after a state transition that may have waited for audio.
            begin = contents.index('void thread5_game_loop(')
            end = contents.index('void thread4_audio(', begin)
            loop = contents[begin:end]
            assert loop.count('while (true)') == 1
            assert loop.count('read_controllers();') == 2
            loop = loop.replace('while (true)', 'while (!web_should_stop())')
            loop = loop.replace('read_controllers();', 'read_controllers();\n        if (web_should_stop()) return;')
            loop = loop.replace('update_gamestate();', 'update_gamestate();\n            if (web_should_stop()) return;')
            if args.authority_candidate:
                marker = '    while (!web_should_stop()) {'
                prefix, body = loop.split(marker, 1)
                close = body.rfind('    }')
                assert body[close:].strip().startswith('}\n}')
                loop = (prefix + '}\n' +
                        'void web_game_tick(void) {\n' + body[:close] + '}\n')
            contents = contents[:begin] + loop + contents[end:]
            # Hash canonical values that influence menus and racing, including
            # CPU karts. Never hash struct padding, pointers or render history.
            marker = '    h=net_hash_bytes(h,&gRandomSeed16,sizeof(gRandomSeed16));'
            assert contents.count(marker) == 1
            fields = ('gGamestateNext', 'gMenuSelection', 'gMainMenuSelection',
                      'gPlayerCountSelection1', 'gCharacterGridSelections',
                      'gCharacterGridIsSelected', 'gCupSelection', 'gCourseIndexInCup',
                      'gCurrentCourseId', 'gActiveScreenMode', 'gRaceState',
                      'gIsGamePaused', 'gCourseTimer')
            contents = contents.replace(marker, marker + '\n' + '\n'.join(
                f'    h=net_hash_bytes(h,&{field},sizeof({field}));' for field in fields))
            marker = '    if(players<2)players=2;'
            assert contents.count(marker) == 1
            contents = contents.replace(marker, '    players=8; /* CPU karts also affect the race. */')
            marker = '        h=net_hash_bytes(h,&gPlayers[i].type,sizeof(gPlayers[i].type));'
            assert contents.count(marker) == 1
            contents = contents.replace(marker, marker + '\n' + '\n'.join(
                f'        h=net_hash_bytes(h,&gPlayers[i].{field},sizeof(gPlayers[i].{field}));'
                for field in ('characterId', 'rotation', 'currentRank', 'triggers', 'currentItemCopy')))
            src = generated(BUILD / 'main.c', contents)
        if rel == 'src/menu_items.c':
            contents = src.read_text(encoding='utf-8')
            # Menu text is emitted one glyph/rectangle at a time. Mark the
            # complete menu pass so widescreen HUD anchoring never splits a
            # name, score row or sliding results card into separate clusters.
            contents = '#include "web_display.h"\n' + contents
            marker = '    gSPDisplayList(gDisplayListHead++, D_02007F18);'
            assert contents.count(marker) >= 4
            contents = contents.replace(marker,
                '    gDPNoOpTag(gDisplayListHead++, WEB_MENU_BEGIN);\n' + marker)
            marker = '    gSPDisplayList(gDisplayListHead++, D_02007F48);'
            contents = contents.replace(marker, marker +
                '\n    gDPNoOpTag(gDisplayListHead++, WEB_MENU_END);')
            # The N64 font decoder expects EUC-JP byte pairs, while these
            # recovered source literals are UTF-8. Each UTF-8 byte otherwise
            # renders as a separate glyph (the repeated B's in VS results).
            result_labels = {
                '"ーーーー"': '"----"',
                '"1 ｓ"': '"1ST"', '"2 ｎ"': '"2ND"', '"3 ｒ"': '"3RD"',
                '"4 ｔ"': '"4TH"', '"5 ｔ"': '"5TH"',
                '"ー"': '"-"',
                '"1 ｓ ー"': '"1ST"', '"2 ｎ ー"': '"2ND"', '"3 ｒ ー"': '"3RD"',
            }
            for old, new in result_labels.items():
                assert contents.count(old) == 1, old
                contents = contents.replace(old, new)
            # Character portraits use the forced MIO0 loader when the menu opens.
            # Its default 0x1000-byte DMA truncates frames that the animation
            # loader later reads with 0x1400 bytes, leaving idle portraits black.
            portrait_loader = 'void load_menu_img_comp_type(MenuTexture* addr, s32 compType) {'
            loader_start = contents.index(portrait_loader)
            loader_end = contents.index('void func_80099958(', loader_start)
            loader = contents[loader_start:loader_end]
            fallback = '            } else {\n                size = 0x1000;\n            }'
            assert loader.count(fallback) == 1
            loader = loader.replace(fallback,
                '            } else {\n'
                '                size = (compType == LOAD_MENU_IMG_MIO0_FORCE) ? 0x1400 : 0x1000;\n'
                '            }')
            contents = contents[:loader_start] + loader + contents[loader_end:]
            # Portraits need black backing in the selection grid, but the game
            # wipes unused cards away when players confirm their choices.
            portrait = '                func_800A12BC(arg0, segmented_to_virtual_dupe(D_800E7D54[arg0->type - 0x2B]));'
            assert contents.count(portrait) == 1
            contents = contents.replace(portrait,
                '                if (arg0->state != 1 && arg0->state != 3) {\n'
                '                    gDisplayListHead = draw_box_fill(gDisplayListHead, arg0->column, arg0->row, '
                'arg0->column + 0x3F, arg0->row + 0x4B, 0, 0, 0, 0xFF);\n'
                '                }\n' + portrait)
            # The original GP map screen cycles one course preview at a time.
            # Keep all four cup previews visible in the browser port.
            marker = 'void func_800AB314(MenuItem* item) {'
            begin = contents.index(marker)
            end = contents.index('void func_800AB904(', begin)
            preview = contents[begin:end]
            preview = re.sub(r'    } else \{\n        switch \(item->state\) \{.*?\n        }\n    }\n}\n',
                             '    } else {\n'
                             '        item->state = 3;\n'
                             '        for (i = 0; i < 4; i++) {\n'
                             '            _items[i]->visible = 1;\n'
                             '            _items[i]->priority = 6;\n'
                             '        }\n'
                             '    }\n}\n', preview, flags=re.S)
            assert 'item->state = 3;' in preview and 'if (++item->param2 > 50)' not in preview
            contents = contents[:begin] + preview + contents[end:]
            mask_begin = contents.index('void func_800A8CA4(')
            mask_end = contents.index('void render_battle_introduction(', mask_begin)
            mask = contents[mask_begin:mask_end]
            assert mask.count('if (gModeSelection == GRAND_PRIX) {') == 1
            contents = (contents[:mask_begin] + mask.replace('if (gModeSelection == GRAND_PRIX) {',
                        'if (0 && gModeSelection == GRAND_PRIX) {') + contents[mask_end:])
            start = contents.index('void func_8009A9FC(')
            end = contents.index('u16* func_8009B8C4(', start)
            colors = contents[start:end].replace('temp_a0 = *color0++;', 'temp_a0 = __builtin_bswap16(*color0++);')
            colors = colors.replace('*color &', '__builtin_bswap16(*color) &')
            colors = re.sub(r'(\*color1?\+\+ = )([^;]+);', r'\1__builtin_bswap16(\2);', colors)
            src = generated(BUILD / 'menu_items.c', contents[:start] + colors + contents[end:])
        if rel == 'src/render_objects.c':
            contents = ('void web_register_lakitu_matrix(int, int, const void*);\n' + src.read_text())
            begin = contents.index('void render_lakitu(')
            end = contents.index('void func_800534A4(', begin)
            lakitu = contents[begin:end]
            marker = '        object = &gObjectList[objectIndex];'
            assert lakitu.count(marker) == 1
            lakitu = lakitu.replace(marker, marker +
                '\n        web_register_lakitu_matrix(cameraId, object->unk_0D8,\n'
                '            &gGfxPool->mtxHud[gMatrixHudCount]);')
            contents = '#include "web_display.h"\n' + contents[:begin] + lakitu + contents[end:]
            # Outline, finish line and markers all use the same map center.
            for name in ('func_8004EE54', 'render_mini_map_finish_line', 'func_8004F3E4'):
                start = contents.index('void ' + name + '(')
                opening = contents.index('{', start)
                depth, closing = 1, opening + 1
                while depth:
                    depth += (contents[closing] == '{') - (contents[closing] == '}')
                    closing += 1
                tag = '\n    gDPNoOpTag(gDisplayListHead++, WEB_MAP_TAG(gMiniMapFinishLineX[arg0]+D_8018D2F0, gMiniMapFinishLineY[arg0]+D_8018D2F8));\n'
                contents = contents[:opening+1] + tag + contents[opening+1:closing-1] + '\n    gDPNoOpTag(gDisplayListHead++, WEB_MAP_END);\n' + contents[closing-1:]
            src = generated(BUILD / 'render_objects.c', contents)
        if rel == 'src/racing/render_courses.c':
            src = generated(BUILD / 'render_courses.c', src.read_text().replace(
                '#include "math_util.h"', '#include "math_util.h"\nvoid vec_unit_z_rotX_rotY(s16, s16, Vec3f);'))
        if rel == 'include/xbox360/gfx_pc.c':
            contents = ('#include <emscripten/heap.h>\n#include "web_display.h"\n'
                        'extern "C" int gActiveScreenMode;\n'
                        'static bool web_menu_layout, web_map_layout;\nstatic float web_map_offset;\n'
                        'extern "C" void web_store_framebuffer(void*);\n'
                        'extern "C" void web_interpolate_matrix(const void*, float[4][4]);\n' + src.read_text())
            marker = '    if ((parameters & G_MTX_PROJECTION) && x360_projection_log_count < 2) {'
            assert contents.count(marker) == 1
            contents = contents.replace(marker, '    web_interpolate_matrix(addr, matrix);\n' + marker)
            # Change presentation coordinates only: wider world projection,
            # proportional HUD sprites and anchors within each split-screen view.
            vertex_start = '    const size_t first_dest_index = dest_index;\n'
            assert contents.count(vertex_start) == 1
            contents = contents.replace(vertex_start, vertex_start +
                '    const bool web_wide = x360_display_aspect() > 1.5f;\n'
                '    const bool web_ortho = web_projection_is_ortho(rsp.P_matrix);\n'
                '    float web_offset = 0, web_min = 1e30f, web_max = -1e30f, web_ymin=1e30f, web_ymax=-1e30f;\n'
                '    bool web_background = false;\n'
                '    if (web_wide && web_ortho) {\n'
                '        for (size_t i=0;i<n_vertices;++i) {\n'
                '            const Vtx_t *v=&vertices[i].v;\n'
                '            float x=v->ob[0]*rsp.MP_matrix[0][0]+v->ob[1]*rsp.MP_matrix[1][0]+v->ob[2]*rsp.MP_matrix[2][0]+rsp.MP_matrix[3][0];\n'
                '            float w=v->ob[0]*rsp.MP_matrix[0][3]+v->ob[1]*rsp.MP_matrix[1][3]+v->ob[2]*rsp.MP_matrix[2][3]+rsp.MP_matrix[3][3];\n'
                '            float y=v->ob[0]*rsp.MP_matrix[0][1]+v->ob[1]*rsp.MP_matrix[1][1]+v->ob[2]*rsp.MP_matrix[2][1]+rsp.MP_matrix[3][1];\n'
                '            if (fabsf(w)>0.0001f) {x/=w;y/=w;web_min=fminf(web_min,x);web_max=fmaxf(web_max,x);web_ymin=fminf(web_ymin,y);web_ymax=fmaxf(web_ymax,y);}\n'
                '        }\n'
                '        web_background = web_min <= -0.999f && web_max >= 0.999f;\n'
                '        web_offset=web_map_layout ? web_map_offset : web_ui_offset(web_min,web_max,web_ymax,web_ymin,gGamestate==4 && !web_menu_layout,gActiveScreenMode);\n'
                '    }\n')
            contents = contents.replace('        x = gfx_adjust_x_for_aspect_ratio(x);',
                '        if (web_wide && !web_background) x = x * WEB_WIDE_SCALE + (web_ortho ? web_offset * w : 0);')
            old_rect = '        ulxf = gfx_adjust_x_for_aspect_ratio(ulxf);\n        lrxf = gfx_adjust_x_for_aspect_ratio(lrxf);'
            assert contents.count(old_rect) == 1
            contents = contents.replace(old_rect,
                '        if (x360_display_aspect()>1.5f) {\n'
                '            float span=lrxf-ulxf;\n'
                '            bool full=span>=1.999f || (gGamestate==4 && !web_menu_layout && gActiveScreenMode>=2 && span>=0.999f);\n'
                '            if (!full) {\n'
                '                float offset=web_map_layout ? web_map_offset : web_ui_offset(ulxf,lrxf,ulyf,lryf,gGamestate==4 && !web_menu_layout,gActiveScreenMode);\n'
                '                ulxf=ulxf*WEB_WIDE_SCALE+offset;lrxf=lrxf*WEB_WIDE_SCALE+offset;\n'
                '            }\n'
                '        }')
            # RSP Z generation and RDP depth comparison are separate controls.
            # Menu glyphs inherit G_ZBUFFER but select non-Z XLU_SURF; testing
            # them against track depth makes arbitrary result rows disappear.
            depth = '    const bool depth_test = (rsp.geometry_mode & G_ZBUFFER) == G_ZBUFFER;'
            assert contents.count(depth) == 1
            contents = contents.replace(depth,
                '    const bool depth_test = (rsp.geometry_mode & G_ZBUFFER) && (rdp.other_mode_l & Z_CMP);')
            contents = contents.replace('    const bool z_upd = (rdp.other_mode_l & Z_UPD) == Z_UPD;',
                '    const bool z_upd = (rsp.geometry_mode & G_ZBUFFER) && (rdp.other_mode_l & Z_UPD);')
            marker = '            case G_NOOP:\n'
            assert contents.count(marker) == 1
            contents = contents.replace(marker, marker +
                '                if ((cmd->words.w1 & 0xfff00000U) == WEB_MAP_BEGIN) {\n'
                '                    gfx_flush(); web_map_layout=true; web_map_offset=web_map_anchor(cmd->words.w1,gActiveScreenMode);\n'
                '                } else if (cmd->words.w1 == WEB_MAP_END) {gfx_flush();web_map_layout=false;}\n'
                '                if (cmd->words.w1 == WEB_MENU_BEGIN || cmd->words.w1 == WEB_MENU_END) {\n'
                '                    gfx_flush();\n'
                '                    web_menu_layout = cmd->words.w1 == WEB_MENU_BEGIN;\n'
                '                }\n')
            contents = contents.replace('    gfx_sp_reset();',
                '    web_menu_layout = web_map_layout = false;\n    gfx_sp_reset();')
            contents = contents.replace('    gfx_rapi->end_frame();',
                '    web_store_framebuffer(rdp.color_image_address);\n    gfx_rapi->end_frame();')
            contents = contents.replace('a < 0x80000000U || a >= 0xA0000000U',
                                        'a < 0x10000000U || a >= emscripten_get_heap_size()')
            contents = contents.replace('addr >= 0x80000000U && addr < 0xA0000000U',
                                        'addr >= 0x10000000U && addr < emscripten_get_heap_size()')
            contents = contents.replace('    for (;;) {\n        uint32_t opcode = cmd->words.w0 >> 24;',
                '    unsigned web_commands=0;\n    for (;;) {\n'
                '        if (++web_commands>65536) {\n'
                '            fputs("MK64: unterminated graphics display list.\\n",stderr); abort();\n'
                '        }\n'
                '        uint32_t opcode = cmd->words.w0 >> 24;')
            src = generated(BUILD / 'gfx_pc.cpp', contents)
        if rel == 'src/xbox360/xbox360_gfx_bridge.c':
            contents = src.read_text()
            original = '    gfx_start_frame();\n    gfx_run(dl);\n    gfx_end_frame();'
            assert contents.count(original) == 1
            contents = ('#ifdef __cplusplus\nextern "C" {\n#endif\n'
                        'int web_begin_presentation(void);\n'
                        'void web_begin_presentation_pass(int);\n'
                        'int web_should_stop(void);\n'
                        'int web_skip_graphics(void);\n'
                        '#ifdef __cplusplus\n}\n#endif\n' + contents)
            contents = contents.replace(original,
                '    if (web_skip_graphics()) return;\n'
                '    int passes = web_begin_presentation();\n'
                '    for (int pass = 0; pass < passes && !web_should_stop(); ++pass) {\n'
                '        web_begin_presentation_pass(pass);\n'
                '        gfx_start_frame();\n        gfx_run(dl);\n        gfx_end_frame();\n'
                '    }')
            if args.authority_candidate:
                contents = '#include <emscripten.h>\n' + contents
                contents += """
#ifdef __cplusplus
extern "C"
#endif
EMSCRIPTEN_KEEPALIVE void web_present_pass(int midpoint) {
    web_begin_presentation();
    web_begin_presentation_pass(midpoint ? 0 : 1);
    gfx_start_frame();
    gfx_run((Gfx*)gGfxSPTask->task.t.data_ptr);
    gfx_end_frame();
}
"""
            src = generated(BUILD / 'gfx_bridge.c', contents)
        units.append((src, cpp, rel.replace('/', '_') + '.o'))
    for src in sorted((PORT / 'src').glob('*')):
        if src.suffix in ('.c', '.cpp'):
            units.append((src, src.suffix == '.cpp', 'web_' + src.name + '.o'))

    flags = ['-O1', '-g', '-fms-extensions', '-fno-strict-aliasing', '-fwrapv',
             '-Wno-error=implicit-function-declaration', '-Wno-error=int-conversion',
             '-Wno-error=incompatible-pointer-types', '-Wno-narrowing', '-Wno-register', '-DENABLE_OPENGL=1',
             # Audio note playback otherwise rejects valid low WebAssembly pointers as segmented addresses.
             '-DXBOX360_PORT=1', '-DNO_SEGMENTED_MEMORY=1', '-DNON_MATCHING=1', '-DAVOID_UB=1', '-DGCC=1',
             '-DF3DEX_GBI=1', '-DF3D_OLD=1', '-DVERSION_US=1',
             '-D_snprintf=snprintf', '-D_vsnprintf=vsnprintf', '-D_LANGUAGE_C=1', '-Drestrict=__restrict']
    if args.authority_candidate:
        flags += ['-DWEB_AUTHORITY_CANDIDATE=1']
    for inc in [BUILD / 'include', PORT / 'include', SOURCE, SOURCE / 'include', SOURCE / 'include/xbox360',
                SOURCE / 'src', SOURCE / 'src/racing', SOURCE / 'src/ending',
                SOURCE / 'src/audio', SOURCE / 'src/data', SOURCE / 'courses']:
        flags += ['-I', str(inc)]
    dependencies = hashlib.sha256(os_header.encode())
    for directory in (SOURCE, PORT / 'include', BUILD / 'include'):
        for header in sorted(directory.rglob('*')):
            if header.is_file() and (header.suffix == '.h' or '.inc.' in header.name):
                dependencies.update(str(header).encode())
                dependencies.update(header.read_bytes())
    dependency_key = dependencies.digest()
    def compile_unit(unit):
        src, cpp, name = unit
        obj = BUILD / name
        key = hashlib.sha256((str(src) + str(cpp) + repr(flags)).encode() + src.read_bytes() + dependency_key).hexdigest()
        stamp = obj.with_suffix('.sha256')
        if obj.exists() and stamp.exists() and stamp.read_text() == key:
            return obj, ''
        cmd = [sys.executable, str(EMCC), '-x', 'c++' if cpp else 'c', '-std=c++17' if cpp else '-std=gnu11',
               *flags, '-c', str(src), '-o', str(obj)]
        p = subprocess.run(cmd, capture_output=True, text=True)
        (BUILD / (name + '.log')).write_text(p.stdout + p.stderr, encoding='utf-8')
        if not p.returncode:
            stamp.write_text(key)
        return (obj, '' if not p.returncode else p.stderr)
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as pool:
        results = list(pool.map(compile_unit, units))
    failed = [(p.name, err) for p, err in results if err]
    print(f'Compiled {len(results)-len(failed)}/{len(results)} source files.', flush=True)
    for name, err in failed[:12]:
        print(name + '\n' + '\n'.join(line for line in err.splitlines() if 'error:' in line)[:3000])
    if failed:
        raise SystemExit(1)
    if args.compile_only:
        return
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(EMCC), *map(str, (p for p, err in results)),
           '-O1', '-g', '-Wl,--error-limit=0', '-Wl,-Map=' + str(BUILD / 'link.map'), '-sASYNCIFY=1', '-sALLOW_MEMORY_GROWTH=1',
           '-sINITIAL_MEMORY=402653184', '-sGLOBAL_BASE=268435456', '-sSTACK_SIZE=2097152',
           '-sASSERTIONS=2', '-sMODULARIZE=1', '-sEXPORT_NAME=createMK64',
           '-sEXPORTED_RUNTIME_METHODS=FS,callMain' + (',HEAPU8' if args.authority_candidate else ''), '-sINVOKE_RUN=0',
           '-sEXPORTED_FUNCTIONS=_main,_malloc,_free', '-o', str(out / 'mk64.js')]
    if args.hd_manifest:
        manifest = json.loads(args.hd_manifest.read_text())
        if manifest.get('schema') != 1 or not re.fullmatch(r'[a-z0-9.-]+', manifest.get('assetId', '')):
            raise SystemExit('Invalid HD texture manifest.')
        loader = generated(BUILD / 'hd_textures.js',
            'Module["mk64HDManifest"]=' + json.dumps(manifest, separators=(',', ':')) + ';\n' +
            (PORT / 'hd_textures.js').read_text())
        cmd += ['--pre-js', str(loader)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    (BUILD / 'link.log').write_text(p.stdout + p.stderr, encoding='utf-8')
    print(p.stdout + p.stderr)
    if p.returncode == 0 and args.authority_candidate:
        from state_manifest import write_manifest
        write_manifest(BUILD / 'link.map', out)
    if p.returncode == 0 and os.name == 'nt':
        # Emscripten moves files from its private temp directory. Recreate them
        # beside the destination so they inherit the deployment folder's ACL.
        for name in ('mk64.js', 'mk64.wasm'):
            artifact = out / name
            published = out / (name + '.' + uuid.uuid4().hex + '.publish')
            with published.open('xb') as stream:
                stream.write(artifact.read_bytes())
            os.replace(published, artifact)
    raise SystemExit(p.returncode)


if __name__ == '__main__':
    main()
