#ifndef _SYNETSYNC_H_
#define _SYNETSYNC_H_

#include <ssb_types.h>

typedef struct SYNetSyncDigest
{
	u32 frame;
	s32 rng_seed;
	u32 time_remain;
	u32 time_passed;
	u32 item_count;
	u32 weapon_count;
	u64 rng_hash;
	u64 battle_hash;
	u64 fighter_hash[4];
	u64 stage_hash;
	u64 map_hash;
	u64 item_hash;
	u64 weapon_hash;
	u64 total_hash;

	/* Small explicit diagnostics persisted in replay .det traces so the first
	 * divergence can name concrete gameplay values rather than only a hash. */
	s32 fighter_status[4];
	s32 fighter_motion[4];
	s32 fighter_damage[4];
	s32 fighter_stock[4];
	u32 fighter_pos_x_bits[4];
	u32 fighter_pos_y_bits[4];
	u32 fighter_vel_x_bits[4];
	u32 fighter_vel_y_bits[4];

} SYNetSyncDigest;

extern u32 syNetSyncHashBattleFighters(void);
extern void syNetSyncComputeDeterministicDigest(u32 frame, SYNetSyncDigest *out_digest);
extern u64 syNetSyncComputeDeterministicStateHash(u32 frame);

/* Keep trace comparison independent from live game globals. This is used by
 * the in-game replay harness and by the desktop regression test. */
static inline sb32 syNetSyncDigestEqual(const SYNetSyncDigest *expected, const SYNetSyncDigest *actual)
{
	return ((expected != NULL) && (actual != NULL) &&
	        (expected->total_hash == actual->total_hash)) ? TRUE : FALSE;
}

static inline const char *syNetSyncDigestFirstMismatch(const SYNetSyncDigest *expected,
	                                                   const SYNetSyncDigest *actual)
{
	s32 player;
	if ((expected == NULL) || (actual == NULL)) return "invalid";
	if (expected->frame != actual->frame) return "frame";
	if (expected->rng_hash != actual->rng_hash) return "rng";
	if (expected->battle_hash != actual->battle_hash) return "battle";
	for (player = 0; player < 4; player++)
	{
		if (expected->fighter_hash[player] != actual->fighter_hash[player])
		{
			return (player == 0) ? "fighter0" : (player == 1) ? "fighter1" :
			       (player == 2) ? "fighter2" : "fighter3";
		}
	}
	if (expected->stage_hash != actual->stage_hash) return "stage";
	if (expected->map_hash != actual->map_hash) return "map";
	if (expected->item_hash != actual->item_hash) return "items";
	if (expected->weapon_hash != actual->weapon_hash) return "weapons";
	if (expected->total_hash != actual->total_hash) return "total";
	return "none";
}

extern void syNetSyncLogDigestMismatch(const SYNetSyncDigest *expected, const SYNetSyncDigest *actual);

#endif /* _SYNETSYNC_H_ */
