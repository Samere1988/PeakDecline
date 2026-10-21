// DirectPlay-style API over PeakDecline's authenticated, server-owned rooms.
// The browser has no UDP socket, discovery broadcast or session-host transport.
#include "port/net.h"
#include <emscripten.h>
#include <cstring>
#include <deque>
#include <map>
#include <string>
#include <vector>

EM_JS(int, Peak_NetValue, (int field), {
    const t=Module.cmr2Transport;
    return t ? [t.slot+1,t.playerCount,t.created?1:0,t.coordinator+1][field] : 0;
});
EM_JS(void, Peak_NetDescription, (unsigned *out), {
    const d=Module.cmr2Transport?.description || [0x2064,8,0,0,0,0];
    for(let i=0;i<6;i++)HEAPU32[(out>>>2)+i]=d[i]>>>0;
});
EM_ASYNC_JS(int, Peak_NetCommand, (int kind, const char *name, const void *data, unsigned size), {
    const t=Module.cmr2Transport;
    if(!t)return 0;
    return await t.command({kind,name:name?UTF8ToString(name):'',payload:new Uint8Array(HEAPU8.subarray(data,data+size))});
});
EM_JS(int, Peak_NetSend, (unsigned from, unsigned to, int reliable, const void *data, unsigned size), {
    return Module.cmr2Transport?.send({from,to,reliable:!!reliable,payload:new Uint8Array(HEAPU8.subarray(data,data+size))}) ? 1 : 0;
});
EM_JS(int, Peak_NetPoll, (unsigned *header, unsigned char *buffer, unsigned capacity), {
    const q=Module.cmr2Transport?.queue;
    if(!q?.length)return 0;
    const e=q.shift(), bytes=new Uint8Array(e.payload||[]);
    if(bytes.length>capacity)return 0;
    const h=header>>>2;
    HEAPU32[h]=e.from||0;HEAPU32[h+1]=e.to||0;HEAPU32[h+2]=e.type||0;HEAPU32[h+3]=e.player||0;
    const name=new TextEncoder().encode(e.name||'').subarray(0,63);
    HEAPU8.fill(0,buffer,buffer+64);HEAPU8.set(name,buffer);HEAPU8.set(bytes,buffer+64);
    return bytes.length+65;
});
EM_JS(void, Peak_NetClosed, (), {
    const transport=Module.cmr2Transport;
    if(transport)setTimeout(()=>transport.nativeClose?.(),0);
});
namespace {
struct Player {std::string name;std::vector<unsigned char> data;};
struct Message {unsigned from=0,to=0,type=0,player=0;std::string name;std::vector<unsigned char> data;};
std::map<unsigned,Player> players;
std::deque<Message> inbox;
bool opened=false, initialized=false;
char sessionName[]="PeakDecline";
NetSessionDesc description;
void Desc(NetSessionDesc *out) {
    unsigned words[6];Peak_NetDescription(words);
    *out=description;out->dwSize=sizeof(*out);out->dwFlags=words[0];out->dwMaxPlayers=words[1];
    out->dwCurrentPlayers=Peak_NetValue(1);out->lpszSessionNameA=sessionName;out->lpszPasswordA=nullptr;
    out->dwUser1=words[2];out->dwUser2=words[3];out->dwUser3=words[4];out->dwUser4=words[5];
    // All peers in the authenticated room see the same synthetic session ID.
    std::memset(out->guidInstance.bytes,1,16);
}
void Pump() {
    unsigned header[4];unsigned char bytes[65536+64];int count;
    while((count=Peak_NetPoll(header,bytes,65536))) {
        Message m; m.from=header[0];m.to=header[1];m.type=header[2];m.player=header[3];
        m.name=(char*)bytes;m.data.assign(bytes+64,bytes+64+count-65);
        if(m.type==NET_SYS_CREATEPLAYER)players[m.player]={m.name,m.data};
        else if(m.type==NET_SYS_DESTROYPLAYER)players.erase(m.player);
        else if(m.type==NET_SYS_SETPLAYERDATA)players[m.player].data=m.data;
        // Bound the native queue even if the game temporarily stops receiving.
        if(inbox.size()<2048)inbox.push_back(std::move(m));
    }
}
size_t Align(size_t value){return(value+3)&~size_t(3);}
}
extern "C" HRESULT Net_EnumProviders(NetProviderCallback cb,void *ctx){if(cb)cb(0,"PeakDecline room",ctx);return NET_OK;}
extern "C" HRESULT Net_InitializeConnection(int provider){if(provider!=0)return NET_ERR_INVALIDPARAMS;initialized=true;return NET_OK;}
extern "C" HRESULT Net_EnumSessions(const NetGuid *app,DWORD,NetSessionCallback cb,void *ctx){
    if(!initialized)return NET_ERR_UNINITIALIZED;
    if(Peak_NetValue(2)&&cb){NetSessionDesc d;Desc(&d);if(app){d.guidApplication=*app;description.guidApplication=*app;}cb(&d,ctx);}return NET_OK;
}
extern "C" HRESULT Net_Open(const NetSessionDesc *d,DWORD flags){
    if(!initialized||!d)return NET_ERR_UNINITIALIZED;
    if(flags!=NET_OPEN_CREATE&&flags!=NET_OPEN_JOIN)return NET_ERR_INVALIDFLAGS;
    NetGuid application=description.guidApplication;
    description=*d;
    if(flags==NET_OPEN_JOIN)description.guidApplication=application;
    if(flags==NET_OPEN_CREATE){
        if(Peak_NetValue(0)!=Peak_NetValue(3))return NET_ERR_ACCESSDENIED;
        unsigned words[6]={d->dwFlags,d->dwMaxPlayers,d->dwUser1,d->dwUser2,d->dwUser3,d->dwUser4};
        if(!Peak_NetCommand(1,nullptr,words,sizeof(words)))return NET_ERR_ACCESSDENIED;
    }else if(!Peak_NetValue(2))return NET_ERR_NOCONNECTION;
    opened=true;return NET_OK;
}
extern "C" HRESULT Net_Close(){if(opened)Peak_NetClosed();opened=false;players.clear();inbox.clear();return NET_OK;}
extern "C" HRESULT Net_GetSessionDesc(NetSessionDesc *d){if(!opened||!d)return NET_ERR_NOCONNECTION;Pump();Desc(d);return NET_OK;}
extern "C" HRESULT Net_SetSessionDesc(const NetSessionDesc *d){
    if(!opened||!d)return NET_ERR_NOCONNECTION;
    if(Peak_NetValue(0)!=Peak_NetValue(3))return NET_ERR_ACCESSDENIED;
    unsigned words[6]={d->dwFlags,d->dwMaxPlayers,d->dwUser1,d->dwUser2,d->dwUser3,d->dwUser4};
    return Peak_NetCommand(2,nullptr,words,sizeof(words))?NET_OK:NET_ERR_ACCESSDENIED;
}
extern "C" HRESULT Net_CreatePlayer(NetPlayerID *id,const NetName *name,const void *data,DWORD size){
    if(!opened||!id||size>16)return NET_ERR_INVALIDPARAMS;
    *id=Peak_NetValue(0);const char *text=name&&name->lpszShortNameA?name->lpszShortNameA:"Player";
    if(!Peak_NetCommand(3,text,data,size))return NET_ERR_GENERIC;
    players[*id]={text,std::vector<unsigned char>((const unsigned char*)data,(const unsigned char*)data+size)};
    Pump();return NET_OK;
}
extern "C" HRESULT Net_DestroyPlayer(NetPlayerID id){if(id!=(unsigned)Peak_NetValue(0))return NET_ERR_INVALIDPLAYER;players.erase(id);return NET_OK;}
extern "C" HRESULT Net_EnumPlayers(NetPlayerCallback cb,void *ctx){Pump();if(cb)for(auto &p:players){NetName n={};n.dwSize=sizeof(n);n.lpszShortNameA=(char*)p.second.name.c_str();n.lpszLongNameA=n.lpszShortNameA;if(!cb(p.first,&n,ctx))break;}return NET_OK;}
extern "C" HRESULT Net_SetPlayerData(NetPlayerID id,const void *data,DWORD size){
    if(id!=(unsigned)Peak_NetValue(0)||size>16)return NET_ERR_INVALIDPLAYER;
    return Peak_NetCommand(4,nullptr,data,size)?NET_OK:NET_ERR_GENERIC;
}
extern "C" HRESULT Net_Send(NetPlayerID from,NetPlayerID to,BOOL reliable,const void *data,DWORD size){
    if(!opened||from!=(unsigned)Peak_NetValue(0)||!data||size>65536)return NET_ERR_INVALIDPARAMS;
    return Peak_NetSend(from,to,reliable,data,size)?NET_OK:NET_ERR_CONNECTIONLOST;
}
extern "C" HRESULT Net_Receive(NetPlayerID *from,NetPlayerID *to,void *data,DWORD *size){
    Pump();if(!size)return NET_ERR_INVALIDPARAMS;if(inbox.empty())return NET_ERR_NOMESSAGES;
    const Message &m=inbox.front();size_t header=0;
    switch(m.type){case NET_SYS_CREATEPLAYER:header=sizeof(NetMsgCreatePlayer);break;case NET_SYS_DESTROYPLAYER:header=sizeof(NetMsgDestroyPlayer);break;case NET_SYS_SETPLAYERDATA:header=sizeof(NetMsgSetPlayerData);break;case NET_SYS_SETSESSIONDESC:header=sizeof(NetMsgSetSessionDesc);break;default:header=m.type?4:0;}
    size_t offset=Align(header+(m.type==NET_SYS_CREATEPLAYER||m.type==NET_SYS_DESTROYPLAYER?m.name.size()+1:0));
    size_t need=header?offset+m.data.size():m.data.size();
    if(!data||*size<need){*size=need;return NET_ERR_BUFFERTOOSMALL;}
    auto out=(unsigned char*)data;std::memset(out,0,need);if(!m.data.empty())std::memcpy(out+offset,m.data.data(),m.data.size());
    if(m.type==NET_SYS_CREATEPLAYER){NetMsgCreatePlayer msg={};msg.dwType=m.type;msg.dwPlayerType=1;msg.dpId=m.player;msg.dwCurrentPlayers=players.size();msg.lpData=m.data.empty()?nullptr:out+offset;msg.dwDataSize=m.data.size();msg.dpnName.dwSize=sizeof(NetName);std::memcpy(out+header,m.name.c_str(),m.name.size()+1);msg.dpnName.lpszShortNameA=msg.dpnName.lpszLongNameA=(char*)out+header;std::memcpy(out,&msg,sizeof(msg));}
    else if(m.type==NET_SYS_DESTROYPLAYER){NetMsgDestroyPlayer msg={};msg.dwType=m.type;msg.dwPlayerType=1;msg.dpId=m.player;msg.dpnName.dwSize=sizeof(NetName);std::memcpy(out+header,m.name.c_str(),m.name.size()+1);msg.dpnName.lpszShortNameA=msg.dpnName.lpszLongNameA=(char*)out+header;std::memcpy(out,&msg,sizeof(msg));}
    else if(m.type==NET_SYS_SETPLAYERDATA){NetMsgSetPlayerData msg={};msg.dwType=m.type;msg.dwPlayerType=1;msg.dpId=m.player;msg.lpData=out+offset;msg.dwDataSize=m.data.size();std::memcpy(out,&msg,sizeof(msg));}
    else if(m.type==NET_SYS_SETSESSIONDESC){NetMsgSetSessionDesc msg={};msg.dwType=m.type;Desc(&msg.dpDesc);std::memcpy(out,&msg,sizeof(msg));}
    else if(m.type)std::memcpy(out,&m.type,4);
    if(from)*from=m.type?NET_ID_SYSTEM:m.from;if(to)*to=m.to?m.to:Peak_NetValue(0);*size=need;inbox.pop_front();return NET_OK;
}
