/* Included by peak_pd.c: typed inventory data, with locally rebuilt links.
 * This does not restore hand scripts, model allocation or world pickup state. */
enum { PEAK_INVENTORY_MAX = 128, PEAK_INVENTORY_AMMO = 33 };
struct peakInventory {
    int count, next, ammoNext, allguns, weapon, previous, switching, dual;
    int items[PEAK_INVENTORY_MAX][3], ammo[PEAK_INVENTORY_AMMO];
};
static struct peakInventory inventories[4];
static int inventoryRequired;

static struct prop *inventoryProp(unsigned int id)
{
    if (!id) return NULL;
    for (int i = 0; i < entityCapacity; ++i) if (entityIds[i] == id) return &g_Vars.props[i];
    return NULL;
}
static struct invitem *inventoryItem(struct player *p, int index)
{
    struct invitem *item = p->weapons;
    for (int i = 0; item && i <= index && i < p->equipmaxitems; ++i) {
        int found = 0;
        for (int j = 0; j < p->equipmaxitems; ++j) if (item == &p->equipment[j]) { found = 1; break; }
        if (!found) return NULL;
        if (i == index) return item;
        item = item->next;
        if (item == p->weapons) return NULL;
    }
    return NULL;
}
EMSCRIPTEN_KEEPALIVE int peakPdInventoryCount(int slot)
{
    if (busy || slot < 0 || slot > 3 || !peakPdPlayerEntity(slot)) return -1;
    struct player *p = g_Vars.players[slot];
    if (!p->weapons) return 0;
    for (int i = 0; i < PEAK_INVENTORY_MAX; ++i) {
        struct invitem *item = inventoryItem(p, i);
        if (!item) return -1;
        if (item->next == p->weapons) return i + 1;
    }
    return -1;
}
EMSCRIPTEN_KEEPALIVE double peakPdInventoryField(int slot, int index, int field)
{
    if (busy || slot < 0 || slot > 3 || !peakPdPlayerEntity(slot)) return NAN;
    struct player *p = g_Vars.players[slot];
    if (index == -1) {
        const int values[] = {p->equipallguns, p->gunctrl.weaponnum, p->gunctrl.prevweaponnum,
            p->gunctrl.switchtoweaponnum, p->gunctrl.dualwielding};
        return field >= 0 && field < 5 ? values[field] : NAN;
    }
    if (index == -2) return field >= 0 && field < PEAK_INVENTORY_AMMO ? p->ammoheldarr[field] : NAN;
    struct invitem *item = index >= 0 ? inventoryItem(p, index) : NULL;
    if (!item) return NAN;
    if (field == 0) return item->type;
    if (item->type == INVITEMTYPE_WEAP) return field == 1 ? item->type_weap.weapon1 : field == 2 ? item->type_weap.pickuppad : NAN;
    if (item->type == INVITEMTYPE_DUAL) return field == 1 ? item->type_dual.weapon1 : field == 2 ? item->type_dual.weapon2 : NAN;
    if (item->type == INVITEMTYPE_PROP) {
        if (field == 2) return 0;
        if (field == 1) for (int i = 0; i < entityCapacity; ++i)
            if (&g_Vars.props[i] == item->type_prop.prop && entityIds[i]) return entityIds[i];
    }
    return NAN;
}
static int inventoryCompatible(int slot)
{
    const struct peakInventory *s = &inventories[slot];
    const struct player *p = g_Vars.players[slot];
    return p && p->equipment && !p->isdead && s->count >= 0 && s->count <= p->equipmaxitems
        && s->weapon == p->gunctrl.weaponnum && s->previous == p->gunctrl.prevweaponnum
        && s->switching == p->gunctrl.switchtoweaponnum && s->dual == p->gunctrl.dualwielding;
}
static int inventoryValid(int slot)
{
    const struct peakInventory *s = &inventories[slot];
    if (!inventoryCompatible(slot) || s->next != s->count || s->ammoNext != PEAK_INVENTORY_AMMO) return 0;
    for (int i = 0; i < s->count; ++i) if (s->items[i][0] == INVITEMTYPE_PROP) {
        struct prop *prop = inventoryProp((unsigned int)s->items[i][1]);
        if (!prop || !prop->obj || (prop->type != PROPTYPE_OBJ && prop->type != PROPTYPE_WEAPON)) return 0;
    }
    return 1;
}
static void applyInventory(struct player *p, int slot)
{
    const struct peakInventory *s = &inventories[slot];
    for (int i = 0; i < p->equipmaxitems; ++i) p->equipment[i].type = -1;
    for (int i = 0; i < s->count; ++i) {
        struct invitem *item = &p->equipment[i];
        memset(item, 0, sizeof(*item)); item->type = s->items[i][0];
        if (item->type == INVITEMTYPE_WEAP) {
            item->type_weap.weapon1 = s->items[i][1]; item->type_weap.pickuppad = s->items[i][2];
        } else if (item->type == INVITEMTYPE_DUAL) {
            item->type_dual.weapon1 = s->items[i][1]; item->type_dual.weapon2 = s->items[i][2];
        } else item->type_prop.prop = inventoryProp((unsigned int)s->items[i][1]);
        item->next = &p->equipment[(i + 1) % s->count];
        item->prev = &p->equipment[(i + s->count - 1) % s->count];
    }
    p->weapons = s->count ? p->equipment : NULL;
    p->equipallguns = s->allguns;
    memcpy(p->ammoheldarr, s->ammo, sizeof(s->ammo));
    invCalculateCurrentIndex();
}
