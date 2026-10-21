// Explicit scalar layout. Audio, model, cache and allocator pointers stay local.
#define PEAK_WEAPON_FIELDS(X) \
    X(0, gset.weaponfunc, 1, 0, 1) \
    X(1, gset.unk0639, 1, 0, 255) \
    X(2, gset.unk063a, 1, 0, 255) \
    X(3, firing, 1, 0, 1) \
    X(4, flashon, 1, 0, 1) \
    X(5, gunon, 1, 0, 1) \
    X(6, visible, 1, 0, 1) \
    X(7, triggeron, 1, 0, 1) \
    X(8, triggerprev, 1, 0, 1) \
    X(9, triggerreleased, 1, 0, 1) \
    X(10, useposrot, 1, 0, 1) \
    X(11, slideinc, 1, 0, 1) \
    X(12, firedrocket, 1, 0, 1) \
    X(13, lastdirvalid, 1, 0, 1) \
    X(14, count, 1, -2147483648, 2147483647) \
    X(15, count60, 1, -2147483648, 2147483647) \
    X(16, pausetime60, 1, -2147483648, 2147483647) \
    X(17, allowshootframe, 1, -2147483648, 2147483647) \
    X(18, lastshootframe60, 1, -2147483648, 2147483647) \
    X(19, burstbullets, 1, -2147483648, 2147483647) \
    X(20, shotstotake, 1, -2147483648, 2147483647) \
    X(21, stateframes, 1, -2147483648, 2147483647) \
    X(22, statecycles, 1, -2147483648, 2147483647) \
    X(23, statelastframe, 1, -2147483648, 2147483647) \
    X(24, gs_int1, 1, -2147483648, 2147483647) \
    X(25, gs_int2, 1, -2147483648, 2147483647) \
    X(26, gs_int3, 1, -2147483648, 2147483647) \
    X(27, gs_int4, 1, -2147483648, 2147483647) \
    X(28, statevar1, 1, -2147483648, 2147483647) \
    X(29, ispare1, 1, -2147483648, 2147483647) \
    X(30, mode, 1, 0, 4294967295) \
    X(31, modenext, 1, 0, 4294967295) \
    X(32, numfires, 1, 0, 4294967295) \
    X(33, numshotguncarts, 1, 0, 4294967295) \
    X(34, refiretime, 1, 0, 4294967295) \
    X(35, typechange, 1, 0, 4294967295) \
    X(36, pausechange, 1, 0, 4294967295) \
    X(37, nextprevchange, 1, 0, 4294967295) \
    X(38, hitspershot, 1, 0, 4294967295) \
    X(39, stateflags, 1, 0, 4294967295) \
    X(40, statemode, 1, 0, 4294967295) \
    X(41, statejob, 1, 0, 4294967295) \
    X(42, loadedammo[0], 1, 0, 32767) \
    X(43, loadedammo[1], 1, 0, 32767) \
    X(44, state, 1, 0, 8) \
    X(45, stateminor, 1, 0, 255) \
    X(46, attacktype, 1, 0, 255) \
    X(47, animload, 1, -1, 32767) \
    X(48, animframeinc, 1, -10000, 10000) \
    X(49, animmode, 1, 0, 2) \
    X(50, unk0cc8_01, 1, 0, 1) \
    X(51, unk0cc8_02, 1, 0, 1) \
    X(52, incrementalreloading, 1, 0, 1) \
    X(53, unk0cc8_07, 1, 0, 1) \
    X(54, unk0cc8_08, 1, 0, 1) \
    X(55, unk0d0e_07, 1, 0, 1) \
    X(56, activatesecondary, 1, 0, 1) \
    X(57, unk0cc8_04, 1, 0, 7) \
    X(58, animloopcount, 1, 0, 255) \
    X(59, primetimer60, 1, -32768, 32767) \
    X(60, slidetrans, 0, -10000000, 10000000) \
    X(61, shotremainder, 0, -10000000, 10000000) \
    X(62, noiseradius, 0, -10000000, 10000000) \
    X(63, rotxstart, 0, -10000000, 10000000) \
    X(64, rotxend, 0, -10000000, 10000000) \
    X(65, rotxoffset, 0, -10000000, 10000000) \
    X(66, gangstarot, 0, -10000000, 10000000) \
    X(67, gs_float1, 0, -10000000, 10000000) \
    X(68, gs_float2, 0, -10000000, 10000000) \
    X(69, gs_float3, 0, -10000000, 10000000) \
    X(70, gs_float4, 0, -10000000, 10000000) \
    X(71, posstart.x, 0, -10000000, 10000000) \
    X(72, posstart.y, 0, -10000000, 10000000) \
    X(73, posstart.z, 0, -10000000, 10000000) \
    X(74, posend.x, 0, -10000000, 10000000) \
    X(75, posend.y, 0, -10000000, 10000000) \
    X(76, posend.z, 0, -10000000, 10000000) \
    X(77, posoffset.x, 0, -10000000, 10000000) \
    X(78, posoffset.y, 0, -10000000, 10000000) \
    X(79, posoffset.z, 0, -10000000, 10000000) \
    X(80, lastshootdir.x, 0, -10000000, 10000000) \
    X(81, lastshootdir.y, 0, -10000000, 10000000) \
    X(82, lastshootdir.z, 0, -10000000, 10000000) \
    X(83, lastshootpos.x, 0, -10000000, 10000000) \
    X(84, lastshootpos.y, 0, -10000000, 10000000) \
    X(85, lastshootpos.z, 0, -10000000, 10000000) \
    X(86, anim.animnum, 1, 0, 32767) \
    X(87, anim.animnum2, 1, 0, 32767) \
    X(88, anim.flip, 1, 0, 1) \
    X(89, anim.flip2, 1, 0, 1) \
    X(90, anim.looping, 1, 0, 1) \
    X(91, anim.average, 1, 0, 1) \
    X(92, anim.framea, 1, 0, 32767) \
    X(93, anim.frameb, 1, 0, 32767) \
    X(94, anim.frame2a, 1, 0, 32767) \
    X(95, anim.frame2b, 1, 0, 32767) \
    X(96, anim.frame, 0, -1, 32767) \
    X(97, anim.frame2, 0, -1, 32767) \
    X(98, anim.endframe, 0, -1, 32767) \
    X(99, anim.endframe2, 0, -1, 32767) \
    X(100, anim.loopframe, 0, -1, 32767) \
    X(101, anim.frac, 0, 0, 1) \
    X(102, anim.frac2, 0, 0, 1) \
    X(103, anim.fracmerge, 0, 0, 1) \
    X(104, anim.speed, 0, -100, 100) \
    X(105, anim.newspeed, 0, -100, 100) \
    X(106, anim.oldspeed, 0, -100, 100) \
    X(107, anim.speed2, 0, -100, 100) \
    X(108, anim.newspeed2, 0, -100, 100) \
    X(109, anim.oldspeed2, 0, -100, 100) \
    X(110, anim.playspeed, 0, -100, 100) \
    X(111, anim.newplay, 0, -100, 100) \
    X(112, anim.oldplay, 0, -100, 100) \
    X(113, anim.timespeed, 0, 0, 10000000) \
    X(114, anim.elapsespeed, 0, 0, 10000000) \
    X(115, anim.timespeed2, 0, 0, 10000000) \
    X(116, anim.elapsespeed2, 0, 0, 10000000) \
    X(117, anim.timemerge, 0, 0, 10000000) \
    X(118, anim.elapsemerge, 0, 0, 10000000) \
    X(119, anim.loopmerge, 0, 0, 10000000) \
    X(120, anim.timeplay, 0, 0, 10000000) \
    X(121, anim.elapseplay, 0, 0, 10000000) \
    X(122, anim.animscale, 0, 0, 10000000)
enum {
    WF_GSET_WEAPONFUNC = 0,
    WF_GSET_UNK0639 = 1,
    WF_GSET_UNK063A = 2,
    WF_FIRING = 3,
    WF_FLASHON = 4,
    WF_GUNON = 5,
    WF_VISIBLE = 6,
    WF_TRIGGERON = 7,
    WF_TRIGGERPREV = 8,
    WF_TRIGGERRELEASED = 9,
    WF_USEPOSROT = 10,
    WF_SLIDEINC = 11,
    WF_FIREDROCKET = 12,
    WF_LASTDIRVALID = 13,
    WF_COUNT = 14,
    WF_COUNT60 = 15,
    WF_PAUSETIME60 = 16,
    WF_ALLOWSHOOTFRAME = 17,
    WF_LASTSHOOTFRAME60 = 18,
    WF_BURSTBULLETS = 19,
    WF_SHOTSTOTAKE = 20,
    WF_STATEFRAMES = 21,
    WF_STATECYCLES = 22,
    WF_STATELASTFRAME = 23,
    WF_GS_INT1 = 24,
    WF_GS_INT2 = 25,
    WF_GS_INT3 = 26,
    WF_GS_INT4 = 27,
    WF_STATEVAR1 = 28,
    WF_ISPARE1 = 29,
    WF_MODE = 30,
    WF_MODENEXT = 31,
    WF_NUMFIRES = 32,
    WF_NUMSHOTGUNCARTS = 33,
    WF_REFIRETIME = 34,
    WF_TYPECHANGE = 35,
    WF_PAUSECHANGE = 36,
    WF_NEXTPREVCHANGE = 37,
    WF_HITSPERSHOT = 38,
    WF_STATEFLAGS = 39,
    WF_STATEMODE = 40,
    WF_STATEJOB = 41,
    WF_LOADEDAMMO_0 = 42,
    WF_LOADEDAMMO_1 = 43,
    WF_STATE = 44,
    WF_STATEMINOR = 45,
    WF_ATTACKTYPE = 46,
    WF_ANIMLOAD = 47,
    WF_ANIMFRAMEINC = 48,
    WF_ANIMMODE = 49,
    WF_UNK0CC8_01 = 50,
    WF_UNK0CC8_02 = 51,
    WF_INCREMENTALRELOADING = 52,
    WF_UNK0CC8_07 = 53,
    WF_UNK0CC8_08 = 54,
    WF_UNK0D0E_07 = 55,
    WF_ACTIVATESECONDARY = 56,
    WF_UNK0CC8_04 = 57,
    WF_ANIMLOOPCOUNT = 58,
    WF_PRIMETIMER60 = 59,
    WF_SLIDETRANS = 60,
    WF_SHOTREMAINDER = 61,
    WF_NOISERADIUS = 62,
    WF_ROTXSTART = 63,
    WF_ROTXEND = 64,
    WF_ROTXOFFSET = 65,
    WF_GANGSTAROT = 66,
    WF_GS_FLOAT1 = 67,
    WF_GS_FLOAT2 = 68,
    WF_GS_FLOAT3 = 69,
    WF_GS_FLOAT4 = 70,
    WF_POSSTART_X = 71,
    WF_POSSTART_Y = 72,
    WF_POSSTART_Z = 73,
    WF_POSEND_X = 74,
    WF_POSEND_Y = 75,
    WF_POSEND_Z = 76,
    WF_POSOFFSET_X = 77,
    WF_POSOFFSET_Y = 78,
    WF_POSOFFSET_Z = 79,
    WF_LASTSHOOTDIR_X = 80,
    WF_LASTSHOOTDIR_Y = 81,
    WF_LASTSHOOTDIR_Z = 82,
    WF_LASTSHOOTPOS_X = 83,
    WF_LASTSHOOTPOS_Y = 84,
    WF_LASTSHOOTPOS_Z = 85,
    WF_ANIM_ANIMNUM = 86,
    WF_ANIM_ANIMNUM2 = 87,
    WF_ANIM_FLIP = 88,
    WF_ANIM_FLIP2 = 89,
    WF_ANIM_LOOPING = 90,
    WF_ANIM_AVERAGE = 91,
    WF_ANIM_FRAMEA = 92,
    WF_ANIM_FRAMEB = 93,
    WF_ANIM_FRAME2A = 94,
    WF_ANIM_FRAME2B = 95,
    WF_ANIM_FRAME = 96,
    WF_ANIM_FRAME2 = 97,
    WF_ANIM_ENDFRAME = 98,
    WF_ANIM_ENDFRAME2 = 99,
    WF_ANIM_LOOPFRAME = 100,
    WF_ANIM_FRAC = 101,
    WF_ANIM_FRAC2 = 102,
    WF_ANIM_FRACMERGE = 103,
    WF_ANIM_SPEED = 104,
    WF_ANIM_NEWSPEED = 105,
    WF_ANIM_OLDSPEED = 106,
    WF_ANIM_SPEED2 = 107,
    WF_ANIM_NEWSPEED2 = 108,
    WF_ANIM_OLDSPEED2 = 109,
    WF_ANIM_PLAYSPEED = 110,
    WF_ANIM_NEWPLAY = 111,
    WF_ANIM_OLDPLAY = 112,
    WF_ANIM_TIMESPEED = 113,
    WF_ANIM_ELAPSESPEED = 114,
    WF_ANIM_TIMESPEED2 = 115,
    WF_ANIM_ELAPSESPEED2 = 116,
    WF_ANIM_TIMEMERGE = 117,
    WF_ANIM_ELAPSEMERGE = 118,
    WF_ANIM_LOOPMERGE = 119,
    WF_ANIM_TIMEPLAY = 120,
    WF_ANIM_ELAPSEPLAY = 121,
    WF_ANIM_ANIMSCALE = 122,
    PEAK_WEAPON_COUNT = 123
};

static double weaponRead(const struct hand *h, int field)
{
    if (field == 63 && (!h->useposrot)) return 0;
    if (field == 64 && (!h->useposrot)) return 0;
    if (field == 65 && (!h->useposrot)) return 0;
    if (field == 67 && (h->state != HANDSTATE_ATTACK)) return 0;
    if (field == 68 && (h->state != HANDSTATE_ATTACK)) return 0;
    if (field == 69 && (h->state != HANDSTATE_ATTACK)) return 0;
    if (field == 70 && (h->state != HANDSTATE_ATTACK)) return 0;
    if (field == 71 && (!h->useposrot)) return 0;
    if (field == 72 && (!h->useposrot)) return 0;
    if (field == 73 && (!h->useposrot)) return 0;
    if (field == 74 && (!h->useposrot)) return 0;
    if (field == 75 && (!h->useposrot)) return 0;
    if (field == 76 && (!h->useposrot)) return 0;
    if (field == 77 && (!h->useposrot)) return 0;
    if (field == 78 && (!h->useposrot)) return 0;
    if (field == 79 && (!h->useposrot)) return 0;
    if (field == 80 && (!h->lastdirvalid)) return 0;
    if (field == 81 && (!h->lastdirvalid)) return 0;
    if (field == 82 && (!h->lastdirvalid)) return 0;
    if (field == 83 && (!h->lastdirvalid)) return 0;
    if (field == 84 && (!h->lastdirvalid)) return 0;
    if (field == 85 && (!h->lastdirvalid)) return 0;
    if (field == 87 && (!h->anim.animnum)) return 0;
    if (field == 88 && (!h->anim.animnum)) return 0;
    if (field == 89 && (!h->anim.animnum || !h->anim.animnum2)) return 0;
    if (field == 90 && (!h->anim.animnum)) return 0;
    if (field == 91 && (!h->anim.animnum)) return 0;
    if (field == 92 && (!h->anim.animnum)) return 0;
    if (field == 93 && (!h->anim.animnum)) return 0;
    if (field == 94 && (!h->anim.animnum || !h->anim.animnum2)) return 0;
    if (field == 95 && (!h->anim.animnum || !h->anim.animnum2)) return 0;
    if (field == 96 && (!h->anim.animnum)) return 0;
    if (field == 97 && (!h->anim.animnum || !h->anim.animnum2)) return 0;
    if (field == 98 && (!h->anim.animnum)) return 0;
    if (field == 99 && (!h->anim.animnum || !h->anim.animnum2)) return 0;
    if (field == 100 && (!h->anim.animnum || !h->anim.looping)) return 0;
    if (field == 101 && (!h->anim.animnum)) return 0;
    if (field == 102 && (!h->anim.animnum || !h->anim.animnum2)) return 0;
    if (field == 103 && (!h->anim.animnum)) return 0;
    if (field == 104 && (!h->anim.animnum)) return 0;
    if (field == 105 && (!h->anim.animnum || !h->anim.timespeed)) return 0;
    if (field == 106 && (!h->anim.animnum || !h->anim.timespeed)) return 0;
    if (field == 107 && (!h->anim.animnum || !h->anim.animnum2)) return 0;
    if (field == 108 && (!h->anim.animnum2 || !h->anim.timespeed2)) return 0;
    if (field == 109 && (!h->anim.animnum2 || !h->anim.timespeed2)) return 0;
    // animInit initializes playback speed and scale before the first animation.
    // These settings survive modelSetAnimation and must not be zeroed at idle.
    if (field == 111 && (!h->anim.timeplay)) return 0;
    if (field == 112 && (!h->anim.timeplay)) return 0;
    if (field == 113 && (!h->anim.animnum)) return 0;
    if (field == 114 && (!h->anim.animnum || !h->anim.timespeed)) return 0;
    if (field == 115 && (!h->anim.animnum || !h->anim.animnum2)) return 0;
    if (field == 116 && (!h->anim.animnum2 || !h->anim.timespeed2)) return 0;
    if (field == 117 && (!h->anim.animnum)) return 0;
    if (field == 118 && (!h->anim.animnum || !h->anim.timemerge)) return 0;
    if (field == 119 && (!h->anim.animnum || !h->anim.looping)) return 0;
    if (field == 121 && (!h->anim.timeplay)) return 0;
    switch (field) {
#define WEAPON_READ(i, member, integer, low, high) case i: return h->member;
    PEAK_WEAPON_FIELDS(WEAPON_READ)
#undef WEAPON_READ
    default: return NAN;
    }
}
