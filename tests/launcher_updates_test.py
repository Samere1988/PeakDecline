"""Installed-client authorization, private artifacts and range downloads."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from flask import Flask
from app.launcher_updates import register


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.app = Flask(__name__, instance_path=self.temporary.name)
        self.app.config['TESTING'] = True
        register(self.app)
        self.client = self.app.test_client()
        self.root = Path(self.temporary.name) / 'launcher-updates'
        (self.root / 'objects').mkdir(parents=True)
        self.token = 'test-client-only'
        (self.root / 'credential.sha256').write_text(hashlib.sha256(self.token.encode()).hexdigest())
        (self.root / 'latest.json').write_bytes(b'{"signed":"fixture"}')
        self.payload = b'private binary update'
        self.digest = hashlib.sha256(self.payload).hexdigest()
        (self.root / 'objects' / self.digest).write_bytes(self.payload)
        self.headers = {'Authorization': 'Bearer ' + self.token}

    def tearDown(self):
        self.temporary.cleanup()

    def test_authorization_required_for_every_endpoint_and_range(self):
        for path in ('latest', 'objects/' + self.digest):
            for headers in ({}, {'Authorization': 'Bearer wrong'}, {'Range': 'bytes=0-2'}):
                self.assertEqual(self.client.get('/launcher-updates/' + path, headers=headers).status_code, 404)

    def test_authenticated_manifest_and_objects(self):
        response = self.client.get('/launcher-updates/latest', headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {'signed': 'fixture'})
        self.assertIn('no-store', response.headers['Cache-Control'])
        self.assertIn('Authorization', response.headers['Vary'])
        response.close()
        response = self.client.get('/launcher-updates/objects/' + self.digest, headers=self.headers)
        self.assertEqual(response.data, self.payload)
        response.close()

    def test_range_and_head(self):
        path = '/launcher-updates/objects/' + self.digest
        response = self.client.get(path, headers=self.headers | {'Range': 'bytes=0-6'})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, self.payload[:7])
        response.close()
        response = self.client.head(path, headers=self.headers)
        self.assertEqual(response.content_length, len(self.payload))
        response.close()

    def test_missing_malformed_and_linked_objects(self):
        for digest in ('invalid', 'a' * 64, '..%2flatest.json'):
            self.assertEqual(self.client.get('/launcher-updates/objects/' + digest,
                                             headers=self.headers).status_code, 404)
        path = self.root / 'objects' / self.digest
        path.unlink()
        path.symlink_to(self.root / 'latest.json')
        self.assertEqual(self.client.get('/launcher-updates/objects/' + self.digest,
                                         headers=self.headers).status_code, 404)

    def test_revocation_and_missing_credential_fail_closed(self):
        (self.root / 'credential.sha256').unlink()
        self.assertEqual(self.client.get('/launcher-updates/latest', headers=self.headers).status_code, 404)


if __name__ == '__main__':
    unittest.main()
