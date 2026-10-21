"""Exercise room-owned admission, routing and controller departure."""
import struct
import unittest
from retro_test import netplay
from retro_package.cmr2 import CMR2Relay, CREATE, DESTROY, HOST


class CMR2RelayTests(unittest.TestCase):
    def setUp(self):
        self.relay = CMR2Relay(3)
        self.desc = dict(kind=1, payload=struct.pack('<6I', 0x2064, 99, 8, 0, 0, 0))
        self.relay.command(0, self.desc)
        for seat in range(3):
            self.relay.command(seat, dict(kind=3, name='P'+str(seat), payload=bytes(16)))

    def test_server_owns_capacity_and_player_ids(self):
        self.assertEqual(self.relay.state()['description'][1], 3)
        with self.assertRaises(ValueError):
            self.relay.command(1, self.desc)
        with self.assertRaises(ValueError):
            self.relay.packet(1, dict(from_=1, to=0, payload=b'\x0b'+bytes(31), reliable=False))
        with self.assertRaises(ValueError):
            self.relay.command(0, dict(kind=3, name='duplicate', payload=bytes(16)))

    def test_private_and_broadcast_routing(self):
        packet = {'from': 2, 'to': 0, 'payload': b'\x0b'+bytes(31), 'reliable': False}
        deliveries = self.relay.packet(1, packet)
        self.assertEqual([seat for seat, _ in deliveries], [0, 2])
        packet['to'] = 3
        self.assertEqual([seat for seat, _ in self.relay.packet(1, packet)], [2])
        self.assertTrue(all(message['payload'] == packet['payload'] for _, message in deliveries))

    def test_controller_leaves_without_ending_other_racers(self):
        events = self.relay.leave(0)
        self.assertEqual(self.relay.coordinator, 1)
        self.assertEqual([seat for seat, event in events if event['type'] == DESTROY], [1, 2])
        self.assertEqual([seat for seat, event in events if event['type'] == HOST], [1])
        packet = {'from': 2, 'to': 0, 'payload': b'\x0b'+bytes(31), 'reliable': False}
        self.assertEqual([seat for seat, _ in self.relay.packet(1, packet)], [2])
        self.relay.command(1, self.desc)
        with self.assertRaises(ValueError):
            self.relay.packet(0, dict(packet, **{'from': 1}))

    def test_newcomer_gets_existing_players(self):
        relay = CMR2Relay(2)
        relay.command(0, self.desc)
        relay.command(0, dict(kind=3, name='First', payload=bytes(16)))
        events = relay.command(1, dict(kind=3, name='Second', payload=bytes(16)))
        self.assertEqual([(seat, event['player'], event['type']) for seat, event in events], [(1, 1, CREATE), (0, 2, CREATE)])

class CMR2CapacityTests(unittest.TestCase):
    def test_eight_racers_at_native_tick_rate_and_repeated_coordinator_departure(self):
        from unittest.mock import patch
        with patch('retro_package.native.monotonic', return_value=0) as clock:
            relay=CMR2Relay(8)
            relay.command(0,dict(kind=1,payload=struct.pack('<6I',0x2064,8,8,0,0,0)))
            for seat in range(8):
                relay.command(seat,dict(kind=3,name='P'+str(seat),payload=bytes(16)))
            deliveries=0
            for tick in range(250):
                clock.return_value=tick/25
                for seat in range(8):
                    for target in range(8):
                        if target==seat:continue
                        packet={'from':seat+1,'to':target+1,'payload':b'\x0b'+bytes(127),'reliable':False}
                        result=relay.packet(seat,packet)
                        self.assertEqual([slot for slot,_ in result],[target])
                        deliveries+=len(result)
            self.assertEqual(deliveries,14000)
            for seat in range(7):
                relay.leave(seat)
                self.assertEqual(relay.coordinator,seat+1)
                self.assertEqual(set(relay.roster),set(range(seat+1,8)))


class CMR2RoomTests(unittest.TestCase):
    def test_authenticated_room_survives_first_racer_departure(self):
        self.survives_departure('leave')

    def test_authenticated_room_survives_coordinator_disconnect(self):
        self.survives_departure('disconnect')

    def test_authenticated_room_survives_coordinator_runtime_failure(self):
        self.survives_departure('failed')

    def survives_departure(self, departure):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from retro_test import make_app, Game
        with tempfile.TemporaryDirectory() as directory:
            app, sio = make_app(Path(directory))
            descriptor = dict(id='cmr2', title='Colin McRae Rally 2.0', maxPlayers=8, tickRate=30,
                              inputSchema='cmr2-native-message-v1', backend='cmr2-server-relay-v1',
                              adapter='cmr2', protocol=1, build='fixture', available=True)
            clients=[]
            with patch.object(Game, 'descriptor', lambda game, app: descriptor):
                for user in ('first', 'second', 'third'):
                    http=app.test_client();http.get('/test-login/'+user)
                    clients.append(sio.test_client(app,namespace='/retro',flask_test_client=http))
                def emit(client,event,data=None):return client.emit(event,data,namespace='/retro',callback=True)
                def events(client,name):return [event['args'][0] for event in client.get_received('/retro') if event['name']==name]
                emit(clients[0],'create',dict(name='Rally',gameId='cmr2',compatibility=descriptor))
                code=events(clients[0],'room')[0]['code']
                for client in clients[1:]:emit(client,'join',dict(code=code,compatibility=descriptor));emit(client,'role',dict(role='player'))
                for client in clients:emit(client,'ready',dict(ready=True))
                emit(clients[0],'start_game')
                for client in clients:emit(client,'loaded',dict(epoch=0,compatibility=descriptor))
                self.assertTrue(events(clients[1],'start'))
                command=dict(epoch=0,kind=1,payload=struct.pack('<6I',0x2064,8,8,0,0,0))
                self.assertTrue(emit(clients[0],'cmr2_command',command)['ok'])
                for seat,client in enumerate(clients):
                    self.assertTrue(emit(client,'cmr2_command',dict(epoch=0,kind=3,name='P'+str(seat),payload=bytes(16)))['ok'])
                for client in clients:client.get_received('/retro')
                if departure == 'disconnect':
                    clients[0].disconnect(namespace='/retro')
                elif departure == 'failed':
                    emit(clients[0],'failed',dict(epoch=0,message='GPU device lost'))
                else:
                    emit(clients[0],'leave')
                self.assertFalse(events(clients[1],'stopped'))
                self.assertEqual(events(clients[2],'room_update')[-1]['phase'],'running')
                self.assertTrue(emit(clients[1],'cmr2_command',command)['ok'])
                for client in clients[1:]:client.get_received('/retro')
                message={'epoch':0,'from':2,'to':3,'payload':b'\x0b'+bytes(31),'reliable':False}
                emit(clients[1],'cmr2_packet',message)
                self.assertEqual(events(clients[2],'cmr2_event')[0]['from'],2)
                emit(clients[1],'cmr2_packet',dict(message,epoch=99))
                self.assertFalse(events(clients[2],'cmr2_event'))
                emit(clients[1],'cmr2_packet',dict(message,**{'from':1}))
                self.assertFalse(events(clients[2],'cmr2_event'))
                for client in clients:
                    if client.is_connected('/retro'):client.disconnect(namespace='/retro')


if __name__ == '__main__':
    unittest.main()
