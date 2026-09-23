#!/usr/bin/env python3
"""Package an already-built API or standalone Web release without local env files."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=["api", "web"])
    parser.add_argument("release", help="Unique release name, e.g. api-<commit>-<timestamp>")
    parser.add_argument("--output", type=Path, default=Path(".cache/releases"))
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", args.release):
        parser.error("invalid release name")
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"{args.component}-{args.release}.tar.gz"
    record = archive.with_suffix("").with_suffix(".json")
    if archive.exists() or record.exists():
        parser.error("release output already exists; choose a new release name")

    entries = {}

    def include(source, name):
        if not source.exists():
            parser.error(f"build output missing: {source.relative_to(root)}")
        paths = [source, *sorted(source.rglob("*"))] if source.is_dir() else [source]
        for path in paths:
            relative = path.relative_to(source) if path != source else Path()
            destination = (Path(name) / relative).as_posix()
            if any(part == ".env" or part.startswith(".env.") for part in path.parts):
                parser.error(f"refusing to package environment file: {path.relative_to(root)}")
            if path.is_symlink():
                # Standalone traces may contain workspace links, but must stay in the bundle.
                if path.readlink().is_absolute() or not path.resolve().is_relative_to(source):
                    parser.error(f"link leaves packaged tree: {path.relative_to(root)}")
            entries[destination] = path

    if args.component == "api":
        for name in ["package.json", "package-lock.json", "apps/api/package.json",
                     "apps/web/package.json", "packages/contracts/package.json"]:
            include(root / name, name)
        for name in ["apps/api/dist/server.js", "packages/contracts/dist/index.js"]:
            if not (root / name).is_file():
                parser.error(f"build output missing: {name}")
        for name in ["apps/api/dist", "packages/contracts/dist"]:
            include(root / name, name)
    else:
        standalone = root / "apps/web/.next/standalone"
        if not (standalone / "apps/web/server.js").is_file():
            parser.error("standalone server missing; build @pivloom/web first")
        include(standalone, ".")
        include(root / "apps/web/.next/static", "apps/web/.next/static")
        include(root / "apps/web/.next/BUILD_ID", "apps/web/.next/BUILD_ID")
        if (root / "apps/web/public").is_dir():
            include(root / "apps/web/public", "apps/web/public")

    with tarfile.open(archive, "w:gz") as bundle:
        for name, path in sorted(entries.items()):
            bundle.add(path, arcname=name, recursive=False)
    metadata = {
        "component": args.component,
        "release": args.release,
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "worktreeDirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True)),
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "files": len(entries),
    }
    if args.component == "web":
        metadata["buildId"] = (root / "apps/web/.next/BUILD_ID").read_text().strip()
    record.write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"archive": str(archive), "record": str(record), **metadata}))


if __name__ == "__main__":
    main()
