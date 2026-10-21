import unittest
from unittest.mock import patch
from retro_test import RetroTests
from retro_package.telemetry import LIMITS, RENDER_LIMITS, validate


def sample(**changes):
    values={key:0 for key in LIMITS}
    values.update(epoch=0,windowMs=10000,frames=600,frame=600,displayFrames=600,
                  hidden=False,transport='websocket',rttMs=None,rttMaxMs=None)
    values.update(changes)
    return values

class Validation(unittest.TestCase):
    def test_optional_render_timings_are_bounded(self):
        render={key:0 for key in RENDER_LIMITS}
        render.update(samples=500,p95Ms=17,p99Ms=67,maxMs=67.4,over50=10,renderMs=51.2,waitMs=16.2)
        self.assertEqual(validate(sample(render=render))['render'],render)
        for changes in ({'renderMs':float('nan')},{'samples':0},{'over50':501},
                        {'over100':11},{'p99Ms':2},{'maxMs':True},{'extra':'bad'}):
            self.assertIsNone(validate(sample(render=dict(render,**changes))),changes)
        self.assertIsNone(validate(sample(render='bad')))

    def test_rejects_unbounded_or_unexpected_values(self):
        self.assertIsNotNone(validate(sample()))
        for changes in ({'frames':float('nan')},{'frame':True},{'windowMs':0},
                        {'hidden':'no'},{'transport':'x'*10000},{'noProgressMs':11000},
                        {'rttMs':float('inf')},{'user':'spoof'},{'epoch':False}):
            self.assertIsNone(validate(sample(**changes)),changes)

class Reports(unittest.TestCase):
    setUp=RetroTests.setUp
    close_clients=RetroTests.close_clients
    connect=RetroTests.connect
    emit=RetroTests.emit
    events=RetroTests.events
    room=RetroTests.room
    start=RetroTests.start
    def test_authenticated_room_epoch_rate_limit_and_server_identity(self):
        clients,code=self.room(2);self.start(clients)
        outsider=self.connect('outside')
        with patch('retro_package.rooms.record_diagnostics') as record:
            self.emit(outsider,'diagnostics',sample())
            self.emit(clients[0],'diagnostics',sample(epoch=9))
            self.emit(clients[0],'diagnostics',sample(game='fake'))
            record.assert_not_called()
            self.emit(clients[0],'diagnostics',sample())
            record.assert_called_once()
            args,values=record.call_args
            self.assertEqual(args[0],'sample');self.assertEqual(args[1],code)
            self.assertEqual(values['gameFps'],60);self.assertEqual(values['targetFps'],30)
            self.emit(clients[0],'diagnostics',sample());record.assert_called_once()
            self.emit(clients[1],'diagnostics',sample());self.assertEqual(record.call_count,2)
    def test_desync_is_a_server_event(self):
        clients,code=self.room(2);self.start(clients)
        for client in clients:self.emit(client,'input',dict(epoch=0,frame=1,pad=dict(buttons=0,x=0,y=0)))
        with patch('retro_package.rooms.record_diagnostics') as record:
            self.emit(clients[0],'hash',dict(epoch=0,frame=1,hash=10))
            self.emit(clients[1],'hash',dict(epoch=0,frame=1,hash=11))
            self.assertEqual(record.call_args.args[0],'desync')

class Summary(unittest.TestCase):
    def test_normal_play_excludes_loading_and_keeps_desync_events(self):
        import json, runpy
        from retro_test import ROOT
        summarize=runpy.run_path(str(ROOT/'tools/netplay_report.py'))['summarize']
        base=dict(room='AB12',name='Friends',game='smash64',epoch=0,peer='anonymous',role='player',slot=0,event='sample')
        rows=[dict(base,**sample(),gameFps=60),dict(base,**sample(frames=300,noProgressMs=2500),gameFps=30),
              dict(base,**sample(hiddenMs=10000,frames=0),gameFps=0),dict(base,event='desync')]
        result=summarize(['NETPLAY '+json.dumps(row) for row in rows],'friends')[0]
        peer=result['peers']['anonymous']
        self.assertEqual(peer['averageGameFps'],45)
        self.assertEqual(peer['minFps'],30)
        self.assertEqual(peer['noProgressPercent'],12.5)
        self.assertEqual(peer['hiddenMs'],10000)
        self.assertEqual(result['events']['desync'],1)

    def test_render_summary_keeps_worst_frame_phases_together(self):
        import json, runpy
        from retro_test import ROOT
        summarize=runpy.run_path(str(ROOT/'tools/netplay_report.py'))['summarize']
        base=dict(room='AB12',name='Test',game='cmr2',epoch=0,peer='anonymous',role='player',slot=0,event='sample',gameFps=60)
        render=dict(samples=600,p95Ms=17,p99Ms=18,maxMs=25,over50=0,over100=0,recordMs=1,renderMs=4,waitMs=19,idleMs=1)
        bad=dict(render,maxMs=67,over50=3,renderMs=51,waitMs=14)
        rows=[dict(base,**sample(render=r)) for r in (bad,render)]
        result=summarize(['NETPLAY '+json.dumps(row) for row in rows])[0]['peers']['anonymous']['render']
        self.assertEqual(result['samples'],1200)
        self.assertEqual(result['over50'],3)
        self.assertEqual(result['worstFrame']['maxMs'],67)
        self.assertEqual(result['worstFrame']['renderMs'],51)

if __name__=='__main__':unittest.main()
