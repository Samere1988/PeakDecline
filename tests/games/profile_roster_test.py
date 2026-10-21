"""Profile avatars stay attached to members in the active Retro Games relay."""
import unittest
import retro_test


class RosterTests(unittest.TestCase):
    def test_avatars_follow_members_when_joining_and_starting(self):
        fixture = retro_test.RetroTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        clients, _ = fixture.room()
        fixture.emit(clients[0], 'list')
        room = fixture.events(clients[0], 'rooms')[-1][0]
        expected = {person['id']: person['avatar'] for person in room['members']}
        self.assertTrue(all(expected.values()))
        fixture.emit(clients[0], 'start_game')
        prepared = fixture.events(clients[0], 'prepare')[0]
        self.assertEqual({person['id']: person['avatar'] for person in prepared['members']}, expected)


if __name__ == '__main__':
    unittest.main()
