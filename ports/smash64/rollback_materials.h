/* Material animation has gameplay consumers (notably Yoshi's Island clouds).
 * There are ten ordinary material tracks plus five color tracks. */
#define PEAK_MATERIAL_MAX 512
#define PEAK_MATERIAL_TRACK_MAX 15
typedef struct PeakAnimTrackState {
    AObj *ptr;
    AObj state;
} PeakAnimTrackState;
typedef struct PeakMaterialState {
    MObj *ptr;
    MObj state;
    u32 track_count;
    PeakAnimTrackState tracks[PEAK_MATERIAL_TRACK_MAX];
} PeakMaterialState;
struct SYNetRollbackSnapshot;
static void peak_rb_save_materials(struct SYNetRollbackSnapshot*);
static void peak_rb_restore_materials(const struct SYNetRollbackSnapshot*);
static void peak_rb_collect_materials(u32);
static void peak_rb_reset_materials(void);
static u32 peak_rb_save_tracks(AObj*, PeakAnimTrackState*, u32, sb32*);
static void peak_rb_restore_tracks(AObj**, const PeakAnimTrackState*, u32);
