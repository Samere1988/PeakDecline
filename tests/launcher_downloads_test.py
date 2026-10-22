"""Owner authorization and resumable private-download regression tests."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from flask import Flask
from flask_login import LoginManager, UserMixin

from app.launcher_downloads import register

ROOT = Path(__file__).resolve().parents[1]


class Account(UserMixin):
    def __init__(self, identity, username, active=True):
        self.id, self.username, self.active = identity, username, active
        self.avatar_url = "/avatar.png"

    @property
    def is_active(self):
        return self.active


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Flask(__name__, instance_path=self.temp.name,
                         template_folder=str(ROOT / "templates"))
        self.app.config.update(TESTING=True, SECRET_KEY="test-only", MONITORING_OWNER_ID="owner")
        login = LoginManager(self.app)
        self.accounts = {"owner": Account("owner", "samer"),
                         "other": Account("other", "someone"),
                         "imposter": Account("imposter", "samer")}
        login.user_loader(self.accounts.get)
        for path, endpoint in (("/", "main.index"), ("/login", "auth.login"),
                               ("/profile", "auth.profile"), ("/logout", "auth.logout")):
            self.app.add_url_rule(path, endpoint=endpoint, view_func=lambda: "test")
        register(self.app)
        self.root = Path(self.temp.name) / "launcher-downloads"
        self.root.mkdir()
        self.payload = b"PK-test-private-archive"
        self.archive = self.root / "preview.zip"
        self.archive.write_bytes(self.payload)
        self.metadata = {"id": "preview-1", "filename": "preview.zip",
                         "bytes": len(self.payload), "sha256": hashlib.sha256(self.payload).hexdigest(),
                         "label": "Preview 1", "games": [{"name": "Zelda", "playable": True}]}
        self.save_metadata()
        self.client = self.app.test_client()
        self.url = "/launcher-preview/download/preview-1"

    def tearDown(self):
        self.temp.cleanup()

    def save_metadata(self):
        (self.root / "release.json").write_text(json.dumps(self.metadata))

    def login(self, identity):
        with self.client.session_transaction() as session:
            session["_user_id"] = identity
            session["_fresh"] = True

    def test_anonymous_redirects_without_archive_or_metadata(self):
        for url in ("/launcher-preview/", self.url):
            response = self.client.get(url)
            self.assertEqual(response.status_code, 302)
            self.assertIn("/login?", response.location)
            self.assertNotIn(self.payload, response.data)
            self.assertIn("no-store", response.headers["Cache-Control"])

    def test_other_accounts_cannot_download_even_with_matching_username(self):
        for identity in ("other", "imposter"):
            self.login(identity)
            for url in ("/launcher-preview/", self.url):
                self.assertEqual(self.client.get(url).status_code, 404)

    def test_inactive_owner_is_denied(self):
        self.accounts["owner"].active = False
        self.login("owner")
        self.assertEqual(self.client.get(self.url).status_code, 302)

    def test_owner_page_and_full_download(self):
        self.login("owner")
        page = self.client.get("/launcher-preview/")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"Windows build included", page.data)
        response = self.client.get(self.url)
        self.assertEqual(response.data, self.payload)
        self.assertIn("attachment", response.headers["Content-Disposition"])
        self.assertIn("no-store", response.headers["Cache-Control"])
        self.assertIn("Cookie", response.headers["Vary"])
        self.assertIn("noindex", response.headers["X-Robots-Tag"])
        response.close()

    def test_head_range_and_unsatisfiable_range(self):
        self.login("owner")
        head = self.client.head(self.url)
        self.assertEqual(head.content_length, len(self.payload))
        self.assertEqual(head.data, b"")
        response = self.client.get(self.url, headers={"Range": "bytes=3-7"})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, self.payload[3:8])
        response.close()
        self.assertEqual(self.client.get(self.url, headers={"Range": "bytes=999-"}).status_code, 416)

    def test_installer_download_and_instructions(self):
        self.archive.rename(self.root / "preview.exe")
        self.metadata["filename"] = "preview.exe"
        self.save_metadata()
        self.login("owner")
        page = self.client.get("/launcher-preview/")
        self.assertIn(b"Download Windows installer", page.data)
        self.assertIn(b"desktop and Start-menu shortcuts", page.data)
        self.assertNotIn(b"Extract All", page.data)
        response = self.client.get(self.url)
        self.assertEqual(response.mimetype, "application/octet-stream")
        self.assertEqual(response.data, self.payload)
        self.assertIn("preview.exe", response.headers["Content-Disposition"])
        response.close()

    def test_update_enabled_release_explains_future_updates(self):
        self.metadata['updates'] = {'enabled': True, 'sequence': 3}
        self.save_metadata()
        self.login('owner')
        response = self.client.get('/launcher-preview/')
        self.assertIn(b'Future updates are built in', response.data)
        self.assertIn(b'downloads only changed files', response.data)

    def test_script_extensions_are_not_downloadable(self):
        self.login("owner")
        for extension in ("cmd", "ps1", "html", "exe.html"):
            self.metadata["filename"] = "preview." + extension
            self.save_metadata()
            self.assertEqual(self.client.get(self.url).status_code, 404)

    def test_stale_release_and_missing_file_are_not_served(self):
        self.login("owner")
        self.assertEqual(self.client.get(self.url + "-old").status_code, 404)
        self.archive.unlink()
        self.assertEqual(self.client.get(self.url).status_code, 404)

    def test_resume_requires_current_authorization(self):
        self.login("owner")
        response = self.client.get(self.url, headers={"Range": "bytes=0-2"})
        self.assertEqual(response.status_code, 206)
        response.close()
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.get(self.url, headers={"Range": "bytes=3-"})
        self.assertEqual(response.status_code, 302)
        self.assertNotIn(self.payload[3:], response.data)

    def test_invalid_metadata_and_traversal_fail_closed(self):
        self.login("owner")
        for filename in ("../preview.zip", "/etc/passwd", "preview.zip/other"):
            self.metadata["filename"] = filename
            self.save_metadata()
            self.assertEqual(self.client.get(self.url).status_code, 404)
        (self.root / "release.json").write_text("not-json")
        self.assertEqual(self.client.get(self.url).status_code, 404)

    def test_symlinks_and_truncated_downloads_are_rejected(self):
        self.login("owner")
        self.archive.write_bytes(b"truncated")
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.archive.unlink()
        outside = Path(self.temp.name) / "outside.zip"
        outside.write_bytes(self.payload)
        self.archive.symlink_to(outside)
        self.assertEqual(self.client.get(self.url).status_code, 404)


if __name__ == "__main__":
    unittest.main()
