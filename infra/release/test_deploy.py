"""Run the real deployment shell against disposable paths and fake host commands."""
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("deploy.sh")


class DeploymentRetentionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pivloom-deploy-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "remote"
        self.root.mkdir()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.log = self.base / "commands.jsonl"
        self.env = {**os.environ, "LC_ALL": "C", "PATH": f"{self.bin}:{os.environ['PATH']}",
                    "TEST_LOG": str(self.log), "TEST_STATE": str(self.base),
                    "PIVLOOM_SSH_TARGET": "fixture-host", "PIVLOOM_REMOTE_ROOT": str(self.root),
                    "PIVLOOM_PUBLIC_URL": "https://app.example.test", "PIVLOOM_EXISTING_SITE": "https://existing.example.test",
                    "PIVLOOM_REMOTE_MAINTENANCE_ENV": str(self.base / "maintenance.env"),
                    "PIVLOOM_RELEASE_KEEP": "2", "PIVLOOM_DISK_MAX_PERCENT": "70", "TEST_DISK": "40"}
        fake = r'''#!/usr/bin/env python3
import hashlib, json, os, pathlib, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
with open(os.environ['TEST_LOG'], 'a') as log: log.write(json.dumps([name, *sys.argv[1:]]) + '\n')
state = pathlib.Path(os.environ['TEST_STATE'])
if name == 'ssh':
    args = sys.argv[1:]
    while args and args[0].startswith('-'):
        args = args[2:] if args[0] == '-o' else args[1:]
    remote_env = {key: value for key, value in os.environ.items() if key not in ('PIVLOOM_RELEASE_KEEP', 'PIVLOOM_DISK_MAX_PERCENT')}
    sys.exit(subprocess.run(['bash', '-c', ' '.join(args[1:])], env=remote_env).returncode)
if name == 'df':
    marker = state / 'df-count'
    index = int(marker.read_text()) if marker.exists() else 0
    marker.write_text(str(index + 1))
    values = os.environ.get('TEST_DISK', '40').split(',')
    value = values[min(index, len(values)-1)]
    print('Filesystem 1024-blocks Used Available Capacity Mounted on')
    print(f'fixture 100000 40000 60000 {value}% /')
elif name == 'mv':
    args = [arg for arg in sys.argv[1:] if arg != '-Tf']
    os.replace(args[0], args[1])
elif name == 'sha256sum':
    digest, file = sys.stdin.read().strip().split(None, 1)
    sys.exit(0 if hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest() == digest else 1)
elif name == 'curl':
    if os.environ.get('TEST_FAIL_READY') == '1' and any('127.0.0.1:18012/login' in arg for arg in sys.argv):
        marker = state / 'ready-failed'
        if not marker.exists(): marker.write_text('1'); sys.exit(22)
elif name == 'node':
    sys.stdin.read()
    print('{"activeOrUncleanRuns":0,"retainedSandboxes":0}')
'''
        for name in ["ssh", "df", "mv", "sha256sum", "curl", "systemctl", "chown", "chmod", "node", "npm"]:
            path = self.bin / name
            path.write_text(fake)
            path.chmod(0o755)
        self.env["PIVLOOM_REMOTE_NODE"] = str(self.bin / "node")
        self.bundle = self.base / "bundle"
        self.bundle.mkdir()
        self.marker(self.bundle)
        (self.bundle / "payload.txt").write_text("new release")
        self.archive = self.base / "release.tar.gz"
        with tarfile.open(self.archive, "w:gz") as bundle:
            bundle.add(self.bundle, arcname=".")

    @staticmethod
    def marker(directory):
        file = directory / "apps/web/version.json"
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({"component": "web", "commit": "a" * 40, "builtAt": "2026-09-27T00:00:00Z"}))

    def release(self, name, mtime):
        directory = self.root / "web-releases" / name
        directory.mkdir(parents=True)
        self.marker(directory)
        (directory / "retained.txt").write_text(name)
        os.utime(directory, (mtime, mtime))
        return directory

    def current(self, directory):
        (self.root / "web-current").symlink_to(directory)

    def deploy(self, release="next", rollback=False, component="web", **updates):
        return subprocess.run(["bash", str(SCRIPT), component, release, "--rollback" if rollback else str(self.archive)],
                              env={**self.env, **updates}, text=True, capture_output=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_high_disk_refuses_before_upload_or_release_write(self):
        result = self.deploy(TEST_DISK="80")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "incoming").exists(), result.stdout + result.stderr)
        self.assertFalse((self.root / "web-releases").exists())
        self.assertFalse(any(call[0] == "systemctl" for call in self.calls()))
        self.assertIn("70", result.stderr + result.stdout)

    def test_rechecks_disk_before_unpacking_if_usage_changes_during_upload(self):
        result = self.deploy(TEST_DISK="40,80")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "web-releases/next").exists())
        self.assertFalse(any(call[0] == "systemctl" for call in self.calls()))

    def test_api_rechecks_before_copying_or_installing_dependencies(self):
        result = self.deploy(component="api", TEST_DISK="40,40,80")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("before-dependencies", result.stderr)
        self.assertFalse(any(call[0] in ("npm", "node", "systemctl") for call in self.calls()))
        self.assertFalse((self.root / "api-current").exists())

    def test_keeps_old_previous_and_current_with_total_retention_limit(self):
        previous = self.release("old-previous", 1)
        self.release("recent-unused", 30)
        self.release("newer-unused", 40)
        self.current(previous)
        unmanaged = self.root / "web-releases/operator-notes"
        unmanaged.mkdir(); (unmanaged / "notes").write_text("do not delete")
        outside = self.base / "outside"; outside.mkdir(); (outside / "asset").write_text("keep")
        (self.root / "web-releases/linked-release").symlink_to(outside)
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "web-current").resolve(), self.root / "web-releases/next")
        self.assertTrue(previous.exists())
        self.assertFalse((self.root / "web-releases/recent-unused").exists())
        self.assertFalse((self.root / "web-releases/newer-unused").exists())
        self.assertEqual((unmanaged / "notes").read_text(), "do not delete")
        self.assertEqual((outside / "asset").read_text(), "keep")
        self.assertTrue((self.root / "web-releases/linked-release").is_symlink())
        self.assertIn('"retained": 2', result.stdout)

    def test_rollback_preserves_old_target_and_previous_even_at_high_disk(self):
        old = self.release("old-target", 1)
        previous = self.release("current-release", 2)
        self.release("recent-unused", 50)
        self.current(previous)
        result = self.deploy("old-target", rollback=True, TEST_DISK="95")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "web-current").resolve(), old)
        self.assertTrue(previous.exists())
        self.assertFalse((self.root / "web-releases/recent-unused").exists())
        self.assertFalse((self.root / "incoming").exists())

    def test_bad_settings_fail_locally_before_any_ssh(self):
        for name, value in [("PIVLOOM_RELEASE_KEEP", "0"), ("PIVLOOM_RELEASE_KEEP", "1"),
                            ("PIVLOOM_RELEASE_KEEP", "3; touch bad"), ("PIVLOOM_DISK_MAX_PERCENT", "100"),
                            ("PIVLOOM_DISK_MAX_PERCENT", "-1"), ("PIVLOOM_RELEASE_KEEP", "99999999999999999999")]:
            with self.subTest(name=name, value=value):
                result = self.deploy(**{name: value})
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_readiness_failure_restores_previous_without_pruning_it(self):
        previous = self.release("old-previous", 1)
        self.current(previous)
        result = self.deploy(TEST_FAIL_READY="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "web-current").resolve(), previous)
        self.assertTrue(previous.exists())


if __name__ == "__main__":
    unittest.main()
