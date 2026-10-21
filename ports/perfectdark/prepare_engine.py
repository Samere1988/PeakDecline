"""Adapt the pinned port's loop to optional synchronous single-tick execution."""
from pathlib import Path


def patch(root: Path):
    def edit(name, old, new):
        path = root / name
        text = path.read_text(encoding='utf-8')
        if text.count(old) != 1:
            raise RuntimeError(f'Perfect Dark source marker changed: {name}: {old[:90]}')
        path.write_text(text.replace(old, new), encoding='utf-8')

    # Native code discards these handlers' return value through a void alias.
    # WASM checks the complete indirect-call signature, including return type.
    # Both label/selection colour callbacks actually return MenuItemHandlerResult.
    path = root / 'src/game/menuitem.c'
    text = path.read_text(encoding='utf-8')
    old = 'context->item->handlervoid(MENUOP_GETCOLOUR, context->item, &data);'
    if text.count(old) != 2:
        raise RuntimeError('Perfect Dark menu colour callback markers changed.')
    path.write_text(text.replace(old, 'context->item->handler(MENUOP_GETCOLOUR, context->item, &data);'), encoding='utf-8')

    for name in ('port/src/main.c', 'port/src/pdmain.c', 'port/src/pdsched.c',
                 'port/src/input.c', 'port/src/libultra.c', 'src/game/timing.c', 'src/game/bondmove.c',
                 'src/game/prop.c', 'src/game/varsreset.c', 'src/game/bondgun.c',
                 'src/game/player.c', 'src/game/propobj.c', 'src/game/explosions.c', 'port/src/video.c'):
        path = root / name
        path.write_text('#include "peak_pd.h"\n' + path.read_text(encoding='utf-8'), encoding='utf-8')
    edit('src/game/varsreset.c', '\tg_Vars.freeprops = g_Vars.props;',
         '\tg_Vars.freeprops = g_Vars.props;\n\tpeakPdResetEntities();')
    edit('src/game/prop.c', '\t\treturn prop;\n\t}\n\n\treturn NULL;',
         '\t\tpeakPdAllocateEntity(prop);\n\t\treturn prop;\n\t}\n\n\treturn NULL;')
    edit('src/game/prop.c', 'void propFree(struct prop *prop)\n{',
         'void propFree(struct prop *prop)\n{\n\tpeakPdFreeEntity(prop);')
    edit('src/game/bondgun.c', '\tif (hand->firing) {\n\t\tbool playsound = false;',
         '\tif (hand->firing) {\n\t\tbool playsound = false;\n'
         '\t\tif (hand->shotstotake > 0) peakPdEvent(1, g_Vars.currentplayernum, g_Vars.currentplayer->prop, hand->gset.weaponnum, handnum, hand->shotstotake);')
    # These paths do not use firearm shotstotake. Emit only when the native
    # attack actually executes, and only after a thrown object was allocated.
    # The `true` call is an avoidance query before the strike, not an attack.
    edit('src/game/prop.c', '\t\t\thandInflictMeleeDamage(handnum, &gset, false);',
         '\t\t\thandInflictMeleeDamage(handnum, &gset, false);\n'
         '\t\t\tpeakPdEvent(6, g_Vars.currentplayernum, g_Vars.currentplayer->prop, weaponnum, handnum, 1);')
    edit('src/game/bondgun.c',
         '\tobj = bgunCreateThrownProjectile2(g_Vars.currentplayer->prop->chr, gset, &spawnpos, spawnrooms, &sp1f4, &velocity);\n\n\tif (obj) {',
         '\tobj = bgunCreateThrownProjectile2(g_Vars.currentplayer->prop->chr, gset, &spawnpos, spawnrooms, &sp1f4, &velocity);\n\n\tif (obj) {\n'
         '\t\tpeakPdEvent(7, g_Vars.currentplayernum, obj->prop, gset->weaponnum, handnum < 2 ? handnum : -1, 1);')
    edit('src/game/propobj.c', '\tif (result == TICKOP_FREE && (obj->hidden & OBJHFLAG_TAGGED) == 0) {',
         '\tif (result != TICKOP_NONE) peakPdEvent(2, g_Vars.currentplayernum, prop, obj->type, -1, 1);\n\n'
         '\tif (result == TICKOP_FREE && (obj->hidden & OBJHFLAG_TAGGED) == 0) {')
    edit('src/game/player.c', '\t\tg_Vars.currentplayer->isdead = true;\n\t\tg_Vars.currentplayer->bonddie',
         '\t\tg_Vars.currentplayer->isdead = true;\n'
         '\t\tpeakPdEvent(3, g_Vars.currentplayernum, g_Vars.currentplayer->prop, shooter, -1, 1);\n\t\tg_Vars.currentplayer->bonddie')
    edit('src/game/player.c', '\t\tg_Vars.currentplayer->prop->chr->chrflags &= ~CHRCFLAG_HIDDEN;\n\t}\n}\n\nvoid playerLoadDefaults',
         '\t\tg_Vars.currentplayer->prop->chr->chrflags &= ~CHRCFLAG_HIDDEN;\n\t}\n'
         '\tpeakPdEvent(4, g_Vars.currentplayernum, g_Vars.currentplayer->prop, 0, -1, 1);\n}\n\nvoid playerLoadDefaults')
    edit('src/game/explosions.c', '\t\t\texplosionAlertChrs(&g_ExplosionTypes[type].rangeh, exppos);',
         '\t\t\tif (type != EXPLOSIONTYPE_BULLETHOLE) peakPdEvent(5, playernum, exp->prop, type, -1, 1);\n'
         '\t\t\texplosionAlertChrs(&g_ExplosionTypes[type].rangeh, exppos);')
    edit('port/src/main.c', 'sysInitArgs(argc, argv);',
         'sysInitArgs(argc, argv);\n\tg_PeakPdControlled = sysArgCheck("--peak-controlled");')
    edit('port/src/pdmain.c', '\twhile (true) {\n\t\tmainLoop();',
         '\tif (g_PeakPdControlled) {\n\t\tmainLoop();\n\t\tg_PeakPdReady = 1;\n\t\treturn;\n\t}\n\n\twhile (true) {\n\t\tmainLoop();')
    edit('port/src/pdmain.c', '\tfunc0f175f98();\n',
         '\tstatic s32 peakInitialized = false;\n\tstatic s32 peakStageActive = false;\n'
         '\tif (!g_PeakPdControlled || !peakInitialized) {\n\tpeakInitialized = true;\n\tfunc0f175f98();\n')
    edit('port/src/pdmain.c', '\trngSetSeed(osGetCount());',
         '\trngSetSeed(g_PeakPdControlled ? g_PeakPdSeed : osGetCount());\n\t}')
    edit('port/src/pdmain.c', '\twhile (!ending) {\n\t\tg_MainNumGfxTasks',
         '\twhile (!ending) {\n\t\tif (!g_PeakPdControlled || !peakStageActive) {\n\t\tpeakStageActive = true;\n\t\tg_MainNumGfxTasks')
    edit('port/src/pdmain.c', '\t\tprofileReset();\n\n\t\twhile (g_MainChangeToStageNum < 0) {',
         '\t\tprofileReset();\n\t\t}\n\n\t\twhile (g_MainChangeToStageNum < 0) {\n'
         '\t\t\tif (g_PeakPdControlled) {\n'
         '\t\t\t\tif (!g_PeakPdStepBudget) return;\n'
         '\t\t\t\tpeakPdBeginTick();\n'
         '\t\t\t\tschedStartFrame(&g_Sched);\n\t\t\t\tmainTick();\n\t\t\t\tschedEndFrame(&g_Sched);\n'
         '\t\t\t\t--g_PeakPdStepBudget;\n'
         '\t\t\t\tif (g_MainChangeToStageNum < 0) return;\n\t\t\t\tbreak;\n\t\t\t}')
    edit('port/src/pdmain.c', '\t\tg_MainChangeToStageNum = -1;\n', '\t\tg_MainChangeToStageNum = -1;\n\t\tpeakStageActive = false;\n')
    edit('src/game/timing.c', 'void frametimeCalculate(void)\n{',
         'void frametimeCalculate(void)\n{\n'
         '\tif (g_PeakPdControlled) {\n'
         '\t\tu32 count = (u32)peakPdClock();\n'
         '\t\tu32 elapsed = count - g_Vars.thisframestartt;\n'
         '\t\tg_Vars.diffframet = elapsed;\n'
         '\t\tg_Vars.lostframetime60t = g_Vars.lostframetime240t = 0;\n'
         '\t\tg_Vars.mininc60 = 1;\n'
         '\t\tframetimeApply(elapsed / CYCLES_PER_FRAME, elapsed / (CYCLES_PER_FRAME / 4), count);\n'
         '\t\treturn;\n\t}')
    edit('port/src/libultra.c', 'OSTime osGetTime(void)\n{',
         'OSTime osGetTime(void)\n{\n\tif (g_PeakPdControlled) return peakPdClock();')
    edit('port/src/input.c', 's32 inputMouseIsEnabled(void)\n{\n\treturn mouseEnabled;',
         's32 inputMouseIsEnabled(void)\n{\n\treturn g_PeakPdControlled ? 0 : mouseEnabled;')
    # The shared FPS collector owns pointer lock in controlled sessions. Native
    # menu/gameplay transitions must not issue competing browser lock requests.
    edit('port/src/input.c', 'void inputLockMouse(s32 lock)\n{',
         'void inputLockMouse(s32 lock)\n{\n\tif (g_PeakPdControlled) { mouseLocked = 0; return; }')
    # A display refresh reuses the finished command list, never lvRender's
    # gameplay work. Controlled presentation preserves original matrices.
    edit('port/src/video.c', '\t\t\tvidReplayCommands = NULL;\n\t\t}\n#endif\n\t\tgfx_run(cmds);',
         '\t\t\tvidReplayCommands = g_PeakPdControlled ? cmds : NULL;\n\t\t}\n#endif\n\t\tgfx_run(cmds);')
    edit('port/src/video.c', 'if (!initDone || !vidDecoupledRendering || !vidReplayCommands)',
         'if (!initDone || (!vidDecoupledRendering && !g_PeakPdControlled) || !vidReplayCommands)')
    edit('port/src/video.c', '\tgfx_set_frame_interpolation(true, false, alpha, (uintptr_t)g_VtxBuffers[0],\n\t\t\t(u32)(g_VtxBuffers[1] - g_VtxBuffers[0]));',
         '\tif (g_PeakPdControlled) gfx_reset_frame_interpolation();\n'
         '\telse gfx_set_frame_interpolation(true, false, alpha, (uintptr_t)g_VtxBuffers[0],\n\t\t\t(u32)(g_VtxBuffers[1] - g_VtxBuffers[0]));')
    # Keep native display-list generation intact; only omit GPU submission for
    # an authority/replay engine that does not need to display every tick.
    # Frame start/end still update dimensions, used by native visibility logic.
    for signature in ('void videoSubmitCommands(Gfx *cmds)',):
        edit('port/src/video.c', signature + '\n{',
             signature + '\n{\n\tif (g_PeakPdControlled && !g_PeakPdPresentation) return;')
    edit('port/src/input.c', 's32 inputKeyPressed(u32 vk)\n{',
         's32 inputKeyPressed(u32 vk)\n{\n\tif (g_PeakPdControlled) return 0;')
    edit('port/src/input.c', 's32 inputReadController(s32 idx, OSContPad *npad)\n{',
         's32 inputReadController(s32 idx, OSContPad *npad)\n{\n\tif (g_PeakPdControlled && npad) return peakPdReadPad(idx, npad);')
    edit('port/src/input.c', 's32 inputControllerConnected(s32 idx)\n{',
         's32 inputControllerConnected(s32 idx)\n{\n\tif (g_PeakPdControlled) return idx >= 0 && idx < 4 && (peakPdControllerMask() & (1 << idx));')
    edit('port/src/input.c', 's32 inputControllerMask(void)\n{\n\treturn connectedMask;', 's32 inputControllerMask(void)\n{\n\treturn g_PeakPdControlled ? peakPdControllerMask() : connectedMask;')
    edit('port/src/input.c', 'void inputMouseGetScaledDelta(f32* dx, f32* dy)\n{',
         'void inputMouseGetScaledDelta(f32* dx, f32* dy)\n{\n\tif (g_PeakPdControlled) { peakPdLook(dx, dy); return; }')
    edit('src/game/bondmove.c', '(g_Vars.currentplayernum == 0) && (allowc1x || allowc1y)',
         '(g_PeakPdControlled || g_Vars.currentplayernum == 0) && (allowc1x || allowc1y)')
    edit('src/game/bondmove.c', 'if (inputKeyJustPressed(VK_ESCAPE))', 'if (!g_PeakPdControlled && inputKeyJustPressed(VK_ESCAPE))')
    # Poll controlled input once before simulation, not again after consuming it.
    edit('port/src/pdsched.c', '\tinputUpdate();\n\n\tjoyStartReadData(&g_PiMesgQueue);\n\tjoyReadData();\n\tjoy00014238();',
         '\tif (!g_PeakPdControlled) {\n\t\tinputUpdate();\n\t\tjoyStartReadData(&g_PiMesgQueue);\n\t\tjoyReadData();\n\t\tjoy00014238();\n\t}')
    # A JS-driven step must never suspend inside a framerate limiter.
    cpp = root / 'port/fast3d/gfx_sdl2.cpp'
    cpp.write_text('extern \"C\" int g_PeakPdControlled;\n' + cpp.read_text(encoding='utf-8'), encoding='utf-8')
    edit('port/fast3d/gfx_sdl2.cpp', '    if (target_fps) {\n        sync_framerate_with_timer();',
         '    if (target_fps && !g_PeakPdControlled) {\n        sync_framerate_with_timer();')
