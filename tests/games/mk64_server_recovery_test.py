"""Active Retro MK64 recovery and spectator isolation; no production databases."""
import unittest
from unittest.mock import patch

import retro_test
from retro_package import rooms as relay


class MK64RecoveryTests(unittest.TestCase):
    connect = retro_test.RetroTests.connect
    emit = retro_test.RetroTests.emit
    events = retro_test.RetroTests.events

    def setUp(self):
        retro_test.RetroTests.setUp(self)
        background = patch.object(self.sio, 'start_background_task')
        self.background = background.start()
        self.addCleanup(background.stop)

    def close_clients(self):
        for client in self.clients:
            if client.is_connected('/retro'):
                self.emit(client, 'leave')
                client.disconnect(namespace='/retro')

    def race(self, watcher=False, start=True):
        racers = [self.connect('racer-' + str(i)) for i in range(2)]
        self.emit(racers[0], 'create', dict(name='Recovery', gameId='mk64', compatibility=self.descriptor))
        host = self.events(racers[0], 'room')[0]
        self.code = host['code']
        self.seats = [host]
        people = racers[:]
        if watcher:
            people.append(self.connect('watcher'))
        for person in people[1:]:
            self.emit(person, 'join', dict(code=self.code, compatibility=self.descriptor))
            self.seats.append(self.events(person, 'room')[0])
        for racer in racers:
            self.emit(racer, 'role', dict(role='player'))
            self.emit(racer, 'ready', dict(ready=True))
        self.emit(racers[0], 'start_game')
        if start:
            for person in people:
                self.emit(person, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        for person in people:
            person.get_received('/retro')
        return people

    def input(self, client, frame, buttons=0):
        self.emit(client, 'input', dict(epoch=0, frame=frame, pad=dict(buttons=buttons, x=0, y=0)))

    def resume(self, client, seat=0, frame=0, **overrides):
        payload = dict(code=self.code, token=self.seats[seat]['resumeToken'],
                       compatibility=self.descriptor, retained=True, epoch=0, frame=frame)
        payload.update(overrides)
        self.emit(client, 'resume', payload)

    def test_retained_player_replays_and_releases_preserved_pending_inputs(self):
        host, guest = self.race()
        self.input(host, 1, 1)
        self.input(guest, 1, 2)
        self.input(host, 2, 3)
        host.disconnect(namespace='/retro')
        stale_timeout, *stale_args = self.background.call_args.args
        self.assertTrue(self.events(guest, 'transport_paused'))
        self.input(guest, 2, 4)
        self.assertFalse(self.events(guest, 'frameset'))
        recovered = self.connect('racer-0')
        self.resume(recovered)
        events = recovered.get_received('/retro')
        resumed = next(event['args'][0] for event in events if event['name'] == 'resumed')
        self.assertEqual(resumed['completed'], 1)
        self.assertFalse(resumed['paused'])
        self.assertEqual([packet['frame'] for packet in resumed['frames']], [1])
        self.assertEqual(resumed['host'], resumed['memberId'])
        frames = [event['args'][0] for event in events if event['name'] == 'frameset']
        self.assertEqual([packet['frame'] for packet in frames], [2])
        self.assertEqual([pad['buttons'] for pad in frames[0]['pads']], [3, 4])
        with patch.object(self.sio, 'sleep'):
            stale_timeout(*stale_args)
        # Repeating the exact sent input after recovery is harmless.
        self.input(recovered, 2, 3)
        self.input(recovered, 3, 5)
        self.input(guest, 3, 6)
        self.assertEqual(self.events(recovered, 'frameset')[0]['frame'], 3)
        self.assertFalse(self.events(guest, 'stopped'))

    def test_reconnect_waits_for_every_disconnected_racer(self):
        host, guest = self.race()
        host.disconnect(namespace='/retro')
        guest.disconnect(namespace='/retro')
        first = self.connect('racer-0')
        self.resume(first)
        self.assertTrue(self.events(first, 'resumed')[0]['paused'])
        self.input(first, 1)
        second = self.connect('racer-1')
        self.resume(second, seat=1)
        self.assertTrue(self.events(first, 'transport_resumed'))
        self.input(second, 1)
        self.assertEqual(self.events(first, 'frameset')[0]['frame'], 1)

    def test_resume_rejects_wrong_account_epoch_missing_state_and_expired_grace(self):
        host, guest = self.race()
        host.disconnect(namespace='/retro')
        intruder = self.connect('intruder')
        self.resume(intruder)
        self.assertTrue(self.events(intruder, 'room_error'))
        recovered = self.connect('racer-0')
        for override in (dict(epoch=1), dict(epoch=True), dict(frame=True), dict(frame=1), dict(retained=False)):
            self.resume(recovered, **override)
            self.assertTrue(self.events(recovered, 'room_error'))
        with patch.object(relay, 'monotonic', return_value=relay.monotonic() + 16):
            self.resume(recovered)
        self.assertTrue(self.events(recovered, 'room_error'))
        self.resume(recovered)
        self.assertTrue(self.events(recovered, 'resumed'))

    def test_recovery_preserves_pending_hash_identity(self):
        host, guest = self.race()
        self.input(host, 1)
        self.input(guest, 1)
        self.emit(host, 'hash', dict(epoch=0, frame=1, hash=100))
        host.disconnect(namespace='/retro')
        recovered = self.connect('racer-0')
        self.resume(recovered, frame=1)
        self.emit(guest, 'hash', dict(epoch=0, frame=1, hash=200))
        self.assertTrue(self.events(recovered, 'stopped'))

    def test_spectator_reconnect_does_not_pause_racers_and_history_is_bounded(self):
        host, guest, watcher = self.race(watcher=True)
        with patch.object(relay, 'MK64_HISTORY', 3):
            for frame in range(1, 6):
                self.input(host, frame)
                self.input(guest, frame)
        watcher.disconnect(namespace='/retro')
        self.assertFalse(self.events(host, 'transport_paused'))
        recovered = self.connect('watcher')
        self.resume(recovered, seat=2, frame=1)
        self.assertTrue(self.events(recovered, 'room_error'))
        self.resume(recovered, seat=2, frame=2)
        resumed = self.events(recovered, 'resumed')[0]
        self.assertEqual([row['frame'] for row in resumed['frames']], [3, 4, 5])
        self.assertFalse(resumed['paused'])

    def test_spectator_expiry_runs_without_request_context_and_racers_continue(self):
        host, guest, watcher = self.race(watcher=True)
        watcher.disconnect(namespace='/retro')
        timeout, *args = self.background.call_args.args
        with patch.object(self.sio, 'sleep'):
            timeout(*args)
        self.input(host, 1)
        self.input(guest, 1)
        self.assertTrue(self.events(host, 'frameset'))
        self.assertFalse(self.events(guest, 'stopped'))

    def test_failed_loading_spectator_is_removed_before_start(self):
        host, guest, watcher = self.race(watcher=True, start=False)
        for racer in (host, guest):
            self.emit(racer, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        self.assertFalse(self.events(host, 'start'))
        self.emit(watcher, 'failed', dict(epoch=0, message='WASM failed'))
        events = host.get_received('/retro')
        self.assertTrue(any(event['name'] == 'start' for event in events))
        self.assertFalse(any(event['name'] == 'stopped' for event in events))
        self.input(host, 1)
        self.input(guest, 1)
        self.assertTrue(self.events(host, 'frameset'))
        self.assertFalse(self.events(watcher, 'frameset'))

    def test_loading_timeout_ejects_spectator_but_starts_loaded_racers(self):
        host, guest, watcher = self.race(watcher=True, start=False)
        timeout, *args = self.background.call_args.args
        for racer in (host, guest):
            self.emit(racer, 'loaded', dict(epoch=0, compatibility=self.descriptor))
        with patch.object(self.sio, 'sleep'):
            timeout(*args)
        self.assertTrue(self.events(host, 'start'))
        self.assertTrue(self.events(watcher, 'stopped'))

    def test_reconnect_expiry_stops_race_and_intentional_leave_has_no_grace(self):
        host, guest = self.race()
        host.disconnect(namespace='/retro')
        timeout, *args = self.background.call_args.args
        with patch.object(self.sio, 'sleep'):
            timeout(*args)
        self.assertTrue(self.events(guest, 'stopped'))
        recovered = self.connect('racer-0')
        self.resume(recovered)
        self.assertTrue(self.events(recovered, 'room_error'))
        self.emit(guest, 'leave')
        host, guest = self.race()
        self.emit(host, 'leave')
        self.assertTrue(self.events(guest, 'stopped'))

    def test_creating_room_during_slow_fingerprint_does_not_delay_existing_inputs(self):
        import gevent
        from pathlib import Path
        self.app, self.sio = retro_test.make_app(Path(self.tmp.name), async_mode='gevent')
        with patch.object(self.sio, 'start_background_task'):
            host, guest = self.race()
            newcomer = self.connect('newcomer')
            entered = []

            def slow_descriptor(game, app):
                entered.append(True)
                gevent.sleep(.05)
                return dict(self.descriptor)

            with patch.object(retro_test.Game, 'descriptor', slow_descriptor):
                create = gevent.spawn(self.emit, newcomer, 'create',
                    dict(name='New race', gameId='mk64', compatibility=self.descriptor))
                gevent.sleep(.001)
                self.assertTrue(entered)
                self.input(host, 1)
                self.input(guest, 1)
                self.assertFalse(create.ready(), 'Creating the new room blocked the current race')
                self.assertEqual(self.events(host, 'frameset')[0]['frame'], 1)
                create.get(timeout=1)

    def test_disconnecting_during_fingerprint_does_not_create_orphan_room(self):
        import gevent
        from pathlib import Path
        self.app, self.sio = retro_test.make_app(Path(self.tmp.name), async_mode='gevent')
        creator = self.connect('creator')
        observer = self.connect('observer')

        def slow_descriptor(game, app):
            gevent.sleep(.03)
            return dict(self.descriptor)

        with patch.object(retro_test.Game, 'descriptor', slow_descriptor):
            create = gevent.spawn(self.emit, creator, 'create',
                dict(name='Cancelled race', gameId='mk64', compatibility=self.descriptor))
            gevent.sleep(.001)
            creator.disconnect(namespace='/retro')
            create.get(timeout=1)
        self.emit(observer, 'list')
        self.assertEqual(self.events(observer, 'rooms')[-1], [])


if __name__ == '__main__':
    unittest.main()
