#!/usr/bin/env bash
# Shared locally and over SSH so the same retention/disk settings apply at both ends.
validate_release_settings() {
  local keep=$1 limit=$2
  if [[ ! "$keep" =~ ^[0-9]{1,2}$ ]] || (( 10#$keep < 2 || 10#$keep > 20 )); then
    echo 'PIVLOOM_RELEASE_KEEP must be an integer from 2 to 20 (current and previous are retained).' >&2
    return 2
  fi
  if [[ ! "$limit" =~ ^[0-9]{1,2}$ ]] || (( 10#$limit < 1 || 10#$limit > 99 )); then
    echo 'PIVLOOM_DISK_MAX_PERCENT must be an integer from 1 to 99.' >&2
    return 2
  fi
}

disk_guard() {
  local root=$1 limit=$2 phase=$3 allow_full=${4:-false} used="" available=""
  read -r used available < <(df -Pk "$root" | awk 'NR==2 {gsub(/%/,"",$5); print $5, $4}') || true
  if [[ ! "$used" =~ ^[0-9]{1,3}$ || ! "$available" =~ ^[0-9]+$ ]] || (( 10#$used > 100 )); then
    echo "Cannot read disk usage for $root; deployment stopped." >&2
    return 3
  fi
  printf 'Disk (%s): used=%s%% limit=%s%% availableKiB=%s\n' "$phase" "$used" "$limit" "$available"
  if [[ "$allow_full" != true ]] && (( 10#$used >= 10#$limit )); then
    echo "Refusing to deploy before $phase: $root is ${used}% full (limit ${limit}%)." >&2
    return 3
  fi
}

prune_releases() {
  # Only manifest-bearing direct directories are releases. Operator directories,
  # files and symlinks are not deletion candidates, even if they sort as old.
  python3 - "$1" "$2" "$3" "$4" "$5" <<'PY'
import json
from pathlib import Path
import re
import shutil
import sys

archive, target, previous, keep, component = sys.argv[1:]
archive = Path(archive)
protected = {Path(target).resolve()}
if previous:
    protected.add(Path(previous).resolve())
managed = []
skipped = 0
for entry in archive.iterdir():
    if entry.is_symlink() or not entry.is_dir() or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}', entry.name):
        skipped += 1
        continue
    marker = entry / ('apps/api/dist/version.json' if component == 'api' else 'apps/web/version.json')
    try:
        metadata = json.loads(marker.read_text())
        valid = metadata.get('component') == component and re.fullmatch(r'[a-f0-9]{40}', metadata.get('commit', ''))
    except (OSError, ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        skipped += 1
        continue
    managed.append(entry)
retained = {entry for entry in managed if entry.resolve() in protected}
for entry in sorted(managed, key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True):
    if len(retained) >= int(keep):
        break
    retained.add(entry)
removed = []
for entry in managed:
    if entry not in retained:
        shutil.rmtree(entry)
        removed.append(entry.name)
print(json.dumps({'releaseRetention': component, 'limit': int(keep), 'retained': len(retained),
                  'protected': sorted(path.name for path in retained if path.resolve() in protected),
                  'removed': sorted(removed), 'unmanagedEntriesSkipped': skipped}))
PY
}
