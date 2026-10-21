#include "dvlnet/peak_net.h"
#include <emscripten.h>
#include <SDL.h>
namespace devilution::net {
EM_JS(int, peak_slot, (), { return Module['peakBridge'].slot; });
EM_JS(void, peak_send, (const unsigned char *data, int size), {
 Module['peakBridge'].send(HEAPU8.slice(data, data + size));
});
EM_JS(int, peak_receive, (unsigned char *data, int capacity), {
 const packet = Module['peakBridge'].queue.shift();
 if (!packet) return 0;
 if (packet.length > capacity) return -1;
 HEAPU8.set(packet, data); return packet.length;
});
int peak_net::create(std::string_view address) { return join(address); }
bool peak_net::IsGameHost() { return peak_slot() == 0; }
int peak_net::join(std::string_view) {
 cookie_self = packet_out::GenerateCookie();
 auto packet = pktfty->make_packet<PT_JOIN_REQUEST>(PLR_BROADCAST, PLR_MASTER, cookie_self, game_init_info);
 if (!packet || !send(**packet)) return -1;
 const double deadline = emscripten_get_now() + 120000;
 while (plr_self == PLR_BROADCAST && emscripten_get_now() < deadline) {
  if (!poll()) return -1;
  emscripten_sleep(10);
 }
 if (plr_self == PLR_BROADCAST) {
  SDL_SetError("The first player has not entered the game. Return to the room and try again.");
  return -1;
 }
 return plr_self;
}
std::expected<void, PacketError> peak_net::poll() {
 for (int i = 0; i < 512; ++i) {
  buffer_t data(65536);
  int size = peak_receive(data.data(), data.size());
  if (size < 0) return std::unexpected(PacketError("Room packet too large"));
  if (size == 0) break;
  data.resize(size);
  auto packet = pktfty->make_packet(data);
  if (!packet) return std::unexpected(packet.error());
  auto result = RecvLocal(**packet);
  if (!result) return result;
 }
 return {};
}
std::expected<void, PacketError> peak_net::send(packet &pkt) {
 const auto &data = pkt.Data();
 peak_send(data.data(), data.size());
 return {};
}
}

#include "game_mode.hpp"
#include "player.h"
extern "C" {
EMSCRIPTEN_KEEPALIVE int peakDiabloState() {
 return (devilution::gbRunGame ? 1 : 0) | (devilution::gbIsMultiplayer ? 2 : 0) | (devilution::gbIsSpawn ? 4 : 0);
}
EMSCRIPTEN_KEEPALIVE int peakDiabloPlayer(int slot, int field) {
 if (slot < 0 || static_cast<size_t>(slot) >= devilution::Players.size()) return -1;
 const auto &p = devilution::Players[slot];
 switch(field) {
 case 0: return p.plractive;
 case 1: return p.position.tile.x;
 case 2: return p.position.tile.y;
 case 3: return p.plrlevel;
 case 4: return p._pHitPoints;
 default: return -1;
 }
}
}
namespace { unsigned int peakTickCount = 0; }
extern "C" void peakDiabloTick() { ++peakTickCount; }
extern "C" EMSCRIPTEN_KEEPALIVE unsigned int peakDiabloTicks() { return peakTickCount; }
