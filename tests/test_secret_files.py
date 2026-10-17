"""Exercise private mounted credentials without contacting external services."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("OPENBOARD_BINARY", ROOT / "build/openboard"))


class SecretFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openboard-secret-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.secret = self.directory / "credential"
        self.content = b"postgresql://test:private-synthetic-value@localhost/test"
        self.secret.write_bytes(self.content)
        self.secret.chmod(0o600)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("OPENBOARD_")}
        self.env["OPENBOARD_POSTGRES_URL_FILE"] = str(self.secret)

    def command(self, expected=0):
        result = subprocess.run([str(BINARY), "--version"], env=self.env,
                                capture_output=True, timeout=5)
        if expected == 0:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b"private-synthetic-value", result.stdout + result.stderr)
        self.assertNotIn(str(self.secret).encode(), result.stdout + result.stderr)
        return result

    def test_private_regular_credentials_and_single_line_endings(self):
        for ending in (b"", b"\n", b"\r\n"):
            self.secret.write_bytes(self.content + ending)
            self.command()
        self.env["OPENBOARD_MONGODB_URI_FILE"] = str(self.secret)
        self.command()

    def test_conflicting_inline_and_file_credentials_fail_closed(self):
        self.env["OPENBOARD_POSTGRES_URL"] = "postgresql://test:other-private-value@localhost/test"
        result = self.command(expected=1)
        self.assertNotIn(b"other-private-value", result.stdout + result.stderr)

    def test_empty_overlong_nul_and_multiple_lines_are_rejected(self):
        for value in (b"", b"\n", b"x" * 16385, self.content + b"\0extra", self.content + b"\nextra"):
            with self.subTest(length=len(value)):
                self.secret.write_bytes(value)
                self.command(expected=1)

    def test_public_permissions_and_symlinks_are_rejected(self):
        self.secret.chmod(0o640)
        self.command(expected=1)
        self.secret.chmod(0o600)
        link = self.directory / "link"
        link.symlink_to(self.secret)
        self.env["OPENBOARD_POSTGRES_URL_FILE"] = str(link)
        self.command(expected=1)

    def test_fifo_and_directory_do_not_block_startup(self):
        fifo = self.directory / "pipe"
        os.mkfifo(fifo, 0o600)
        for path in (fifo, self.directory):
            self.env["OPENBOARD_POSTGRES_URL_FILE"] = str(path)
            self.command(expected=1)


if __name__ == "__main__":
    unittest.main()
