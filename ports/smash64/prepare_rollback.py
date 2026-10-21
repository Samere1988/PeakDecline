"""Generate experimental Smash WASM rollback hooks in an isolated browser checkout.

This does not publish artifacts. Validate generated builds before running
publish.py. Inputs/state ownership stay with PeakNet.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PORT = Path(__file__).resolve().parent
SOURCE = ROOT / '.tmp/battleship-web'
VITA = ROOT / '.tmp/ssb-vita-decomp-inspect'


def function_span(text, name):
    match = re.search(r'^[\w* \t]+?\b' + name + r'\s*\([^;{}]*?\)\s*(?://[^\n]*)?\s*\{', text, re.M)
    if not match:
        raise ValueError('Missing function ' + name)
    start = text.rfind('\n', 0, match.start()) + 1
    opening = text.index('{', match.start())
    depth = 1
    end = opening + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return start, opening, end


def read(relative):
    path = SOURCE / relative
    # Preserve the pinned browser source on first use so re-running preparation
    # never stacks hooks onto already generated files.
    original = SOURCE / '.peak-rollback-originals' / relative
    if not original.exists():
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(path.read_bytes())
    return original.read_text(encoding='utf-8')


def write(relative, text):
    path = SOURCE / relative
    if not path.exists() or path.read_text(encoding='utf-8') != text:
        path.write_text(text, encoding='utf-8')


def main():
    manifest = json.loads((PORT / 'sources.json').read_text())
    for checkout, revision in [(SOURCE, manifest['browser']['commit']), (VITA, manifest['rollback']['commit'])]:
        actual = subprocess.check_output(['git', '-c', 'safe.directory=' + checkout.as_posix(),
                                          '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != revision:
            raise ValueError('Source revision does not match sources.json: ' + str(checkout))
    for name, expected in manifest['rollback']['files'].items():
        data = (PORT / 'vendor/vita' / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError('Vendored rollback source changed: ' + name)
        write('decomp/src/sys/' + name, data.decode('utf-8').replace('\r\n', '\n'))

    # Retain Vita's state capture/restore and object lifetime handling. Replace
    # its prediction/transport controller with the framework's shared scheduler.
    text = (PORT / 'vendor/vita/netrollback.c').read_text(encoding='utf-8')
    text = text.replace('#include <ft/ftmain.h>', '#include <ft/ftmain.h>\nextern void ftMainEjectHiddenPartID(FTStruct*, s32);')
    text = text.replace('#include <netplay/netplay_bridge.h>',
                        '#include <emscripten.h>\n#include <emscripten/html5.h>\n'
                        'static u64 port_netplay_monotonic_us(void) { return (u64)(emscripten_get_now() * 1000.0); }\n'
                        'static sb32 sPeakActive;\n'
                        'static sb32 peak_rb_owns_battle(void);\n'
                        'static void peak_rb_reset_aobjs(void);\n'
                        'static void peak_rb_collect_aobjs(u32);\n'
                        'static void peak_rb_reactivate_aobj(AObj*);\n'
                        'extern u32 sIFCommonTimerStamp, sIFCommonTimerLimit, sIFCommonTimerIsStarted;\n'
                        'extern s32 sIFCommonBattlePlace;\n'
                        'extern s32 dGRYamabukiMonsterAttackKind;\n'
                        'extern GRObstacle sFTMainGroundObstacles[2];\nextern GRHazard sFTMainGroundHazards[1];\n'
                        'extern s32 sFTMainGroundObstaclesNum, sFTMainGroundHazardsNum;\n'
                        'sb32 syNetInputModernNetplayActive(void) { return sPeakActive; }')
    # Opening movies also create/destroy fighters and projectiles. Their scene
    # arenas are discarded on transition, so battle lifetime retention must
    # never keep pointers to those objects for the subsequent VS battle.
    for name in ('syNetRollbackDeferObjectEject', 'syNetRollbackDeferFighterDObjEject'):
        _, opening, _ = function_span(text, name)
        text = text[:opening+1] + '\n    if (!peak_rb_owns_battle()) return FALSE;\n' + text[opening+1:]
    start, _, end = function_span(text, 'syNetRollbackHandlePredictionMismatch')
    text = text[:start] + text[end:]
    start, opening, end = function_span(text, 'syNetRollbackPostFrame')
    body = text[opening:end]
    body = body[:body.index('    if ((frame % SYNETROLLBACK_HASH_INTERVAL)')] + '}\n'
    body = body.replace('    u32 zi;', '    u32 zi;\n    peak_rb_collect_aobjs(frame);')
    text = text[:opening] + body + text[end:]
    text = text.replace('    syNetRollbackFlushZombies();', '    syNetRollbackFlushZombies();\n    peak_rb_reset_aobjs();')
    text = text.replace('typedef struct SYNetRollbackDObjState',
        (PORT / 'rollback_materials.h').read_text() + '\ntypedef struct SYNetRollbackDObjState')
    text = text.replace('    GCUserData user_data;\n    u8 aobj_count;',
        '    GCUserData user_data;\n    MObj *mobj;\n    u8 aobj_count;')
    text = text.replace('    u16 dobj_count;',
        '    u16 dobj_count;\n    u32 material_count;\n    PeakMaterialState materials[PEAK_MATERIAL_MAX];')
    text = text.replace('typedef struct SYNetRollbackSnapshot',
        (PORT / 'rollback_eggs.h').read_text() + '\n' +
        (PORT / 'rollback_effects.h').read_text() + '\ntypedef struct SYNetRollbackSnapshot')
    text = text.replace('#define SYNETROLLBACK_DOBJ_MAX 384', '#define SYNETROLLBACK_DOBJ_MAX 768')
    text = text.replace('    sb32 hash_valid;',
        '    u32 effect_count;\n    PeakEffectState effects[PEAK_EFFECT_MAX];\n    sb32 hash_valid;')
    text = text.replace('    SYNetRollbackItemManagerState item_manager;',
        '    SYNetRollbackItemManagerState item_manager;\n    ITMonsterData monster_data;\n'
        '    s32 yamabuki_attack_kind, obstacle_count, hazard_count;\n'
        '    GRObstacle obstacles[2];\n    GRHazard hazards[1];')
    text = text.replace('    syNetRollbackSaveItemManager(snapshot);',
        '''    snapshot->monster_data = gITManagerMonsterData;
    snapshot->yamabuki_attack_kind = dGRYamabukiMonsterAttackKind;
    snapshot->obstacle_count = sFTMainGroundObstaclesNum;
    snapshot->hazard_count = sFTMainGroundHazardsNum;
    memcpy(snapshot->obstacles, sFTMainGroundObstacles, sizeof(snapshot->obstacles));
    memcpy(snapshot->hazards, sFTMainGroundHazards, sizeof(snapshot->hazards));
    syNetRollbackSaveItemManager(snapshot);''')
    text = text.replace('    syNetRollbackRestoreItemManager(snapshot);',
        '''    gITManagerMonsterData = snapshot->monster_data;
    dGRYamabukiMonsterAttackKind = snapshot->yamabuki_attack_kind;
    sFTMainGroundObstaclesNum = snapshot->obstacle_count;
    sFTMainGroundHazardsNum = snapshot->hazard_count;
    memcpy(sFTMainGroundObstacles, snapshot->obstacles, sizeof(snapshot->obstacles));
    memcpy(sFTMainGroundHazards, snapshot->hazards, sizeof(snapshot->hazards));
    syNetRollbackRestoreItemManager(snapshot);''')
    # Pokémon change display callbacks/layers as their animated move changes.
    # Their ITStruct alone cannot restore the GObj's rendering state.
    text = text.replace('    u32 gobj_flags;',
        '    u32 gobj_flags;\n    DObj *root;\n    void (*proc_display)(GObj*);\n    u8 dl_link_id;\n    u32 dl_link_priority;')
    text = text.replace('        dst->gobj_flags = gobj->flags;',
        '        dst->gobj_flags = gobj->flags;\n        dst->root = DObjGetStruct(gobj);\n        dst->proc_display = gobj->proc_display;\n'
        '        dst->dl_link_id = gobj->dl_link_id;\n        dst->dl_link_priority = gobj->dl_link_priority;')
    for kind in ('items', 'weapons'):
        marker = f'            gobj->flags = snapshot->{kind}[i].gobj_flags;'
        saved = f'snapshot->{kind}[i]'
        text = text.replace(marker, marker + f'''
            gobj->proc_display = {saved}.proc_display;
            if (gobj->dl_link_id != {saved}.dl_link_id || gobj->dl_link_priority != {saved}.dl_link_priority)
                gcMoveGObjDLHead(gobj, {saved}.dl_link_id, {saved}.dl_link_priority);''')
    text = text.replace('    sb32 hash_valid;',
        '    u32 egg_count;\n    PeakEggState eggs[GMCOMMON_PLAYERS_MAX];\n    sb32 hash_valid;')
    text = text.replace('    syNetRollbackSaveObjects(snapshot);',
        '    syNetRollbackSaveObjects(snapshot);\n    peak_rb_save_eggs(snapshot);')
    text = text.replace('    syNetRollbackRestoreDObjs(snapshot);',
        '    if (!peak_rb_restore_eggs(snapshot)) return FALSE;\n    syNetRollbackRestoreDObjs(snapshot);')
    text = text.replace('    peak_rb_collect_aobjs(frame);',
        '    peak_rb_collect_eggs(frame);\n    peak_rb_collect_aobjs(frame);')
    text = text.replace('    peak_rb_reset_aobjs();',
        '    peak_rb_reset_eggs();\n    peak_rb_reset_aobjs();')
    text = text.replace('    peak_rb_save_eggs(snapshot);',
        '    peak_rb_save_eggs(snapshot);\n    peak_rb_save_effects(snapshot);\n    peak_rb_save_materials(snapshot);')
    text = text.replace('    syNetRollbackRestoreDObjs(snapshot);',
        '    if (!peak_rb_restore_item_roots(snapshot)) return FALSE;\n    if (!peak_rb_restore_effects(snapshot)) return FALSE;\n    peak_rb_restore_materials(snapshot);\n    syNetRollbackRestoreDObjs(snapshot);')
    text = text.replace('    peak_rb_collect_aobjs(frame);',
        '    peak_rb_collect_effects(frame);\n    peak_rb_collect_item_roots(frame);\n    peak_rb_collect_materials(frame);\n    peak_rb_collect_aobjs(frame);')
    text = text.replace('    peak_rb_reset_aobjs();',
        '    peak_rb_reset_effects();\n    peak_rb_reset_item_roots();\n    peak_rb_reset_materials();\n    peak_rb_reset_aobjs();')
    text = text.replace('static SYNetRollbackSnapshot sSYNetRollbackSnapshots',
        'static sb32 peak_rb_restore_item_roots(const SYNetRollbackSnapshot*);\n'
        'static void peak_rb_collect_item_roots(u32);\nstatic void peak_rb_reset_item_roots(void);\n'
        'static SYNetRollbackSnapshot sSYNetRollbackSnapshots')
    text = text.replace('        itManagerSetPrevStructAlloc((ITStruct *)struct_ptr);', '''
        ITStruct *ip = struct_ptr;
        if (ip->arrow_gobj) { gcEjectGObj(ip->arrow_gobj); ip->arrow_gobj = NULL; }
        itManagerSetPrevStructAlloc(ip);''')
    text = text.replace('    sb32 hash_valid;',
                        '    SYController controllers[4];\n    SYController main_controller;\n    u32 input_tick, weapon_group;\n    u16 motion_count, stat_count;\n    u32 timer_stamp, timer_limit, timer_started;\n    s32 battle_place;\n    sb32 hash_valid;')
    text = text.replace('#include <wp/wpmanager.h>', '#include <wp/wpmanager.h>\nextern u32 sWPManagerGroupID;')
    text = text.replace('    GRStruct ground;',
        '    GRStruct ground;\n    u32 ground_count;\n'
        '    struct { GObj *ptr; f32 anim_frame; u32 flags; } ground_objects[64];')
    # Particle transforms are cosmetic and have their own allocator. Keep live
    # handles rather than resurrecting a snapshot's freed transform pointer.
    text = text.replace('    gGRCommonStruct = snapshot->ground;', '''
    GRStruct current_ground = gGRCommonStruct;
    gGRCommonStruct = snapshot->ground;
    if (gSCManagerBattleState->gkind == nGRKindPupupu) {
        gGRCommonStruct.pupupu.leaves_xf = current_ground.pupupu.leaves_xf;
        gGRCommonStruct.pupupu.dust_xf = current_ground.pupupu.dust_xf;
    } else if (gSCManagerBattleState->gkind == nGRKindHyrule) {
        gGRCommonStruct.hyrule.twister_xf = current_ground.hyrule.twister_xf;
    }''')
    _, opening, _ = function_span(text, 'syNetRollbackSaveMap')
    text = text[:opening+1] + '''
    for (u32 layer = 0; layer < 2; ++layer)
    for (GObj *obj = gGCCommonLinks[layer ? nGCCommonLinkIDGroundDisplay : nGCCommonLinkIDGround]; obj; obj = obj->link_next) {
        if (snapshot->ground_count >= 64) { snapshot->restorable = FALSE; return; }
        u32 n = snapshot->ground_count++;
        snapshot->ground_objects[n].ptr = obj;
        snapshot->ground_objects[n].anim_frame = obj->anim_frame;
        snapshot->ground_objects[n].flags = obj->flags;
        syNetRollbackSaveGObjDObjs(snapshot, obj);
    }
''' + text[opening+1:]
    text = text.replace('    gGRCommonStruct = snapshot->ground;', '''
    // Validate allocation identity before dereferencing retained stage objects.
    u32 ground_index = 0;
    for (u32 layer = 0; layer < 2; ++layer)
    for (GObj *obj = gGCCommonLinks[layer ? nGCCommonLinkIDGroundDisplay : nGCCommonLinkIDGround]; obj; obj = obj->link_next) {
        if (ground_index >= snapshot->ground_count || snapshot->ground_objects[ground_index].ptr != obj) return FALSE;
        ground_index++;
    }
    if (ground_index != snapshot->ground_count) return FALSE;
    for (u32 n = 0; n < snapshot->ground_count; ++n) {
        snapshot->ground_objects[n].ptr->anim_frame = snapshot->ground_objects[n].anim_frame;
        snapshot->ground_objects[n].ptr->flags = snapshot->ground_objects[n].flags;
    }
    gGRCommonStruct = snapshot->ground;''')
    # Animation command cursors affect fighter transitions and hit timing, even
    # though rendering interpolation itself is excluded from state hashes.
    text = text.replace('    MObj *mobj;\n    u8 aobj_count;',
                        '    MObj *mobj;\n    AObjScript anim_joint;\n    u8 is_anim_root;\n    u8 aobj_count;')
    text = text.replace('state->anim_frame = dobj->anim_frame;',
                        'state->anim_frame = dobj->anim_frame;\n            state->anim_joint = dobj->anim_joint;\n            state->is_anim_root = dobj->is_anim_root;')
    text = text.replace('dobj->anim_frame = state->anim_frame;',
                        'dobj->anim_frame = state->anim_frame;\n        dobj->anim_joint = state->anim_joint;\n        dobj->is_anim_root = state->is_anim_root;')
    # FTStruct stores only the joint's FTParts pointer. Animation enable flags
    # and transform caches live behind it; hidden-joint retention already keeps
    # these allocations alive. Accessory effects keep their own visual lifetime.
    text = text.replace('    MObj *mobj;\n    AObjScript anim_joint;',
        '    MObj *mobj;\n    void *display_list;\n    sb32 has_fighter_parts;\n    FTParts fighter_parts;\n    AObjScript anim_joint;')
    text = text.replace('            state->user_data = dobj->user_data;', '''
            state->user_data = dobj->user_data;
            state->display_list = dobj->dv;
            if (dobj->parent_gobj && dobj->parent_gobj->link_id == nGCCommonLinkIDFighter && dobj->user_data.p) {
                state->has_fighter_parts = TRUE;
                state->fighter_parts = *ftGetParts(dobj);
            }''')
    text = text.replace('        dobj->user_data = state->user_data;', '''
        dobj->user_data = state->user_data;
        dobj->dv = state->display_list;
        if (state->has_fighter_parts) {
            FTParts *parts = ftGetParts(dobj);
            GObj *accessory = parts->gobj;
            FTParts *next = parts->next;
            *parts = state->fighter_parts;
            parts->gobj = accessory;
            parts->next = next;
        }''')
    text = text.replace('    AObj *ptr;\n    u8 track;', '    AObj *ptr;\n    void *interpolate;\n    u8 track;')
    text = text.replace('dst->ptr = aobj;', 'dst->ptr = aobj;\n        dst->interpolate = aobj->interpolate;')
    text = text.replace('dst->track = src->track;', 'dst->interpolate = src->interpolate;\n            dst->track = src->track;')
    text = text.replace('        for (a = 0; a < state->aobj_count; a++)', '''
        // Retire discarded future tracks, then reconstruct the saved list.
        // Saved nodes cannot enter the allocator until the rollback window ends.
        for (AObj *live = dobj->aobj, *next; live; live = next) {
            next = live->next;
            u32 n;
            for (n = 0; n < state->aobj_count; ++n) if (state->aobjs[n].ptr == live) break;
            if (n == state->aobj_count) gcSetAObjPrevAlloc(live);
        }
        dobj->aobj = state->aobj_count ? state->aobjs[0].ptr : NULL;
        for (a = 0; a < state->aobj_count; a++) {
            AObj *node = state->aobjs[a].ptr;
            peak_rb_reactivate_aobj(node);
            node->next = a + 1 < state->aobj_count ? state->aobjs[a + 1].ptr : NULL;
        }
        for (a = 0; a < state->aobj_count; a++)''')
    text = text.replace('sb32 zombied = ((z != NULL) && (z->destroy_frame <= snap_frame)) ? TRUE : FALSE;',
        'sb32 zombied = ((z != NULL) && (z->destroy_frame < snap_frame)) ? TRUE : FALSE;\n'
        '    if (z != NULL && !zombied) z->active = FALSE;')
    marker = 'static void syNetRollbackSetGObjProcsPaused'
    text = text.replace(marker, 'sb32 peak_rb_object_dead(GObj *gobj) { return syNetRollbackFindZombie(gobj) != NULL; }\n\n' + marker)
    # Retained dead objects are allocator history, not current world state.
    # Capturing them again lets a fresh snapshot outlive their retention window
    # and later restore DObjs that have already been reused by another object.
    _, opening, end = function_span(text, 'syNetRollbackSaveObjects')
    body = text[opening:end]
    for kind in ('item', 'weapon'):
        marker = f'        if (snapshot->{kind}_count >='
        body = body.replace(marker, '        if (syNetRollbackFindZombie(gobj) != NULL) continue;\n' + marker)
    text = text[:opening] + body + text[end:]
    _, opening, end = function_span(text, 'syNetRollbackReconcileList')
    body = text[opening:end].replace('            void *sp =',
        '            if (z != NULL && z->destroy_frame < snapshot->frame) { gobj = next; continue; }\n            void *sp =')
    text = text[:opening] + body + text[end:]
    _, opening, end = function_span(text, 'syNetRollbackTopologyMatches')
    body = text[opening:end].replace('        while ((si <',
        '        if (syNetRollbackFindZombie(gobj) != NULL) continue;\n        while ((si <')
    text = text[:opening] + body + text[end:]
    text = text.replace('    snapshot->rng_seed = syUtilsRandSeed();',
                        '    memcpy(snapshot->controllers, gSYControllerDevices, sizeof(snapshot->controllers));\n'
                        '    snapshot->main_controller = gSYControllerMain;\n'
                        '    snapshot->input_tick = syNetInputGetTick();\n'
                        '    snapshot->motion_count = gFTManagerMotionCount;\n'
                        '    snapshot->stat_count = gFTManagerStatUpdateCount;\n'
                        '    snapshot->weapon_group = sWPManagerGroupID;\n'
                        '    snapshot->timer_stamp = sIFCommonTimerStamp;\n'
                        '    snapshot->timer_limit = sIFCommonTimerLimit;\n'
                        '    snapshot->timer_started = sIFCommonTimerIsStarted;\n'
                        '    snapshot->battle_place = sIFCommonBattlePlace;\n'
                        '    snapshot->rng_seed = syUtilsRandSeed();')
    # Preserve previous buttons as well as held buttons for correct tap/release
    # derivation after restore. This is additional browser adapter state.
    text = text.replace('    sSYNetRollbackSnapshotRestoreUs = syNetRollbackElapsedUs(begin);',
                        '    peakRestoreControllers(snapshot);\n'
                        '    sSYNetRollbackSnapshotRestoreUs = syNetRollbackElapsedUs(begin);')
    declaration = '''
extern void syNetInputMakeFrame(SYNetInputFrame*, u32, u16, s8, s8, SYNetInputSource, sb32);
extern void syNetInputPublishFrame(s32, SYNetInputFrame*);
extern void syNetInputPublishMainController(void);
static void peakRestoreControllers(const SYNetRollbackSnapshot *snapshot) {
    for (int i = 0; i < 4; ++i) {
        SYNetInputFrame input;
        syNetInputMakeFrame(&input, snapshot->frame - 1, snapshot->controllers[i].button_hold,
            snapshot->controllers[i].stick_range.x, snapshot->controllers[i].stick_range.y,
            nSYNetInputSourceSaved, FALSE);
        syNetInputPublishFrame(i, &input);
    }
    memcpy(gSYControllerDevices, snapshot->controllers, sizeof(snapshot->controllers));
    gSYControllerMain = snapshot->main_controller;
    syNetInputSetTick(snapshot->input_tick);
    gFTManagerMotionCount = snapshot->motion_count;
    gFTManagerStatUpdateCount = snapshot->stat_count;
    sWPManagerGroupID = snapshot->weapon_group;
    sIFCommonTimerStamp = snapshot->timer_stamp;
    sIFCommonTimerLimit = snapshot->timer_limit;
    sIFCommonTimerIsStarted = snapshot->timer_started;
    sIFCommonBattlePlace = snapshot->battle_place;
}
'''
    text = text.replace('static sb32 syNetRollbackRestoreSnapshot(u32 frame)', declaration + '\nstatic sb32 syNetRollbackRestoreSnapshot(u32 frame)')
    # Camera scripts are used by 1P cinematics today, but capture the complete
    # animation controller so future battle camera animations cannot escape rewind.
    text = text.replace('    CObjVec vec;',
        '    CObjVec vec;\n    CObj camera_state;\n    u32 track_count;\n    PeakAnimTrackState tracks[10];')
    text = text.replace('        snapshot->camera_cobj.ptr = camera_cobj;',
        '        snapshot->camera_cobj.ptr = camera_cobj;\n'
        '        snapshot->camera_cobj.camera_state = *camera_cobj;\n'
        '        snapshot->camera_cobj.track_count = peak_rb_save_tracks(camera_cobj->aobj, snapshot->camera_cobj.tracks, 10, &snapshot->restorable);')
    text = text.replace('        camera->vec = snapshot->camera_cobj.vec;',
        '        peak_rb_restore_tracks(&camera->aobj, snapshot->camera_cobj.tracks, snapshot->camera_cobj.track_count);\n'
        '        *camera = snapshot->camera_cobj.camera_state;\n'
        '        camera->vec = snapshot->camera_cobj.vec;')
    text += (PORT / 'rollback_exports.c').read_text(encoding='utf-8')
    text += (PORT / 'rollback_eggs.c').read_text(encoding='utf-8')
    text += (PORT / 'rollback_effects.c').read_text(encoding='utf-8')
    text += (PORT / 'rollback_itemroots.c').read_text(encoding='utf-8')
    text += (PORT / 'rollback_materials.c').read_text(encoding='utf-8')
    write('decomp/src/sys/netrollback.c', '/* Browser adaptation of pinned Vita rollback; see ports/smash64. */\n' + text)
    # Quarantined objects remain allocated solely to support rewind. They are
    # not live game state and their physical cleanup timing is not a checksum.
    sync = (PORT / 'vendor/vita/netsync.c').read_text(encoding='utf-8')
    sync = sync.replace('if (wp == NULL) continue;', 'if (wp == NULL || peak_rb_object_dead(gobj)) continue;')
    sync = sync.replace('if (ip == NULL) continue;', 'if (ip == NULL || peak_rb_object_dead(gobj)) continue;')
    sync = '#include <ssb_types.h>\nstruct GObj;\nextern sb32 peak_rb_object_dead(struct GObj*);\n' + sync
    sync = sync.replace('''\t/* Joint/AObj animation state is presentation state. It may legitimately be
\t * at a different interpolation point after rollback resimulation even when
\t * the gameplay state is identical. Hash the fighter root transform instead:
\t * collision, status, timers and velocities above carry the authoritative
\t * gameplay state while the root gives us the world-space position. */''',
        '''\t/* This digest hashes a subset of state. Joint animation can affect
\t * gameplay and is captured by rollback even though this checksum includes
\t * only the root position. A matching digest is not proof of full animation
\t * equivalence; use snapshot round-trip checks as well. */''')
    # A cloud's material animation gates collision activation. Hash its logical
    # timing (never pointers), so an early mismatch cannot remain invisible.
    cloud_marker = '\t\t\t\thash = syNetSyncFnv64F32(hash, gGRCommonStruct.yoster.clouds[i].altitude);'
    if cloud_marker not in sync:
        raise ValueError('Missing pinned Yoshi cloud checksum')
    sync = sync.replace(cloud_marker, '''
                MObj *material = gGRCommonStruct.yoster.clouds[i].dobj[0]->mobj;
                hash = syNetSyncFnv64F32(hash, material->anim_wait);
                hash = syNetSyncFnv64F32(hash, material->anim_speed);
                hash = syNetSyncFnv64F32(hash, material->anim_frame);
                hash = syNetSyncFnv64U32(hash, gGRCommonStruct.yoster.clouds[i].is_cloud_line_active);
                hash = syNetSyncFnv64U32(hash, gGRCommonStruct.yoster.clouds[i].evaporate_wait);
''' + cloud_marker)
    # Egg animation controls gameplay, so include its phase/time in the fighter
    # digest. Never hash allocation addresses, which differ between clients.
    _, opening, end = function_span(sync, 'syNetSyncHashOneFighter64')
    body = sync[opening:end].replace('\treturn hash;', '''
    if (fp->status_id == nFTCommonStatusYoshiEgg) {
        GObj *egg = fp->status_vars.common.captureyoshi.effect_gobj;
        hash = syNetSyncFnv64U32(hash, egg != NULL);
        hash = syNetSyncFnv64S32(hash, fp->status_vars.common.captureyoshi.breakout_wait);
        if (egg) {
            EFStruct *ep = efGetStruct(egg);
            hash = syNetSyncFnv64S32(hash, ep->effect_vars.yoshi_egg_lay.index);
            hash = syNetSyncFnv64S32(hash, ep->effect_vars.yoshi_egg_lay.force_index);
            hash = syNetSyncFnv64F32(hash, egg->anim_frame);
        }
    }
    return hash;''')
    sync = '#include <ef/effect.h>\n' + sync[:opening] + body + sync[end:]
    write('decomp/src/sys/netsync.c', sync)
    header = read('decomp/src/sys/netinput.h').replace('#endif /* _SYNETINPUT_H_ */',
        'extern sb32 syNetInputModernNetplayActive(void);\n#endif /* _SYNETINPUT_H_ */')
    write('decomp/src/sys/netinput.h', header)

    # The Vita lifetime hooks are inseparable from its snapshots. Imports below
    # are from the pinned dependency verified above, not arbitrary branch HEAD.
    relative = 'decomp/src/ft/ftmain.c'
    text = read(relative)
    original = (VITA / 'src/ft/ftmain.c').read_text(encoding='utf-8')
    a, _, b = function_span(text, 'ftMainEjectHiddenPartID')
    c, _, d = function_span(original, 'ftMainEjectHiddenPartID')
    write(relative, '#include <sys/netrollback.h>\n#include <sys/netinput.h>\n' + text[:a] + original[c:d] + text[b:])
    relative = 'decomp/src/wp/wpmain.c'
    text = read(relative)
    _, a, _ = function_span(text, 'wpMainDestroyWeapon')
    text = text[:a+1] + '\n    if (syNetRollbackDeferObjectEject(weapon_gobj, wpGetStruct(weapon_gobj), TRUE)) return;\n' + text[a+1:]
    write(relative, '#include <sys/netrollback.h>\n' + text)
    relative = 'decomp/src/it/itmain.c'
    text = read(relative)
    # These guards diagnose truncated 64-bit host pointers. On wasm32 the
    # casted 4 GiB threshold was zero; express the intended width explicitly
    # instead of relying on truncation (and reading eight pointer bytes).
    low_guard = '    if ((uintptr_t)item_gobj < (uintptr_t)0x100000000ULL) {'
    assert low_guard in text
    text = text.replace(low_guard, '#if UINTPTR_MAX > UINT32_MAX\n' + low_guard, 1)
    text = text.replace('    if (item_gobj->obj_kind == 0xFE',
                        '#endif\n    if (item_gobj->obj_kind == 0xFE', 1)
    arrow_guard = '#ifdef PORT\n        /* PORT: observed in the wild on LP64'
    assert arrow_guard in text
    text = text.replace(arrow_guard, '#if defined(PORT) && UINTPTR_MAX > UINT32_MAX\n        /* PORT: observed in the wild on LP64', 1)
    _, a, b = function_span(text, 'itMainDestroyItem')
    part = text[a:b].replace('ITStruct *ip = itGetStruct(item_gobj);',
        'ITStruct *ip = itGetStruct(item_gobj);\n'
        '''    if (syNetRollbackDeferObjectEject(item_gobj, ip, FALSE)) {
        if (ip->is_hold && ip->owner_gobj) {
            ftGetStruct(ip->owner_gobj)->item_gobj = NULL;
            ftParamSetHammerParams(ip->owner_gobj);
        }
        return;
    }''')
    write(relative, '#include <sys/netrollback.h>\n' + text[:a] + part + text[b:])

    # This diagnostic receives an already resolved display-list pointer.
    # wasm32 allocations legitimately sit below its desktop brk threshold;
    # interpreting them as relocation tokens produces thousands of false
    # misses. Actual token resolution retains its generation validation.
    relative = 'decomp/src/sys/objdisplay.c'
    text = read(relative)
    _, opening, end = function_span(text, 'gcLogSuspiciousDLPointer')
    text = text[:opening+1] + '\n#if UINTPTR_MAX > UINT32_MAX' + text[opening+1:end-1] + '#endif\n' + text[end-1:]
    write(relative, text)

    hooks = {
        'sys/audio.c': {'syAudioPlayBGM':'-1', 'syAudioStopBGM':'', 'syAudioPlayFGM':'-1', 'syAudioStopFGM':''},
        'sys/controller.c': {'syControllerUpdateRumbleEvent':''},
        'ef/efmanager.c': {'efManagerMakeEffect':'NULL'},
        'lb/lbparticle.c': {'lbParticleMakeGenerator':'NULL'},
    }
    # The long-form particle constructor has a multiline declaration.
    particle = (VITA / 'src/lb/lbparticle.c').read_text(encoding='utf-8')
    before = particle[:particle.index('if (syNetRollbackIsResimulating()')]
    matches = re.findall(r'\b(lbParticle\w+)\s*\(', before)
    hooks['lb/lbparticle.c'][matches[-1]] = 'NULL'
    for relative, functions in hooks.items():
        text = read('decomp/src/' + relative)
        for name, result in functions.items():
            _, opening, _ = function_span(text, name)
            text = text[:opening+1] + '\n    if (syNetRollbackIsResimulating()) return ' + result + ';\n' + text[opening+1:]
        write('decomp/src/' + relative, '#include <sys/netrollback.h>\n' + text)
    relative = 'decomp/src/sys/objman.c'
    text = read(relative)
    start, opening, end = function_span(text, 'gcRunGObjProcess')
    body = text[opening:end].replace('case nGCProcessKindThread:',
        'case nGCProcessKindThread:\n        if (syNetRollbackIsResimulating()) break;')
    text = text[:opening] + body + text[end:]
    _, opening, _ = function_span(text, 'gcSetAObjPrevAlloc')
    text = text[:opening+1] + '\n    if (peak_rb_retire_aobj(aobj)) return;\n' + text[opening+1:]
    _, opening, _ = function_span(text, 'gcSetMObjPrevAlloc')
    text = text[:opening+1] + '\n    if (peak_rb_retire_material(mobj)) return;\n' + text[opening+1:]
    write(relative, '#include <sys/netrollback.h>\n#include <sys/objtypes.h>\nextern int peak_rb_retire_aobj(AObj*);\nextern int peak_rb_retire_material(MObj*);\n' + text)
    relative = 'decomp/src/sys/objhelper.c'
    text = read(relative)
    _, opening, _ = function_span(text, 'gcEjectAll')
    text = text[:opening+1] + '\n    peak_rb_scene_end();\n' + text[opening+1:]
    write(relative, '#include <sys/netrollback.h>\nextern void peak_rb_scene_end(void);\n' + text)
    # The browser session owns VS updates and controller edges. Invoke it from
    # the existing game coroutine so rendering still follows the normal loop.
    for relative, name, hook in [
        ('decomp/src/sc/sccommon/scvsbattle.c', 'scVSBattleFuncUpdate',
         'if (EM_ASM_INT({ return Module.peakAdvance && (!Module.peakNativeFlow || Module.peakHybridRollback) ? 1 : 0; })) {\n'
         '        extern void peak_rb_mode(int); peak_rb_mode(1);\n'
         '        extern void peak_rb_advance_battle(void); peak_rb_advance_battle();\n'
         '        return;\n    }'),
        ('decomp/src/sys/netinput.c', 'syNetInputFuncRead',
         'if (EM_ASM_INT({ return Module.peakAdvance ? 1 : 0; })) return;'),
    ]:
        text = read(relative)
        _, opening, _ = function_span(text, name)
        text = text[:opening+1] + '\n    ' + hook + '\n' + text[opening+1:]
        write(relative, '#include <emscripten.h>\n' + text)

    # Menus remain confirmed. Compatible native-flow builds use the battle
    # hook above with confirmation barriers; older builds confirm every scene.
    # Both paths preserve the original result/pause/rematch coroutine lifetimes.
    relative = 'decomp/src/sys/taskman.c'
    text = read(relative)
    text = text.replace('sb32 bool)', 'sb32 enabled)').replace('sSYTaskmanIsNoNearClipping = bool;', 'sSYTaskmanIsNoNearClipping = enabled;')
    pair = '\tsSYTaskmanFuncController();\n\ttfunc->scene_update();'
    if text.count(pair) != 2:
        raise ValueError('Missing pinned task update callbacks')
    text = text.replace(pair, '''
    if (EM_ASM_INT({ return Module.peakNativeFlow || Module.peakMenus ? 1 : 0; }) &&
        (EM_ASM_INT({ return Module.peakNativeFlow && !Module.peakHybridRollback ? 1 : 0; }) || tfunc->scene_update != scVSBattleFuncUpdate)) {
        peak_rb_mode(tfunc->scene_update == scVSBattleFuncUpdate);
        if (EM_ASM_INT({ return Module.peakAdvance() ? 1 : 0; })) {
            peak_rb_menu_input();
            tfunc->scene_update();
            EM_ASM({ Module.peakComplete(); });
        }
    } else {
        sSYTaskmanFuncController();
        tfunc->scene_update();
    }
''')
    _, opening, _ = function_span(text, 'syTaskmanStartTask')
    text = text[:opening+1] + '\n    peak_rb_scene_end();\n' + text[opening+1:]
    write(relative, '#include <emscripten.h>\nextern void peak_rb_scene_end(void);\nextern void scVSBattleFuncUpdate(void);\nextern void peak_rb_mode(int);\nextern void peak_rb_menu_input(void);\n' + text)
    relative = 'decomp/src/sys/utils.c'
    text = read(relative)
    for name, value in (('syUtilsRandTimeUChar', '(u8)syUtilsRandUShort()'),
                        ('syUtilsRandTimeFloat', 'syUtilsRandFloat()'),
                        ('syUtilsRandTimeUCharRange', 'syUtilsRandIntRange(range)')):
        _, opening, _ = function_span(text, name)
        text = text[:opening+1] + '\n    if (syNetInputModernNetplayActive()) return ' + value + ';\n' + text[opening+1:]
    write(relative, '#include <sys/netinput.h>\n' + text)

    # Controller edges must use the restored controller state, not the future
    # last_published entry left in netinput's diagnostic history after rewind.
    relative = 'decomp/src/sys/netinput.c'
    text = (SOURCE / relative).read_text(encoding='utf-8')
    text = text.replace('u16 prev_buttons = (last_published->is_valid != FALSE) ? last_published->buttons : 0;',
                        'u16 prev_buttons = gSYControllerDevices[player].button_hold;')
    write(relative, text)
    # The original battle timer follows VI/wall-clock ticks, which also advance
    # while waiting for remote input. Network games count simulation ticks.
    relative = 'decomp/src/if/ifcommon.c'
    text = read(relative).replace('time_update = sySchedulerGetTicCount();',
        'time_update = syNetInputModernNetplayActive() ? sIFCommonTimerStamp + 1 : sySchedulerGetTicCount();')
    _, start, _ = function_span(text, 'ifCommonAnnounceEndMessage')
    text = text[:start+1] + '\n    if (syNetInputModernNetplayActive() && !peak_rb_native_flow() && peak_rb_in_battle()) { gSCManagerBattleState->game_status = nSCBattleGameStatusEnd; return; }\n' + text[start+1:]
    # Stop before coroutine/scene side effects. The scheduler restores this
    # frame and retries it with confirmed inputs in the original coroutine.
    for name in ('ifCommonAnnounceEndMessage', 'ifCommonAnnounceTimeUpInitInterface'):
        _, opening, _ = function_span(text, name)
        text = text[:opening+1] + '\n    if (peak_rb_defer_transition()) { gSCManagerBattleState->game_status = nSCBattleGameStatusEnd; return; }\n' + text[opening+1:]
    _, opening, _ = function_span(text, 'ifCommonBattleGoUpdateInterface')
    text = text[:opening+1] + '''
    for (int i = 0; i < 4; ++i) {
        if ((gSYControllerDevices[i].button_tap & START_BUTTON) && peak_rb_defer_transition()) return;
    }
''' + text[opening+1:]
    start, opening, end = function_span(text, 'ifCommonTimerFuncRun')
    body = text[opening:end].replace('ifGetProc(interface_gobj)();',
        'if (peak_rb_defer_transition()) return;\n                            ifGetProc(interface_gobj)();')
    text = text[:opening] + body + text[end:]
    # Damage-number breakup is cosmetic and its UI animation is not rewound.
    # Letting it consume gameplay RNG changes later spawns after a correction.
    for name in ('ifCommonPlayerDamageUpdateAnim', 'ifCommonPlayerDamageStartBreakAnim'):
        _, opening, end = function_span(text, name)
        body = text[opening:end].replace('syUtilsRandIntRange(', 'peak_visual_rand_range(').replace('syUtilsRandFloat(', 'peak_visual_rand_float(')
        text = text[:opening] + body + text[end:]
    write(relative, '#include <sys/netinput.h>\nextern f32 peak_visual_rand_float(void);\nextern s32 peak_visual_rand_range(s32);\nextern int peak_rb_defer_transition(void);\nextern int peak_rb_in_battle(void);\nextern int peak_rb_native_flow(void);\n' + text)
    # Hyrule's tornado creates/destroys a ground GObj whose allocation lifetime
    # is not retained. Native flow commits those rare events in the coroutine;
    # ordinary movement and obstacle registrations are captured and replayable.
    relative = 'decomp/src/gr/grcommon/grhyrule.c'
    text = read(relative)
    for name in ('grHyruleTwisterUpdateWait', 'grHyruleTwisterUpdateSummon', 'grHyruleTwisterUpdateSubside'):
        _, opening, _ = function_span(text, name)
        text = text[:opening+1] + '\n    if (gGRCommonStruct.hyrule.twister_wait == 1 && peak_rb_defer_transition()) return;\n' + text[opening+1:]
    text = text.replace('    gGRCommonStruct.hyrule.twister_status = nGRHyruleTwisterStatusSubside;',
        '    if (peak_rb_defer_transition()) return;\n    gGRCommonStruct.hyrule.twister_status = nGRHyruleTwisterStatusSubside;')
    write(relative, 'extern int peak_rb_defer_transition(void);\n' + text)
    # Restore the original entry path: egg effects now participate in snapshots.
    relative = 'decomp/src/ft/ftcommon/ftcommoncaptureyoshi.c'
    write(relative, read(relative))
    relative = 'decomp/src/ef/efmanager.c'
    text = (SOURCE / relative).read_text(encoding='utf-8')
    text = text.replace('if (syNetRollbackIsResimulating()) return NULL;',
        'if (syNetRollbackIsResimulating() && effect_desc != &dEFManagerYoshiEggLayEffectDesc) return NULL;')
    text = text.replace('ep = efManagerGetNextStructAlloc(is_force_return);',
        'ep = effect_desc == &dEFManagerYoshiEggLayEffectDesc ? peak_rb_alloc_egg_effect() : efManagerGetNextStructAlloc(is_force_return);')
    _, opening, _ = function_span(text, 'efManagerSetPrevStructAlloc')
    text = text[:opening+1] + '\n    if (peak_rb_release_egg_effect(ep)) return;\n' + text[opening+1:]
    _, opening, end = function_span(text, 'efManagerYoshiEggLayMakeEffect')
    body = text[opening:end].replace('    return effect_gobj;',
        '    peak_rb_track_egg(effect_gobj);\n    return effect_gobj;')
    write(relative, 'struct GObj;\nstruct EFStruct;\nextern void peak_rb_track_egg(struct GObj*);\n'
        'extern struct EFStruct *peak_rb_alloc_egg_effect(void);\nextern int peak_rb_release_egg_effect(struct EFStruct*);\n'
        + text[:opening] + body + text[end:])
    relative = 'decomp/src/ft/ftparam.c'
    text = read(relative)
    _, opening, _ = function_span(text, 'ftParamStopEffect')
    text = text[:opening+1] + '\n    if (peak_rb_retire_egg(effect_gobj)) return;\n' + text[opening+1:]
    text = text.replace('if ((ep != NULL) && (fighter_gobj == ep->fighter_gobj))',
        'if ((ep != NULL) && !peak_rb_dead_egg(effect_gobj) && (fighter_gobj == ep->fighter_gobj))')
    write(relative, 'struct GObj;\nextern int peak_rb_retire_egg(struct GObj*);\nextern int peak_rb_dead_egg(struct GObj*);\n' + text)
    relative = 'decomp/src/ft/ftmain.c'
    text = (SOURCE / relative).read_text(encoding='utf-8')
    old = 'lbRelocGetForceExternHeapFile(motion_desc->anim_file_id, (void*) fp->figatree_heap);\n            fp->figatree = fp->figatree_heap;'
    if old not in text:
        raise ValueError('Missing pinned fighter animation load')
    text = text.replace(old, 'fp->figatree = peak_rb_animation(motion_desc->anim_file_id, (void*) fp->figatree_heap);')
    write(relative, '#include <ssb_types.h>\nextern void *peak_rb_animation(u32, void*);\n' + text)
    # Deferred destruction must behave as immediate removal to collision, AI,
    # pickup and camera searches, while retaining memory for older snapshots.
    for relative in ('ft/ftmain.c', 'ft/ftcomputer.c', 'ft/ftcommon/ftcommonget.c',
                     'wp/wpprocess.c', 'it/itprocess.c', 'gm/gmcamera.c'):
        path = 'decomp/src/' + relative
        text = (SOURCE / path).read_text(encoding='utf-8') if relative == 'ft/ftmain.c' else read(path)
        pattern = r'(while\s*\(\s*(weapon_gobj|item_gobj|other_gobj)\s*!=\s*NULL\s*\)\s*\{)'
        text, count = re.subn(pattern, lambda match: match[0] + '\n        if (peak_rb_object_dead(' + match[2] + ')) { ' + match[2] + ' = ' + match[2] + '->link_next; continue; }', text)
        if not count:
            raise ValueError('Missing pinned object traversal in ' + path)
        write(path, '#include <ssb_types.h>\nstruct GObj;\nextern sb32 peak_rb_object_dead(struct GObj*);\n' + text)
    from prepare_effects import prepare_effects
    prepare_effects(SOURCE, read, write, function_span)
    visual_rng = ('#define syUtilsRandFloat peak_visual_rand_float\n'
                  '#define syUtilsRandUShort peak_visual_rand_ushort\n'
                  '#define syUtilsRandIntRange peak_visual_rand_range\n')
    for path in [*(SOURCE / 'decomp/src/ef').glob('*.c'), SOURCE / 'decomp/src/lb/lbparticle.c']:
        relative = path.relative_to(SOURCE).as_posix()
        # Retain the replay suppression already generated above.
        text = path.read_text(encoding='utf-8') if relative in ('decomp/src/ef/efmanager.c', 'decomp/src/lb/lbparticle.c') else read(relative)
        write(relative, visual_rng + text)

    # The pinned browser source places this WASM hint inside an Android-only
    # block, where it never runs. SDL otherwise performs an Asyncify sleep on
    # every swap in addition to our main-loop rAF wait. Keep the one browser
    # pacing point and preserve the original coroutine scheduling.
    relative = 'port/port.cpp'
    text = read(relative)
    hint = '\tSDL_SetHint("SDL_EMSCRIPTEN_ASYNCIFY", "0");'
    if text.count(hint) != 1:
        raise ValueError('Missing pinned SDL Asyncify hint')
    text = text.replace(hint, '\t/* Browser hint is applied below, outside this Android-only block. */')
    marker = '\t// Wrap post-init (game boot + main loop + shutdown) in a top-level'
    if text.count(marker) != 1:
        raise ValueError('Missing pinned browser initialization boundary')
    text = text.replace(marker, '#ifdef __EMSCRIPTEN__\n'
        '\tSDL_SetHint("SDL_EMSCRIPTEN_ASYNCIFY", "0");\n'
        '#endif\n\n' + marker)
    write(relative, text)

    # Keep the startup item fixture independent of weighted gameplay drops.
    # Forcing every weighted choice to 'crate' can make broken crates spawn
    # more crates, bypassing the normal utility-item weights and RNG entirely.
    relative = 'decomp/src/it/itmanager.c'
    # Compose with prepare_effects' pool initialization above; reading the
    # pinned original here would silently remove that determinism fix.
    text = (SOURCE / relative).read_text(encoding='utf-8')
    if 'memset(new_item, 0, sizeof(ITStruct))' not in text:
        raise ValueError('Missing deterministic item-pool initialization')
    start, opening, end = function_span(text, 'itPortGetPreviewKind')
    body = text[opening:end]
    old = 'const char *env = getenv("SSB64_FORCE_ITEM_KIND");'
    if body.count(old) != 1:
        raise ValueError('Missing pinned preview item kind')
    body = body.replace(old, 'const char *env = getenv("SSB64_PREVIEW_ITEM_KIND");\n'
        '    if (!env) env = getenv("SSB64_FORCE_ITEM_KIND");')
    write(relative, text[:opening] + body + text[end:])

    # Browser assets are extracted by the separate Torch WASM module. Avoid
    # building/copying a native executable that cannot run in the browser.
    cmake = read('CMakeLists.txt')
    cmake = cmake.replace('add_dependencies(${PROJECT_NAME} libultraship TorchExternal)\n',
                          'add_dependencies(${PROJECT_NAME} libultraship)\n')
    copy_torch = '''        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${TORCH_EXECUTABLE}
            $<TARGET_FILE_DIR:${PROJECT_NAME}>/${TORCH_SIDECAR_NAME}
'''
    if copy_torch not in cmake:
        raise ValueError('Missing Torch sidecar copy in pinned CMake source')
    cmake = cmake.replace(copy_torch, '')
    # Offset conversion is built in on the Linux SDK (4.0.18); the upstream
    # version check incorrectly assumes the old setting lasts until 6.x.
    cmake = cmake.replace('        target_link_options(${PROJECT_NAME} PRIVATE -sUSE_OFFSET_CONVERTER=1)', '')
    write('CMakeLists.txt', cmake)
    print('Prepared Smash snapshot exports and lifecycle hooks; artifacts have not been published.')


if __name__ == '__main__':
    main()
