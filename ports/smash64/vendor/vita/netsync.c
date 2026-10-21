#include <sys/netsync.h>

#include <ft/fighter.h>
#include <gm/gmdef.h>
#include <gr/ground.h>
#include <it/item.h>
#include <mp/map.h>
#include <sc/scene.h>
#include <sys/netinput.h>
#include <sys/objdef.h>
#include <sys/objman.h>
#include <sys/utils.h>
#include <wp/weapon.h>

#include <string.h>

#ifdef PORT
extern void port_log(const char *fmt, ...);
#endif

#define SYNETSYNC_FNV64_OFFSET 1469598103934665603ULL
#define SYNETSYNC_FNV64_PRIME 1099511628211ULL

static u32 syNetSyncFnvAccumulateU32(u32 hash, u32 value)
{
	hash ^= value;
	hash *= 16777619U;

	return hash;
}

static u32 syNetSyncHashF32(f32 value)
{
	union SYNetSyncF32Reinterpret
	{
		f32 fv;
		u32 uv;

	} reinterpret;

	reinterpret.fv = value;

	return reinterpret.uv;
}

static u64 syNetSyncFnv64U8(u64 hash, u8 value)
{
	hash ^= value;
	hash *= SYNETSYNC_FNV64_PRIME;
	return hash;
}

static u64 syNetSyncFnv64U16(u64 hash, u16 value)
{
	hash = syNetSyncFnv64U8(hash, (u8)(value >> 8));
	hash = syNetSyncFnv64U8(hash, (u8)value);
	return hash;
}

static u64 syNetSyncFnv64U32(u64 hash, u32 value)
{
	hash = syNetSyncFnv64U8(hash, (u8)(value >> 24));
	hash = syNetSyncFnv64U8(hash, (u8)(value >> 16));
	hash = syNetSyncFnv64U8(hash, (u8)(value >> 8));
	hash = syNetSyncFnv64U8(hash, (u8)value);
	return hash;
}

static u64 syNetSyncFnv64U64(u64 hash, u64 value)
{
	hash = syNetSyncFnv64U32(hash, (u32)(value >> 32));
	hash = syNetSyncFnv64U32(hash, (u32)value);
	return hash;
}

static u64 syNetSyncFnv64S32(u64 hash, s32 value)
{
	return syNetSyncFnv64U32(hash, (u32)value);
}

static u64 syNetSyncFnv64F32(u64 hash, f32 value)
{
	return syNetSyncFnv64U32(hash, syNetSyncHashF32(value));
}

static u64 syNetSyncHashVec3f64(u64 hash, const Vec3f *vec)
{
	hash = syNetSyncFnv64F32(hash, vec->x);
	hash = syNetSyncFnv64F32(hash, vec->y);
	hash = syNetSyncFnv64F32(hash, vec->z);
	return hash;
}

static u64 syNetSyncHashCollData64(u64 hash, const MPCollData *coll)
{
	hash = syNetSyncHashVec3f64(hash, &coll->pos_prev);
	hash = syNetSyncHashVec3f64(hash, &coll->pos_diff);
	hash = syNetSyncHashVec3f64(hash, &coll->vel_speed);
	hash = syNetSyncHashVec3f64(hash, &coll->vel_push);
	hash = syNetSyncFnv64U16(hash, coll->mask_prev);
	hash = syNetSyncFnv64U16(hash, coll->mask_curr);
	hash = syNetSyncFnv64U16(hash, coll->mask_unk);
	hash = syNetSyncFnv64U16(hash, coll->mask_stat);
	hash = syNetSyncFnv64U16(hash, coll->update_tic);
	hash = syNetSyncFnv64S32(hash, coll->ewall_line_id);
	hash = syNetSyncFnv64U32(hash, (u32)(coll->is_coll_end != FALSE));
	hash = syNetSyncHashVec3f64(hash, &coll->line_coll_dist);
	hash = syNetSyncFnv64S32(hash, coll->floor_line_id);
	hash = syNetSyncFnv64F32(hash, coll->floor_dist);
	hash = syNetSyncFnv64U32(hash, coll->floor_flags);
	hash = syNetSyncHashVec3f64(hash, &coll->floor_angle);
	hash = syNetSyncFnv64S32(hash, coll->ceil_line_id);
	hash = syNetSyncFnv64U32(hash, coll->ceil_flags);
	hash = syNetSyncHashVec3f64(hash, &coll->ceil_angle);
	hash = syNetSyncFnv64S32(hash, coll->lwall_line_id);
	hash = syNetSyncFnv64U32(hash, coll->lwall_flags);
	hash = syNetSyncHashVec3f64(hash, &coll->lwall_angle);
	hash = syNetSyncFnv64S32(hash, coll->rwall_line_id);
	hash = syNetSyncFnv64U32(hash, coll->rwall_flags);
	hash = syNetSyncHashVec3f64(hash, &coll->rwall_angle);
	hash = syNetSyncFnv64S32(hash, coll->cliff_id);
	hash = syNetSyncFnv64S32(hash, coll->ignore_line_id);
	return hash;
}

static u64 syNetSyncHashDObjState64(u64 hash, const DObj *dobj)
{
	if (dobj == NULL)
	{
		return syNetSyncFnv64U32(hash, 0);
	}
	hash = syNetSyncFnv64U32(hash, 1);
	hash = syNetSyncHashVec3f64(hash, &dobj->translate.vec.f);
	hash = syNetSyncHashVec3f64(hash, &dobj->rotate.vec.f);
	hash = syNetSyncHashVec3f64(hash, &dobj->scale.vec.f);
	hash = syNetSyncFnv64F32(hash, dobj->anim_wait);
	hash = syNetSyncFnv64F32(hash, dobj->anim_speed);
	hash = syNetSyncFnv64F32(hash, dobj->anim_frame);
	hash = syNetSyncFnv64U32(hash, dobj->flags);
	return hash;
}

static u64 syNetSyncHashBattleState64(void)
{
	SCBattleState *battle = gSCManagerBattleState;
	u64 hash = SYNETSYNC_FNV64_OFFSET;
	s32 player;
	s32 stale;

	if (battle == NULL)
	{
		return syNetSyncFnv64U32(hash, 0);
	}
	hash = syNetSyncFnv64U8(hash, battle->game_type);
	hash = syNetSyncFnv64U8(hash, battle->gkind);
	hash = syNetSyncFnv64U32(hash, (u32)(battle->is_team_battle != FALSE));
	hash = syNetSyncFnv64U8(hash, battle->game_rules);
	hash = syNetSyncFnv64U8(hash, battle->pl_count);
	hash = syNetSyncFnv64U8(hash, battle->cp_count);
	hash = syNetSyncFnv64U8(hash, battle->time_limit);
	hash = syNetSyncFnv64U8(hash, battle->stocks);
	hash = syNetSyncFnv64U8(hash, battle->handicap);
	hash = syNetSyncFnv64U32(hash, (u32)(battle->is_team_attack != FALSE));
	hash = syNetSyncFnv64U8(hash, battle->damage_ratio);
	hash = syNetSyncFnv64U32(hash, battle->item_toggles);
	hash = syNetSyncFnv64U8(hash, battle->game_status);
	hash = syNetSyncFnv64U32(hash, battle->time_remain);
	hash = syNetSyncFnv64U32(hash, battle->time_passed);
	hash = syNetSyncFnv64U8(hash, battle->item_appearance_rate);

	for (player = 0; player < GMCOMMON_PLAYERS_MAX; player++)
	{
		SCPlayerData *data = &battle->players[player];
		hash = syNetSyncFnv64U32(hash, (u32)player);
		hash = syNetSyncFnv64U8(hash, data->level);
		hash = syNetSyncFnv64U8(hash, data->handicap);
		hash = syNetSyncFnv64U8(hash, data->pkind);
		hash = syNetSyncFnv64U8(hash, data->fkind);
		hash = syNetSyncFnv64U8(hash, data->team);
		hash = syNetSyncFnv64U8(hash, data->player);
		hash = syNetSyncFnv64U8(hash, data->costume);
		hash = syNetSyncFnv64U8(hash, data->shade);
		hash = syNetSyncFnv64U8(hash, (u8)data->stock_count);
		hash = syNetSyncFnv64S32(hash, data->falls);
		hash = syNetSyncFnv64S32(hash, data->score);
		hash = syNetSyncFnv64S32(hash, data->total_selfdestructs);
		hash = syNetSyncFnv64S32(hash, data->total_damage_given);
		hash = syNetSyncFnv64S32(hash, data->total_damage_all);
		hash = syNetSyncFnv64S32(hash, data->stock_damage_all);
		hash = syNetSyncFnv64S32(hash, data->combo_damage_foe);
		hash = syNetSyncFnv64S32(hash, data->combo_count_foe);
		hash = syNetSyncFnv64U32(hash, data->stale_id);
		for (stale = 0; stale < 5; stale++)
		{
			hash = syNetSyncFnv64U16(hash, data->stale_info[stale].attack_id);
			hash = syNetSyncFnv64U16(hash, data->stale_info[stale].motion_count);
		}
	}
	return hash;
}

static u64 syNetSyncHashOneFighter64(FTStruct *fp)
{
	u64 hash = SYNETSYNC_FNV64_OFFSET;
	s32 hit;

	hash = syNetSyncFnv64U32(hash, (u32)fp->player);
	hash = syNetSyncFnv64S32(hash, fp->fkind);
	hash = syNetSyncFnv64S32(hash, fp->pkind);
	hash = syNetSyncFnv64S32(hash, fp->status_id);
	hash = syNetSyncFnv64S32(hash, fp->motion_id);
	hash = syNetSyncFnv64U32(hash, fp->status_total_tics);
	hash = syNetSyncFnv64S32(hash, fp->percent_damage);
	hash = syNetSyncFnv64S32(hash, fp->damage_resist);
	hash = syNetSyncFnv64S32(hash, fp->shield_health);
	hash = syNetSyncFnv64U32(hash, fp->hitlag_tics);
	hash = syNetSyncFnv64S32(hash, fp->lr);
	hash = syNetSyncHashVec3f64(hash, &fp->physics.vel_air);
	hash = syNetSyncHashVec3f64(hash, &fp->physics.vel_damage_air);
	hash = syNetSyncHashVec3f64(hash, &fp->physics.vel_ground);
	hash = syNetSyncFnv64F32(hash, fp->physics.vel_damage_ground);
	hash = syNetSyncFnv64F32(hash, fp->physics.vel_jostle_x);
	hash = syNetSyncFnv64F32(hash, fp->physics.vel_jostle_z);
	hash = syNetSyncHashCollData64(hash, &fp->coll_data);
	hash = syNetSyncFnv64U8(hash, fp->jumps_used);
	hash = syNetSyncFnv64U32(hash, (u32)(fp->ga != FALSE));
	hash = syNetSyncFnv64F32(hash, fp->attack1_followup_frames);
	hash = syNetSyncFnv64S32(hash, fp->attack1_status_id);
	hash = syNetSyncFnv64S32(hash, fp->attack1_input_count);
	hash = syNetSyncFnv64S32(hash, fp->cliffcatch_wait);
	hash = syNetSyncFnv64S32(hash, fp->tics_since_last_z);
	hash = syNetSyncFnv64S32(hash, fp->acid_wait);
	hash = syNetSyncFnv64S32(hash, fp->twister_wait);
	hash = syNetSyncFnv64S32(hash, fp->tarucann_wait);
	hash = syNetSyncFnv64U32(hash, fp->motion_vars.flags.flag0);
	hash = syNetSyncFnv64U32(hash, fp->motion_vars.flags.flag1);
	hash = syNetSyncFnv64U32(hash, fp->motion_vars.flags.flag2);
	hash = syNetSyncFnv64U32(hash, fp->motion_vars.flags.flag3);
	hash = syNetSyncFnv64U16(hash, fp->input.pl.button_hold);
	hash = syNetSyncFnv64U16(hash, fp->input.pl.button_tap);
	hash = syNetSyncFnv64U16(hash, fp->input.pl.button_release);
	hash = syNetSyncFnv64U8(hash, (u8)fp->input.pl.stick_range.x);
	hash = syNetSyncFnv64U8(hash, (u8)fp->input.pl.stick_range.y);
	hash = syNetSyncFnv64U8(hash, fp->tap_stick_x);
	hash = syNetSyncFnv64U8(hash, fp->tap_stick_y);
	hash = syNetSyncFnv64U8(hash, fp->hold_stick_x);
	hash = syNetSyncFnv64U8(hash, fp->hold_stick_y);
	hash = syNetSyncFnv64U32(hash, fp->motion_attack_id);
	hash = syNetSyncFnv64U16(hash, fp->motion_count);
	hash = syNetSyncFnv64S32(hash, fp->invincible_tics);
	hash = syNetSyncFnv64S32(hash, fp->intangible_tics);
	hash = syNetSyncFnv64S32(hash, fp->star_invincible_tics);
	hash = syNetSyncFnv64S32(hash, fp->hitstatus);
	hash = syNetSyncFnv64S32(hash, fp->attack_damage);
	hash = syNetSyncFnv64F32(hash, fp->attack_knockback);
	hash = syNetSyncFnv64U16(hash, fp->attack_count);
	hash = syNetSyncFnv64S32(hash, fp->damage_lag);
	hash = syNetSyncFnv64F32(hash, fp->damage_knockback);
	hash = syNetSyncFnv64S32(hash, fp->damage_queue);
	hash = syNetSyncFnv64S32(hash, fp->damage_angle);
	hash = syNetSyncFnv64S32(hash, fp->damage_element);
	hash = syNetSyncFnv64S32(hash, fp->damage_lr);
	hash = syNetSyncFnv64S32(hash, fp->hammer_tics);
	for (hit = 0; hit < 4; hit++)
	{
		hash = syNetSyncFnv64U32(hash, fp->attack_colls[hit].attack_state);
		hash = syNetSyncFnv64S32(hash, fp->attack_colls[hit].damage);
	}
	/* Joint/AObj animation state is presentation state. It may legitimately be
	 * at a different interpolation point after rollback resimulation even when
	 * the gameplay state is identical. Hash the fighter root transform instead:
	 * collision, status, timers and velocities above carry the authoritative
	 * gameplay state while the root gives us the world-space position. */
	{
		DObj *root = (fp->fighter_gobj != NULL) ? DObjGetStruct(fp->fighter_gobj) : NULL;
		hash = syNetSyncFnv64U32(hash, (root != NULL) ? 1U : 0U);
		if (root != NULL) hash = syNetSyncHashVec3f64(hash, &root->translate.vec.f);
	}
	return hash;
}

static void syNetSyncHashFighters64(u64 *out_hashes, SYNetSyncDigest *digest)
{
	GObj *fighter_gobj;
	s32 player;

	for (player = 0; player < GMCOMMON_PLAYERS_MAX; player++)
	{
		out_hashes[player] = SYNETSYNC_FNV64_OFFSET;
	}
	for (fighter_gobj = gGCCommonLinks[nGCCommonLinkIDFighter]; fighter_gobj != NULL;
	     fighter_gobj = fighter_gobj->link_next)
	{
		FTStruct *fp = ftGetStruct(fighter_gobj);
		u64 contribution = syNetSyncHashOneFighter64(fp);
		DObj *root = DObjGetStruct(fighter_gobj);
		player = fp->player;
		if ((player < 0) || (player >= GMCOMMON_PLAYERS_MAX)) player = 0;
		out_hashes[player] = syNetSyncFnv64U64(out_hashes[player], contribution);
		if (digest != NULL)
		{
			digest->fighter_status[player] = fp->status_id;
			digest->fighter_motion[player] = fp->motion_id;
			digest->fighter_damage[player] = fp->percent_damage;
			digest->fighter_stock[player] = fp->stock_count;
			if (root != NULL)
			{
				digest->fighter_pos_x_bits[player] = syNetSyncHashF32(root->translate.vec.f.x);
				digest->fighter_pos_y_bits[player] = syNetSyncHashF32(root->translate.vec.f.y);
			}
			digest->fighter_vel_x_bits[player] = syNetSyncHashF32(fp->physics.vel_air.x);
			digest->fighter_vel_y_bits[player] = syNetSyncHashF32(fp->physics.vel_air.y);
		}
	}
}

static u64 syNetSyncHashMap64(void)
{
	u64 hash = SYNETSYNC_FNV64_OFFSET;
	s32 i;

	hash = syNetSyncFnv64U16(hash, gMPCollisionUpdateTic);
	hash = syNetSyncFnv64F32(hash, gMPCollisionBounds.current.top);
	hash = syNetSyncFnv64F32(hash, gMPCollisionBounds.current.bottom);
	hash = syNetSyncFnv64F32(hash, gMPCollisionBounds.current.right);
	hash = syNetSyncFnv64F32(hash, gMPCollisionBounds.current.left);
	hash = syNetSyncFnv64F32(hash, gMPCollisionBounds.diff.top);
	hash = syNetSyncFnv64F32(hash, gMPCollisionBounds.diff.bottom);
	hash = syNetSyncFnv64F32(hash, gMPCollisionBounds.diff.right);
	hash = syNetSyncFnv64F32(hash, gMPCollisionBounds.diff.left);
	hash = syNetSyncFnv64S32(hash, gMPCollisionYakumonosNum);

	if ((gMPCollisionYakumonoDObjs != NULL) && (gMPCollisionSpeeds != NULL))
	{
		for (i = 0; i < gMPCollisionYakumonosNum; i++)
		{
			DObj *dobj = gMPCollisionYakumonoDObjs->dobjs[i];
			hash = syNetSyncFnv64S32(hash, i);
			if (dobj == NULL)
			{
				hash = syNetSyncFnv64U32(hash, 0);
				continue;
			}
			hash = syNetSyncFnv64U32(hash, 1);
			hash = syNetSyncFnv64S32(hash, dobj->user_data.s);
			hash = syNetSyncHashDObjState64(hash, dobj);
			hash = syNetSyncHashVec3f64(hash, &gMPCollisionSpeeds[i]);
		}
	}
	return hash;
}

static u64 syNetSyncHashStage64(void)
{
	u64 hash = SYNETSYNC_FNV64_OFFSET;

	if (gSCManagerBattleState == NULL) return hash;
	hash = syNetSyncFnv64U32(hash, gSCManagerBattleState->gkind);

	switch (gSCManagerBattleState->gkind)
	{
	case nGRKindPupupu:
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.pupupu.whispy_wind_wait);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.pupupu.whispy_wind_duration);
		hash = syNetSyncFnv64U16(hash, (u16)gGRCommonStruct.pupupu.whispy_blink_wait);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.pupupu.whispy_status);
		hash = syNetSyncFnv64U8(hash, (u8)gGRCommonStruct.pupupu.lr_players);
		break;
	case nGRKindSector:
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.sector.arwing_target_x);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.sector.arwing_appear_timer);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.sector.arwing_state_timer);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.sector.arwing_status);
		hash = syNetSyncFnv64U8(hash, (u8)gGRCommonStruct.sector.arwing_flight_pattern);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.sector.arwing_type_cycle);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.sector.arwing_laser_ammo);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.sector.arwing_laser_timer);
		hash = syNetSyncFnv64U8(hash, (u8)gGRCommonStruct.sector.arwing_pilot_curr);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.sector.arwing_pilot_prev);
		break;
	case nGRKindZebes:
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.zebes.acid_level_curr);
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.zebes.acid_level_step);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.zebes.acid_level_wait);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.zebes.acid_status);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.zebes.acid_attr_id);
		break;
	case nGRKindYoster:
		{
			s32 i;
			for (i = 0; i < 3; i++)
			{
				hash = syNetSyncFnv64F32(hash, gGRCommonStruct.yoster.clouds[i].altitude);
				hash = syNetSyncFnv64F32(hash, gGRCommonStruct.yoster.clouds[i].pressure);
				hash = syNetSyncFnv64U8(hash, gGRCommonStruct.yoster.clouds[i].status);
				hash = syNetSyncFnv64U8(hash, (u8)gGRCommonStruct.yoster.clouds[i].pressure_timer);
			}
		}
		break;
	case nGRKindInishie:
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.inishie.splat_alt);
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.inishie.splat_accelerate);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.inishie.splat_wait);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.inishie.splat_status);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.inishie.pblock_appear_wait);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.inishie.pblock_status);
		break;
	case nGRKindJungle:
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.jungle.tarucann_status);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.jungle.tarucann_wait);
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.jungle.tarucann_rotate_step);
		if (gGRCommonStruct.jungle.tarucann_gobj != NULL)
			hash = syNetSyncHashDObjState64(hash, DObjGetStruct(gGRCommonStruct.jungle.tarucann_gobj));
		break;
	case nGRKindHyrule:
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.hyrule.twister_leftedge_x);
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.hyrule.twister_rightedge_x);
		hash = syNetSyncFnv64F32(hash, gGRCommonStruct.hyrule.twister_vel);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.hyrule.twister_wait);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.hyrule.twister_speed_wait);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.hyrule.twister_turn_wait);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.hyrule.twister_line_id);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.hyrule.twister_status);
		if (gGRCommonStruct.hyrule.twister_gobj != NULL)
			hash = syNetSyncHashDObjState64(hash, DObjGetStruct(gGRCommonStruct.hyrule.twister_gobj));
		break;
	case nGRKindYamabuki:
		hash = syNetSyncHashVec3f64(hash, &gGRCommonStruct.yamabuki.gate_pos);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.yamabuki.gate_status);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.yamabuki.monster_wait);
		hash = syNetSyncFnv64U16(hash, gGRCommonStruct.yamabuki.gate_wait);
		hash = syNetSyncFnv64U8(hash, gGRCommonStruct.yamabuki.monster_id_prev);
		break;
	case nGRKindCastle:
		hash = syNetSyncHashVec3f64(hash, &gGRCommonStruct.castle.bumper_pos);
		if (gGRCommonStruct.castle.bumper_gobj != NULL)
			hash = syNetSyncHashDObjState64(hash, DObjGetStruct(gGRCommonStruct.castle.bumper_gobj));
		break;
	default:
		break;
	}
	return hash;
}

static u64 syNetSyncHashItems64(u32 *out_count)
{
	GObj *gobj;
	u64 hash = SYNETSYNC_FNV64_OFFSET;
	u32 count = 0;
	s32 i;

	/* Random item scheduling is gameplay state even while no item GObj exists. */
	hash = syNetSyncFnv64U32(hash, gITManagerAppearActor.spawn_wait);
	hash = syNetSyncFnv64U8(hash, gITManagerAppearActor.mapobjs_num);
	hash = syNetSyncFnv64U8(hash, gITManagerAppearActor.weights.valids_num);
	hash = syNetSyncFnv64U16(hash, gITManagerAppearActor.weights.weights_sum);
	hash = syNetSyncFnv64U8(hash, gITManagerRandomWeights.valids_num);
	hash = syNetSyncFnv64U16(hash, gITManagerRandomWeights.weights_sum);
	for (i = 0; (i < gITManagerRandomWeights.valids_num) &&
	            (gITManagerRandomWeights.kinds != NULL) && (gITManagerRandomWeights.blocks != NULL); i++)
	{
		hash = syNetSyncFnv64U8(hash, gITManagerRandomWeights.kinds[i]);
		hash = syNetSyncFnv64U16(hash, gITManagerRandomWeights.blocks[i]);
	}

	for (gobj = gGCCommonLinks[nGCCommonLinkIDItem]; gobj != NULL; gobj = gobj->link_next)
	{
		ITStruct *ip = itGetStruct(gobj);
		if (ip == NULL) continue;
		hash = syNetSyncFnv64U32(hash, count++);
		hash = syNetSyncFnv64S32(hash, ip->kind);
		hash = syNetSyncFnv64S32(hash, ip->type);
		hash = syNetSyncFnv64U8(hash, ip->team);
		hash = syNetSyncFnv64U8(hash, ip->player);
		hash = syNetSyncFnv64S32(hash, ip->percent_damage);
		hash = syNetSyncFnv64U32(hash, ip->hitlag_tics);
		hash = syNetSyncFnv64S32(hash, ip->lr);
		hash = syNetSyncFnv64F32(hash, ip->physics.vel_ground);
		hash = syNetSyncHashVec3f64(hash, &ip->physics.vel_air);
		hash = syNetSyncHashCollData64(hash, &ip->coll_data);
		hash = syNetSyncFnv64U32(hash, (u32)(ip->ga != FALSE));
		hash = syNetSyncFnv64S32(hash, ip->lifetime);
		hash = syNetSyncFnv64U16(hash, ip->multi);
		hash = syNetSyncFnv64F32(hash, ip->spin_step);
		hash = syNetSyncFnv64U32(hash, ip->attack_coll.attack_state);
		hash = syNetSyncFnv64S32(hash, ip->attack_coll.damage);
		hash = syNetSyncFnv64U16(hash, ip->attack_coll.motion_count);
		hash = syNetSyncFnv64U16(hash, ip->attack_coll.stat_count);
		hash = syNetSyncFnv64S32(hash, ip->attack_coll.attack_count);
		hash = syNetSyncFnv64U32(hash, (u32)(ip->is_hold != FALSE));
		hash = syNetSyncFnv64U32(hash, (u32)(ip->is_thrown != FALSE));
		hash = syNetSyncFnv64U16(hash, ip->attach_line_id);
		hash = syNetSyncFnv64U32(hash, ip->pickup_wait);
		{
			DObj *root = DObjGetStruct(gobj);
			hash = syNetSyncFnv64U32(hash, (root != NULL) ? 1U : 0U);
			if (root != NULL) hash = syNetSyncHashVec3f64(hash, &root->translate.vec.f);
		}
	}
	*out_count = count;
	return hash;
}

static u64 syNetSyncHashWeapons64(u32 *out_count)
{
	GObj *gobj;
	u64 hash = SYNETSYNC_FNV64_OFFSET;
	u32 count = 0;

	for (gobj = gGCCommonLinks[nGCCommonLinkIDWeapon]; gobj != NULL; gobj = gobj->link_next)
	{
		WPStruct *wp = wpGetStruct(gobj);
		if (wp == NULL) continue;
		hash = syNetSyncFnv64U32(hash, count++);
		hash = syNetSyncFnv64S32(hash, wp->kind);
		hash = syNetSyncFnv64U8(hash, wp->team);
		hash = syNetSyncFnv64U8(hash, wp->player);
		hash = syNetSyncFnv64S32(hash, wp->lr);
		hash = syNetSyncFnv64F32(hash, wp->physics.vel_ground);
		hash = syNetSyncHashVec3f64(hash, &wp->physics.vel_air);
		hash = syNetSyncHashCollData64(hash, &wp->coll_data);
		hash = syNetSyncFnv64U32(hash, (u32)(wp->ga != FALSE));
		hash = syNetSyncFnv64U32(hash, wp->group_id);
		hash = syNetSyncFnv64S32(hash, wp->lifetime);
		hash = syNetSyncFnv64U32(hash, wp->attack_coll.attack_state);
		hash = syNetSyncFnv64S32(hash, wp->attack_coll.damage);
		hash = syNetSyncFnv64U16(hash, wp->attack_coll.motion_count);
		hash = syNetSyncFnv64U16(hash, wp->attack_coll.stat_count);
		hash = syNetSyncFnv64S32(hash, wp->attack_coll.attack_count);
		{
			DObj *root = DObjGetStruct(gobj);
			hash = syNetSyncFnv64U32(hash, (root != NULL) ? 1U : 0U);
			if (root != NULL) hash = syNetSyncHashVec3f64(hash, &root->translate.vec.f);
		}
	}
	*out_count = count;
	return hash;
}

void syNetSyncComputeDeterministicDigest(u32 frame, SYNetSyncDigest *out_digest)
{
	u64 merged = SYNETSYNC_FNV64_OFFSET;
	s32 player;

	if (out_digest == NULL) return;
	memset(out_digest, 0, sizeof(*out_digest));
	out_digest->frame = frame;
	out_digest->rng_seed = syUtilsRandSeed();
	if (gSCManagerBattleState != NULL)
	{
		out_digest->time_remain = gSCManagerBattleState->time_remain;
		out_digest->time_passed = gSCManagerBattleState->time_passed;
	}
	out_digest->rng_hash = syNetSyncFnv64S32(SYNETSYNC_FNV64_OFFSET, out_digest->rng_seed);
	out_digest->battle_hash = syNetSyncHashBattleState64();
	syNetSyncHashFighters64(out_digest->fighter_hash, out_digest);
	out_digest->stage_hash = syNetSyncHashStage64();
	out_digest->map_hash = syNetSyncHashMap64();
	out_digest->item_hash = syNetSyncHashItems64(&out_digest->item_count);
	out_digest->weapon_hash = syNetSyncHashWeapons64(&out_digest->weapon_count);

	merged = syNetSyncFnv64U32(merged, frame);
	merged = syNetSyncFnv64U64(merged, out_digest->rng_hash);
	merged = syNetSyncFnv64U64(merged, out_digest->battle_hash);
	for (player = 0; player < GMCOMMON_PLAYERS_MAX; player++)
			merged = syNetSyncFnv64U64(merged, out_digest->fighter_hash[player]);
	merged = syNetSyncFnv64U64(merged, out_digest->stage_hash);
	merged = syNetSyncFnv64U64(merged, out_digest->map_hash);
	merged = syNetSyncFnv64U64(merged, out_digest->item_hash);
	merged = syNetSyncFnv64U64(merged, out_digest->weapon_hash);
	out_digest->total_hash = merged;
}

u64 syNetSyncComputeDeterministicStateHash(u32 frame)
{
	SYNetSyncDigest digest;
	syNetSyncComputeDeterministicDigest(frame, &digest);
	return digest.total_hash;
}

void syNetSyncLogDigestMismatch(const SYNetSyncDigest *expected, const SYNetSyncDigest *actual)
{
#ifdef PORT
	const char *category;
	s32 player;
	if ((expected == NULL) || (actual == NULL)) return;
	category = syNetSyncDigestFirstMismatch(expected, actual);
	port_log("[NETPLAY][DET] DIVERGENCE frame=%u category=%s exp=%08X%08X got=%08X%08X\n",
	         actual->frame, category,
	         (u32)(expected->total_hash >> 32), (u32)expected->total_hash,
	         (u32)(actual->total_hash >> 32), (u32)actual->total_hash);
	port_log("[NETPLAY][DET] rng exp=%d got=%d timer_remain exp=%u got=%u timer_passed exp=%u got=%u\n",
	         expected->rng_seed, actual->rng_seed,
	         expected->time_remain, actual->time_remain, expected->time_passed, actual->time_passed);
	port_log("[NETPLAY][DET] hashes rng=%08X%08X/%08X%08X battle=%08X%08X/%08X%08X stage=%08X%08X/%08X%08X map=%08X%08X/%08X%08X items=%08X%08X/%08X%08X weapons=%08X%08X/%08X%08X\n",
	         (u32)(expected->rng_hash >> 32), (u32)expected->rng_hash, (u32)(actual->rng_hash >> 32), (u32)actual->rng_hash,
	         (u32)(expected->battle_hash >> 32), (u32)expected->battle_hash, (u32)(actual->battle_hash >> 32), (u32)actual->battle_hash,
	         (u32)(expected->stage_hash >> 32), (u32)expected->stage_hash, (u32)(actual->stage_hash >> 32), (u32)actual->stage_hash,
	         (u32)(expected->map_hash >> 32), (u32)expected->map_hash, (u32)(actual->map_hash >> 32), (u32)actual->map_hash,
	         (u32)(expected->item_hash >> 32), (u32)expected->item_hash, (u32)(actual->item_hash >> 32), (u32)actual->item_hash,
	         (u32)(expected->weapon_hash >> 32), (u32)expected->weapon_hash, (u32)(actual->weapon_hash >> 32), (u32)actual->weapon_hash);
	port_log("[NETPLAY][DET] fighter hashes p1=%08X%08X/%08X%08X p2=%08X%08X/%08X%08X p3=%08X%08X/%08X%08X p4=%08X%08X/%08X%08X counts items=%u/%u weapons=%u/%u\n",
	         (u32)(expected->fighter_hash[0] >> 32), (u32)expected->fighter_hash[0], (u32)(actual->fighter_hash[0] >> 32), (u32)actual->fighter_hash[0],
	         (u32)(expected->fighter_hash[1] >> 32), (u32)expected->fighter_hash[1], (u32)(actual->fighter_hash[1] >> 32), (u32)actual->fighter_hash[1],
	         (u32)(expected->fighter_hash[2] >> 32), (u32)expected->fighter_hash[2], (u32)(actual->fighter_hash[2] >> 32), (u32)actual->fighter_hash[2],
	         (u32)(expected->fighter_hash[3] >> 32), (u32)expected->fighter_hash[3], (u32)(actual->fighter_hash[3] >> 32), (u32)actual->fighter_hash[3],
	         expected->item_count, actual->item_count, expected->weapon_count, actual->weapon_count);
	for (player = 0; player < GMCOMMON_PLAYERS_MAX; player++)
	{
		if (expected->fighter_hash[player] == actual->fighter_hash[player]) continue;
		port_log("[NETPLAY][DET] fighter%d status=%d/%d motion=%d/%d damage=%d/%d stock=%d/%d pos_bits=(%08X,%08X)/(%08X,%08X) vel_bits=(%08X,%08X)/(%08X,%08X)\n",
		         player,
		         expected->fighter_status[player], actual->fighter_status[player],
		         expected->fighter_motion[player], actual->fighter_motion[player],
		         expected->fighter_damage[player], actual->fighter_damage[player],
		         expected->fighter_stock[player], actual->fighter_stock[player],
		         expected->fighter_pos_x_bits[player], expected->fighter_pos_y_bits[player],
		         actual->fighter_pos_x_bits[player], actual->fighter_pos_y_bits[player],
		         expected->fighter_vel_x_bits[player], expected->fighter_vel_y_bits[player],
		         actual->fighter_vel_x_bits[player], actual->fighter_vel_y_bits[player]);
	}
#else
	(void)expected;
	(void)actual;
#endif
}

u32 syNetSyncHashBattleFighters(void)
{
	GObj *fighter_gobj;
	u32 slot_hash[GMCOMMON_PLAYERS_MAX];
	s32 si;

	for (si = 0; si < GMCOMMON_PLAYERS_MAX; si++)
	{
		slot_hash[si] = 2166136261U;
	}

	for (fighter_gobj = gGCCommonLinks[nGCCommonLinkIDFighter]; fighter_gobj != NULL;
	     fighter_gobj = fighter_gobj->link_next)
	{
		FTStruct *fp;
		u32 contribution;
		s32 slot;

		fp = ftGetStruct(fighter_gobj);

		contribution = 2166136261U;

		contribution = syNetSyncFnvAccumulateU32(contribution, (u32)fp->player);
		contribution = syNetSyncFnvAccumulateU32(contribution, (u32)fp->fkind);
		contribution = syNetSyncFnvAccumulateU32(contribution, (u32)fp->status_id);
		contribution = syNetSyncFnvAccumulateU32(contribution, (u32)fp->motion_id);
		contribution = syNetSyncFnvAccumulateU32(contribution, (u32)fp->percent_damage);
		contribution = syNetSyncFnvAccumulateU32(contribution, (u32)fp->stock_count);
		contribution = syNetSyncFnvAccumulateU32(contribution, (u32)fp->lr);
		contribution = syNetSyncFnvAccumulateU32(contribution, (u32)(fp->ga != FALSE));

		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->physics.vel_air.x));
		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->physics.vel_air.y));
		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->physics.vel_air.z));
		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->physics.vel_ground.x));
		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->physics.vel_ground.z));
		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->physics.vel_damage_ground));

		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->coll_data.pos_prev.x));
		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->coll_data.pos_prev.y));
		contribution = syNetSyncFnvAccumulateU32(contribution, syNetSyncHashF32(fp->coll_data.pos_prev.z));

		slot = fp->player;

		if ((slot >= 0) && (slot < GMCOMMON_PLAYERS_MAX))
		{
			slot_hash[slot] =
				syNetSyncFnvAccumulateU32(slot_hash[slot] ^ contribution, (u32)slot ^ 0x9E3779B9U);
		}
		else
		{
			slot_hash[0] = syNetSyncFnvAccumulateU32(slot_hash[0] ^ contribution, (u32)slot ^ 0x85EBCA77U);
		}
	}
	{
		u32 merged = 2166136261U;

		for (si = 0; si < GMCOMMON_PLAYERS_MAX; si++)
		{
			merged = syNetSyncFnvAccumulateU32(merged ^ slot_hash[si], (u32)si);
		}
		return merged;
	}
}
