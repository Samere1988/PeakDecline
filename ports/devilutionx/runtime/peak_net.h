#pragma once
#include "dvlnet/base.h"
namespace devilution::net {
class peak_net : public base {
public:
 int create(std::string_view) override;
 int join(std::string_view) override;
 std::expected<void, PacketError> poll() override;
 std::expected<void, PacketError> send(packet &pkt) override;
 std::string make_default_gamename() override { return "Peak Decline"; }
protected:
 bool IsGameHost() override;
};
}
