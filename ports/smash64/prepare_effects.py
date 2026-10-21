"""Pinned-source adapters for gameplay-linked effects and cosmetic RNG isolation."""

# Every model effect whose constructor attaches to a fighter or stores an owner
# pointer in fighter/weapon state. Particle-only inhale is handled separately.
REPLAY_EFFECTS = (
    'FireSpark', 'FoxReflector', 'Shield', 'YoshiShield', 'SamusGrappleBeam',
    'CaptainFalconKick', 'CaptainFalconPunch', 'PurinSing',
    'KirbyCutterUp', 'KirbyCutterDown', 'KirbyCutterDraw', 'KirbyCutterTrail',
    'NessPsychicMagnet', 'NessPKThunderTrail', 'NessPKReflectTrail',
    'NessPKThunderWave', 'YoshiEggEscape', 'LinkSpinAttack',
    'CaptureKirbyStar', 'RebirthHalo', 'PikachuThunderShock', 'MBallRays',
)


def prepare_effects(source, read, write, span):
    path = 'decomp/src/lb/lbcommon.c'
    text = read(path)
    _, opening, end = span(text, 'lbCommonEjectTreeDObj')
    body = text[opening:end].replace('gcEjectDObj(dobj);',
        'if (!peak_rb_retire_item_root(dobj)) gcEjectDObj(dobj);')
    write(path, 'struct DObj;\nextern int peak_rb_retire_item_root(struct DObj*);\n' + text[:opening] + body + text[end:])
    path = 'decomp/src/if/ifcommon.c'
    text = (source / path).read_text()
    marker = '    if ((ip->is_allow_pickup) && (ip->arrow_timer >= 15))'
    assert text.count(marker) == 1
    text = text.replace(marker, '    if (peak_rb_object_dead(ip->item_gobj)) return;\n' + marker)
    write(path, 'struct GObj;\nextern int peak_rb_object_dead(struct GObj*);\n' + text)
    # Constructors initialize only the fields they use immediately. A replay
    # changes pool reuse, so even unused collision fields must start identically.
    for path, kind, head, name in [
        ('decomp/src/wp/wpmanager.c', 'WPStruct', 'sWPManagerStructsAllocFree', 'new_weapon'),
        ('decomp/src/it/itmanager.c', 'ITStruct', 'gITManagerStructsAllocFree', 'new_item'),
    ]:
        text = read(path)
        marker = head + ' = ' + name + '->next;'
        assert text.count(marker) == 1
        text = text.replace(marker, marker + '\n    if (syNetInputModernNetplayActive()) memset(' + name + ', 0, sizeof(' + kind + '));')
        write(path, '#include <string.h>\n#include <sys/netinput.h>\n' + text)
    path = 'decomp/src/ef/efmanager.c'
    text = (source / path).read_text()
    selector = '\nstatic int peak_replay_effect(EFDesc *desc) {\n    return ' + ' ||\n        '.join(
        'desc == &dEFManager' + name + 'EffectDesc' for name in REPLAY_EFFECTS) + ';\n}\n'
    start, opening, end = span(text, 'efManagerMakeEffect')
    body = text[opening:end]
    body = body.replace('effect_desc != &dEFManagerYoshiEggLayEffectDesc)',
                        'effect_desc != &dEFManagerYoshiEggLayEffectDesc && !peak_replay_effect(effect_desc))')
    body = body.replace(': efManagerGetNextStructAlloc(is_force_return);',
                        ': (peak_replay_effect(effect_desc) ? peak_rb_alloc_effect(is_force_return) : efManagerGetNextStructAlloc(is_force_return));')
    body = body.replace('return effect_gobj;', 'if (peak_replay_effect(effect_desc)) peak_rb_track_effect(effect_gobj);\n    return effect_gobj;')
    text = text[:start] + selector + text[start:opening] + body + text[end:]
    _, opening, _ = span(text, 'efManagerSetPrevStructAlloc')
    text = text[:opening+1] + '\n    if (peak_rb_release_effect(ep)) return;\n' + text[opening+1:]
    _, opening, end = span(text, 'efManagerQuakeMakeEffect')
    body = text[opening:end].replace('ep = efManagerGetEffectNoForce();', 'ep = peak_rb_alloc_effect(FALSE);')
    body = body.replace('if (effect_gobj == NULL)\n    {\n        return NULL;',
                        'if (effect_gobj == NULL)\n    {\n        efManagerSetPrevStructAlloc(ep);\n        return NULL;')
    body = body.replace('    return effect_gobj;', '    peak_rb_track_effect(effect_gobj);\n    return effect_gobj;')
    text = text[:opening] + body + text[end:]
    _, opening, _ = span(text, 'efManagerKirbyInhaleWindProcUpdate')
    text = text[:opening+1] + '\n    if (!efGetStruct(effect_gobj)->xf) return;\n' + text[opening+1:]
    # A particle constructor should not allocate an orphan GObj on replay or
    # allocation failure. Its command is consumed independently below.
    _, opening, end = span(text, 'efManagerKirbyInhaleWindMakeEffect')
    body = text[opening:end]
    body = body.replace('{', '{\n    if (syNetRollbackIsResimulating()) return NULL;', 1)
    body = body.replace('if (xf->users_num == 0)\n            {\n                return NULL;',
                        'if (xf->users_num == 0)\n            {\n                return efManagerDestroyParticleGObj(NULL, effect_gobj);')
    body = body.replace('    return pc;', '    if (!pc) return efManagerDestroyParticleGObj(NULL, effect_gobj);\n    return pc;')
    text = text[:opening] + body + text[end:]
    write(path, 'struct GObj; struct EFStruct;\nextern struct EFStruct *peak_rb_alloc_effect(int);\n'
          'extern int peak_rb_release_effect(struct EFStruct*);\nextern void peak_rb_track_effect(struct GObj*);\n' + text)
    path = 'decomp/src/sys/objman.c'
    text = (source / path).read_text()
    _, opening, _ = span(text, 'gcEjectGObj')
    text = text[:opening+1] + '\n    if (peak_rb_retire_effect(gobj ? gobj : gGCCurrentCommon)) return;\n' + text[opening+1:]
    write(path, 'struct GObj;\nextern int peak_rb_retire_effect(struct GObj*);\n' + text)
    path = 'decomp/src/ft/ftparam.c'
    text = (source / path).read_text()
    text = text.replace('if (peak_rb_retire_egg(effect_gobj))',
                        'if (peak_rb_retire_egg(effect_gobj) || peak_rb_retire_effect(effect_gobj))')
    text = text.replace('!peak_rb_dead_egg(effect_gobj)',
                        '!peak_rb_dead_egg(effect_gobj) && !peak_rb_dead_effect(effect_gobj)')
    write(path, 'struct GObj;\nextern int peak_rb_retire_effect(struct GObj*);\nextern int peak_rb_dead_effect(struct GObj*);\n' + text)
    path = 'decomp/src/ft/ftchar/ftkirby/ftkirbyspecialn.c'
    text = read(path)
    text = text.replace('if (efManagerKirbyInhaleWindMakeEffect(fighter_gobj) != NULL)',
        'if ((efManagerKirbyInhaleWindMakeEffect(fighter_gobj) != NULL) || syNetInputModernNetplayActive())')
    write(path, '#include <sys/netinput.h>\n' + text)
    path = 'decomp/src/gr/grcommon/grhyrule.c'
    text = (source / path).read_text()
    text = text.replace('if (pc == NULL)\n        {', 'if (pc == NULL && !syNetInputModernNetplayActive())\n        {')
    text = text.replace('gGRCommonStruct.hyrule.twister_xf = pc->xf;', 'gGRCommonStruct.hyrule.twister_xf = pc ? pc->xf : NULL;')
    text = text.replace('gGRCommonStruct.hyrule.twister_xf->translate = *pos;',
        'if (gGRCommonStruct.hyrule.twister_xf) gGRCommonStruct.hyrule.twister_xf->translate = *pos;')
    # The original stage leaves a dangling tornado GObj after subsiding. Pool
    # reuse can turn it into an unrelated item/effect; the stage digest then
    # reads that object's animation. Clear the owner at the actual destruction.
    marker = 'gcEjectGObj(gGRCommonStruct.hyrule.twister_gobj);'
    assert text.count(marker) == 1
    text = text.replace(marker, marker + '\n    gGRCommonStruct.hyrule.twister_gobj = NULL;')
    write(path, '#include <sys/netinput.h>\n' + text)
    path = 'decomp/src/lb/lbparticle.c'
    text = (source / path).read_text()
    _, opening, _ = span(text, 'lbParticleEjectTransform')
    text = text[:opening+1] + '\n    peak_rb_forget_transform(xf);\n' + text[opening+1:]
    write(path, 'struct LBTransform;\nextern void peak_rb_forget_transform(struct LBTransform*);\n' + text)
    path = 'decomp/src/ft/ftcommon/ftcommoncapturekirby.c'
    text = read(path)
    old = 'if (efManagerStarSplashMakeEffect(&DObjGetStruct(fighter_gobj)->translate.vec.f, (-fp->physics.vel_air.x < 0.0F) ? -1 : +1) != NULL)'
    assert text.count(old) == 2
    text = text.replace(old, old[:-1] + ' || syNetInputModernNetplayActive())')
    write(path, '#include <sys/netinput.h>\n' + text)
    # Debris constructors consume randomness only if cosmetic allocation works.
    # They must never advance the gameplay stream (including the forward path).
    for path, func in [('decomp/src/it/itcommon/itbox.c', 'itBoxContainerSmashMakeEffect'),
                       ('decomp/src/it/itground/ittarubomb.c', 'itTaruBombContainerSmashMakeEffect')]:
        text = read(path)
        _, opening, end = span(text, func)
        text = text[:opening] + text[opening:end].replace('syUtilsRandFloat(', 'peak_visual_rand_float(') + text[end:]
        write(path, '#include <ssb_types.h>\nextern f32 peak_visual_rand_float(void);\n' + text)
