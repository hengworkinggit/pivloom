"""End-to-end provenance checks against a small disposable Git checkout."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("package.py")


class PackageProvenanceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pivloom-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        target = self.root / "infra/release/package.py"
        target.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, target)
        for name in ["package.json", "package-lock.json", "apps/api/package.json",
                     "apps/web/package.json", "packages/contracts/package.json",
                     "apps/api/dist/server.js", "packages/contracts/dist/index.js"]:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("{}\n")
        (self.root / ".gitignore").write_text("apps/api/dist/\npackages/contracts/dist/\nreleases/\n")
        for command in [["git", "init", "-q"], ["git", "config", "user.email", "test@example.invalid"],
                        ["git", "config", "user.name", "Test"], ["git", "add", "."],
                        ["git", "commit", "-qm", "fixture"]]:
            subprocess.run(command, cwd=self.root, check=True, capture_output=True)
        self.commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip()

    def package(self, release: str):
        return subprocess.run([sys.executable, "infra/release/package.py", "api", release,
                               "--output", "releases"], cwd=self.root, text=True, capture_output=True)

    def manifest(self, commit: str):
        (self.root / "apps/api/dist/version.json").write_text(json.dumps({
            "component": "api", "commit": commit, "builtAt": "2026-09-23T13:00:00Z"
        }) + "\n")

    def test_rejects_an_untagged_or_stale_api_build(self):
        missing = self.package("without-version")
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse((self.root / "releases/api-without-version.tar.gz").exists())
        self.manifest("0" * 40)
        stale = self.package("stale-version")
        self.assertNotEqual(stale.returncode, 0)
        self.assertFalse((self.root / "releases/api-stale-version.tar.gz").exists())

    def test_rejects_dirty_source_and_packages_the_matching_commit(self):
        self.manifest(self.commit)
        (self.root / "package.json").write_text('{"changed":true}\n')
        dirty = self.package("dirty")
        self.assertNotEqual(dirty.returncode, 0)
        self.assertFalse((self.root / "releases/api-dirty.tar.gz").exists())
        (self.root / "package.json").write_text("{}\n")
        clean = self.package("clean")
        self.assertEqual(clean.returncode, 0, clean.stderr)
        record = json.loads((self.root / "releases/api-clean.json").read_text())
        self.assertEqual(record["commit"], self.commit)


if __name__ == "__main__":
    unittest.main()
