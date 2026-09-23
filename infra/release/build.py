#!/usr/bin/env python3
"""Build both deployable components from one clean Git commit."""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def main():
    root = Path(__file__).resolve().parents[2]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise SystemExit("A complete Git commit is required for release builds")
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=root):
        raise SystemExit("Release builds require a clean Git checkout")
    built_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    for output in [root / "packages/contracts/dist", root / "apps/api/dist", root / "apps/web/.next"]:
        if output.exists():
            shutil.rmtree(output)
    env = os.environ.copy()
    env["PIVLOOM_BUILD_COMMIT"] = commit
    subprocess.run(["npm", "run", "build"], cwd=root, env=env, check=True)
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip() != commit:
        raise SystemExit("Source commit changed during the release build")
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=root):
        raise SystemExit("Source tree changed during the release build")
    api = root / "apps/api/dist"
    web = root / "apps/web/.next/standalone/apps/web"
    if not (api / "server.js").is_file() or not (web / "server.js").is_file():
        raise SystemExit("Expected API or standalone Web artifact is missing")
    build_id = (root / "apps/web/.next/BUILD_ID").read_text().strip()
    deployment_id = env.get("PIVLOOM_DEPLOYMENT_ID") or env.get("NEXT_DEPLOYMENT_ID") or None
    if not deployment_id and build_id != commit:
        raise SystemExit("Next build ID does not match the source commit")
    version = {"commit": commit, "builtAt": built_at}
    (api / "version.json").write_text(json.dumps({"component": "api", **version}, indent=2) + "\n")
    (web / "version.json").write_text(json.dumps({"component": "web", **version,
                                                   "buildId": build_id, "deploymentId": deployment_id}, indent=2) + "\n")
    print(json.dumps({"commit": commit, "builtAt": built_at,
                      "webBuildId": build_id, "deploymentId": deployment_id}))


if __name__ == "__main__":
    main()
