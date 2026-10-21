"""Authority progress must not overwrite another session or change owners."""
import base64
from pathlib import Path
import tempfile
import unittest
from retro_test import make_app
from retro_package.saves import commit_authority_save, read_account_save


class AuthoritySaves(unittest.TestCase):
    def test_compare_and_swap_owner_and_history(self):
        with tempfile.TemporaryDirectory() as directory:
            app,_=make_app(Path(directory))
            files={'eeprom.bin':base64.b64encode(bytes([13])*512).decode()}
            self.assertEqual(commit_authority_save(app,'owner','mk64',0,files),1)
            self.assertEqual(read_account_save(app,'owner','mk64'),dict(revision=1,files=files))
            self.assertIsNone(commit_authority_save(app,'owner','mk64',0,{}))
            self.assertEqual(read_account_save(app,'owner','mk64')['files'],files)
            self.assertEqual(read_account_save(app,'another-player','mk64')['revision'],0)
            self.assertEqual(commit_authority_save(app,'owner','mk64',1,files),2)


if __name__=='__main__':unittest.main()
