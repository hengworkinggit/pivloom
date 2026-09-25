#!/usr/bin/env bash
# Release to an already-provisioned single-instance host; never edits Caddy or env.
set -euo pipefail
component="${1:?usage: deploy.sh api|web <release> <archive|--rollback>}"
release="${2:?release required}"
archive="${3:?archive or --rollback required}"
host="${PIVLOOM_SSH_TARGET:?set PIVLOOM_SSH_TARGET to the authorised SSH host}"
root="${PIVLOOM_REMOTE_ROOT:-/opt/pivloom}"
public_url="${PIVLOOM_PUBLIC_URL:?set PIVLOOM_PUBLIC_URL to the HTTPS workbench origin}"
existing_site="${PIVLOOM_EXISTING_SITE:?set PIVLOOM_EXISTING_SITE to the site to preserve}"
node="${PIVLOOM_REMOTE_NODE:-/usr/local/bin/node}"
npm_cli="${PIVLOOM_REMOTE_NPM_CLI:-}"
maintenance_env="${PIVLOOM_REMOTE_MAINTENANCE_ENV:?set the remote private maintenance env path (MIGRATION_DATABASE_URL)}"
[[ "$component" = api || "$component" = web ]] || exit 2
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$ ]] || exit 2
[[ "$root" =~ ^/[a-zA-Z0-9_/-]+$ && "$host" != -* ]] || exit 2
[[ "$public_url" = https://* && "$existing_site" = https://* ]] || exit 2
ssh_options=()
if [[ -n "${PIVLOOM_SSH_CONTROL_PATH:-}" ]]; then
  ssh_options+=(-o "ControlPath=$PIVLOOM_SSH_CONTROL_PATH")
fi
digest=""
mode=install
if [[ "$archive" = --rollback ]]; then
  mode=rollback
else
  [[ -f "$archive" ]] || { echo 'archive not found' >&2; exit 2; }
  digest=$(python3 - "$archive" <<'PY'
import hashlib, sys
with open(sys.argv[1], "rb") as file:
    print(hashlib.file_digest(file, "sha256").hexdigest())
PY
)
  ssh "${ssh_options[@]}" "$host" "mkdir -p '$root/incoming'"
  # Use the existing SSH stream; deployment does not require an SFTP subsystem.
  ssh "${ssh_options[@]}" "$host" "cat > '$root/incoming/$component-$release.tar.gz'" < "$archive"
fi
remote_args=$(printf '%q ' "$component" "$release" "$root" "$mode" "$digest" "$public_url" "$existing_site" "$node" "$npm_cli" "$maintenance_env")
ssh "${ssh_options[@]}" "$host" "bash -s -- $remote_args" <<'REMOTE'
set -euo pipefail
component=$1 release=$2 root=$3 mode=$4 digest=$5 public_url=$6 existing_site=$7 node=$8 npm_cli=$9
maintenance_env=${10}
target="$root/$component-releases/$release"
link="$root/$component-current"
incoming="$root/incoming/$component-$release.tar.gz"
service="pivloom-$component.service"
previous=$(readlink -f "$link" || true)
switched=0
switch_to() {
  ln -s "$1" "$link.next.$$"
  mv -Tf "$link.next.$$" "$link"
}
ready() {
  if [[ "$component" = api ]]; then url=http://127.0.0.1:18010/api/v1/health/ready;
  else url=http://127.0.0.1:18012/login; fi
  curl --fail --silent --show-error --retry 10 --retry-delay 1 --retry-all-errors --max-time 10 "$url" >/dev/null
}
finish() {
  status=$?
  trap - EXIT
  if (( status != 0 && switched == 1 )); then
    if [[ -n "$previous" && -d "$previous" ]]; then
      echo 'Release checks failed; restoring the previous release.' >&2
      if switch_to "$previous" && systemctl restart "$service" && ready; then
        echo 'Previous release is ready.' >&2
      else
        echo 'Rollback needs operator attention.' >&2
      fi
    else
      systemctl stop "$service" || true
      echo 'No previous release exists; failed service stopped.' >&2
    fi
  fi
  [[ "$mode" != install ]] || rm -f "$incoming"
  exit "$status"
}
trap finish EXIT
if [[ "$mode" = install ]]; then
  [[ ! -e "$target" ]] || { echo 'Release already exists; use --rollback to select it.' >&2; exit 2; }
  printf '%s  %s\n' "$digest" "$incoming" | sha256sum --check --status
  mkdir -p "$target"
  tar -xzf "$incoming" -C "$target"
  if [[ "$component" = api ]]; then
    reusable=1
    for file in package-lock.json package.json apps/api/package.json apps/web/package.json packages/contracts/package.json; do
      if [[ -z "$previous" ]] || ! cmp -s "$previous/$file" "$target/$file"; then reusable=0; fi
    done
    if (( reusable == 1 )) && [[ -d "$previous/node_modules" ]]; then
      for modules in node_modules apps/api/node_modules apps/web/node_modules packages/contracts/node_modules; do
        if [[ -d "$previous/$modules" ]]; then cp -a --reflink=auto "$previous/$modules" "$target/$modules"; fi
      done
    else
      cd "$target"
      npm_command=(npm)
      [[ -z "$npm_cli" ]] || npm_command=("$node" "$npm_cli")
      "${npm_command[@]}" ci --omit=dev --workspace @pivloom/api --workspace @pivloom/contracts --include-workspace-root --no-audit --no-fund
    fi
  fi
  chown -R root:root "$target"
  chmod -R a-w "$target"
fi
[[ -d "$target" ]] || { echo 'Release directory not found.' >&2; exit 2; }
# A full disk stops Postgres completing crash recovery, which takes the API down with it; on
# 2026-09-25 that happened after retained releases reached sixteen gigabytes. Check before
# switching so the failure is a refused deploy instead of an outage.
disk_limit="${PIVLOOM_DISK_MAX_PERCENT:-85}"
used_percent=$(df -P "$root" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [[ -n "$used_percent" ]] && (( used_percent >= disk_limit )); then
  echo "Refusing to deploy: $root is ${used_percent}% full (limit ${disk_limit}%)." >&2
  exit 3
fi
if [[ "$component" = api ]]; then
# Only the API owns generation workers. Web-only releases preserve the API
# process and let clients reconnect to the same durable run after refresh.
# Cross-owner idle checks need maintenance privileges, never the RLS-scoped API role.
cd "$target"
"$node" --env-file="$maintenance_env" --input-type=module - <<'JS'
import { Pool } from 'pg';
if (!process.env.MIGRATION_DATABASE_URL) {
  console.error('Maintenance database configuration is missing.');
  process.exit(3);
}
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
try {
  // An insufficiently privileged connection must fail instead of returning RLS-filtered zeros.
  await pool.query('SET row_security = off');
  const runs = await pool.query("SELECT count(*)::int AS n FROM nano.runs WHERE state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested') OR cleanup_state = 'pending'");
  const sandboxes = await pool.query("SELECT count(*)::int AS n FROM nano.sandboxes WHERE state NOT IN ('destroyed','expired')");
  console.log(JSON.stringify({ activeOrUncleanRuns: runs.rows[0].n, retainedSandboxes: sandboxes.rows[0].n }));
  if (runs.rows[0].n || sandboxes.rows[0].n) {
    console.error('Deployment requires an idle environment; wait for runs, cleanup and preview expiry.');
    process.exitCode = 3;
  }
} catch {
  console.error('Unable to verify idle state; deployment stopped.');
  process.exitCode = 3;
} finally { await pool.end(); }
JS
fi
curl --fail --silent --show-error --location --max-time 20 "$existing_site" >/dev/null
switch_to "$target"
switched=1
systemctl restart "$service"
ready
curl --fail --silent --show-error --retry 3 --retry-delay 1 --retry-all-errors --max-time 20 "${public_url%/}/login" >/dev/null
curl --fail --silent --show-error --max-time 20 "${public_url%/}/api/v1/health/ready" >/dev/null
curl --fail --silent --show-error --location --max-time 20 "$existing_site" >/dev/null
# Keep the previous release so a rollback is one symlink away, but bound the archive: an
# unbounded history is what filled the disk. Override with PIVLOOM_RELEASE_KEEP if needed.
keep="${PIVLOOM_RELEASE_KEEP:-4}"
archive="$root/$component-releases"
if [[ -d "$archive" ]]; then
  while IFS= read -r stale; do
    [[ -n "$stale" && "$stale" != "$release" ]] || continue
    rm -rf "$archive/$stale"
  done < <(ls -1t "$archive" | tail -n +$((keep + 1)))
fi
printf '%s release ready: %s\nPrevious release retained: %s\n' "$component" "$release" "${previous:-none}"
REMOTE
