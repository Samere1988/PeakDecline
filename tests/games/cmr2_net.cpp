// Exercise the real game code; no reimplementation of sequence arithmetic.
#include "port/types.h"
#include "port/net.h"
#include "NetPlayers.h"
#include "Car.h"
#include "Sector.h"
#include <cstdio>
#include <cstring>

extern void NetPlayers_ReceiveStatistics(NetPlayerID *, NetStats *);
extern int NetRace_DecodeReceivedCarState(CarNetRecord *, int *);
extern NetStats g_localCarStats;

int main()
{
    int failures = 0;
    const auto check = [&](bool condition, const char *message) {
        if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message); failures++; }
    };
    g_unk0x00539cc8 = 1;
    NetPlayerID id = 2;
    std::memset(g_netPlayers, 0, sizeof(g_netPlayers));
    g_netPlayers[0].id = id;
    g_netPlayers[0].flags = 0x80;
    NetStats packet = {};
    const auto receive = [&](unsigned short previous, unsigned short next, bool accepted) {
        g_netPlayers[0].stats.seq = previous;
        g_netPlayers[0].statsNew = 0;
        packet.seq = next;
        NetPlayers_ReceiveStatistics(&id, &packet);
        check(bool(g_netPlayers[0].statsNew) == accepted, "receiver sequence acceptance");
        check(g_netPlayers[0].stats.seq == (accepted ? next : previous), "receiver sequence value");
    };
    receive(100, 101, true);
    receive(100, 100, false);
    receive(100, 99, false);
    receive(100, 250, true);
    receive(65535, 0, true);
    receive(65530, 5, true);
    receive(5, 65530, false);

    Sector sector = {};
    sector.x = 12345;
    g_sectors[0] = &sector;
    g_sectorCount = 1;
    const auto decode = [&](unsigned short previous, unsigned short next, bool accepted) {
        CarNetRecord car = {};
        car.lastSeq = previous;
        g_localCarStats = {};
        g_localCarStats.seq = next;
        int steering = 0;
        check(bool(NetRace_DecodeReceivedCarState(&car, &steering)) == accepted, "decoder sequence acceptance");
        check(car.lastSeq == (accepted ? next : previous), "decoder must advance after an outage");
        if (accepted) check(car.position.x == sector.x, "decoder must apply the recovered position");
    };
    decode(100, 101, true);
    decode(100, 199, true);
    decode(100, 200, true);
    decode(100, 250, true);
    decode(100, 251, true);
    decode(65535, 0, true);
    decode(65530, 5, true);
    decode(5, 65530, false);
    decode(100, 100, false);
    decode(100, 99, false);
    if (!failures) std::puts("PASS native car-state loss recovery, rollover, duplicate and stale-packet rejection");
    return failures ? 1 : 0;
}
