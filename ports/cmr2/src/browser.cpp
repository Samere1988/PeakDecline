#include <emscripten.h>
#include <cstring>
#include "port/types.h"
#include "port/diagnostics.h"
#include "port/input.h"
#include "platform/platform.h"
#include "Game.h"
#include "Frontend.h"
#include "FrontendMenus.h"
#include "Menu.h"
#include "Car.h"
#include "NetPlayers.h"
extern Menu *FrontendMenu_GetActiveMenu();
extern Menu *g_pMenu0x00831778;
// Optional frame profiler; the runtime enables this only for diagnostics.
EM_JS(void, Peak_ProfileFrame, (int phase), {Module.cmr2ProfileFrame?.(phase);});
EM_JS(void, Peak_ReportState, (int mode, int menu, int count, int tick, int race, int cursor), {
    Module.cmr2State = {mode,menu,count,tick,race,cursor};
});
EM_JS(void, Peak_ReportMenu, (int index, const char *text), {
    if (!index) Module.cmr2Menu = [];
    Module.cmr2Menu.push(UTF8ToString(text));
});
EM_JS(void, Peak_ReportCar, (int index, int x, int y, int z, int speed), {
    Module.cmr2Cars ||= [];Module.cmr2Cars[index]={x,y,z,speed};Module.cmr2Car=Module.cmr2Cars[0];
});
namespace {
struct BrowserObserver : Diagnostics::Observer {
    int ticks = 0, race = 0;
    Menu *last = nullptr;
    void BeginFrame() override {Peak_ProfileFrame(0);}
    void BeginPresent() override {Peak_ProfileFrame(1);}
    void EndPresent() override {Peak_ProfileFrame(2);}
    void BeginTick(unsigned char state) override {race=state;}
    void EndTick() override {ticks++;for(int i=0;i<g_carCount&&i<8;i++){Car *car=Car_Get(i);if(car)Peak_ReportCar(i,car->position.x,car->position.y,car->position.z,car->speed);}}
    void EndFrame() override {
        Peak_ProfileFrame(3);
        int mode=CGame::GetFrontendResourceMode();
        Menu *menu = mode == 2 ? g_pMenu0x00831778 : FrontendMenu_GetActiveMenu();
        Peak_ReportState(mode, menu ? menu->field_0x4 : -1, menu ? menu->itemCount : 0, ticks, race, menu ? menu->cursor : -1);
        if (menu && menu != last) {
            for(int i=0; i<menu->itemCount; i++) {
                const char *text=menu->items[i].text ? menu->items[i].text : menu->items[i].id >= 0 ? CFrontend::GetTextString(menu->items[i].id) : "";
                Peak_ReportMenu(i,text);
            }
        }
        last=menu;
    }
} observer;
}
extern "C" void Peak_BrowserInit() {Diagnostics::observer=&observer;}
// Bounded menu bridge used for room startup and isolated browser acceptance.
extern "C" EMSCRIPTEN_KEEPALIVE int peak_menu_cursor(int index) {
    const int mode=CGame::GetFrontendResourceMode();
    if(mode==3)return 0;
    Menu *menu=mode==2 ? g_pMenu0x00831778 : FrontendMenu_GetActiveMenu();
    if(!menu||index<0||index>=menu->itemCount)return 0;
    menu->cursor=(BYTE)index;return 1;
}
extern void RallyData_SetEditedDriverOrCategoryName(unsigned int, char *);
extern void RallyData_CopyCategoryRecordName(BYTE, char *);
extern "C" EMSCRIPTEN_KEEPALIVE int peak_profile_name(const char *name) {
    if(!name||std::strlen(name)!=3)return 0;
    char tag[4];std::memcpy(tag,name,4);
    for(int i=0;i<3;i++)if(!((tag[i]>='A'&&tag[i]<='Z')||(tag[i]>='0'&&tag[i]<='9')))return 0;
    Menu *menu=FrontendMenu_GetActiveMenu();
    if(menu==FrontendMenu_GetProfileRenameEntry())RallyData_CopyCategoryRecordName((BYTE)FrontendProfile_GetCurrentPlayer(),tag);
    else RallyData_SetEditedDriverOrCategoryName(FrontendProfile_GetCurrentPlayer(),tag);
    if(menu==FrontendMenu_GetProfileNameEntry()||menu==FrontendMenu_GetProfileRenameEntry()){menu->cursor=2;menu->items[2].max=9;}
    return 1;
}
extern "C" EMSCRIPTEN_KEEPALIVE int peak_profile_tag(int slot) {
    if(slot<0||slot>=8)return 0;
    char tag[4]={'P','0',(char)('1'+slot),0};
    return peak_profile_name(tag);
}
extern "C" EMSCRIPTEN_KEEPALIVE int peak_network_ready() {
    Menu *menu=FrontendMenu_GetActiveMenu();
    if(menu!=FrontendMenu_GetNetworkSessionSetup())return 0;
    menu->items[3].max=0;return 1;
}
extern char g_unk0x00818ebc[20];
extern "C" EMSCRIPTEN_KEEPALIVE int peak_session_name() {
    Menu *menu=FrontendMenu_GetActiveMenu();
    if(menu!=FrontendMenu_GetNetworkSessionDetails())return 0;
    std::strcpy(g_unk0x00818ebc,"PeakDecline");return 1;
}

EM_JS(int, Peak_RoomSeat, (), {return Module.cmr2Transport?.slot || 0;});
void Peak_PrepareRequestedMenu(Menu *menu) {
    if(menu==FrontendMenu_GetProfileNameEntry()||menu==FrontendMenu_GetProfileRenameEntry())peak_profile_tag(Peak_RoomSeat());
    if(menu==FrontendMenu_GetNetworkSessionDetails())peak_session_name();
}
