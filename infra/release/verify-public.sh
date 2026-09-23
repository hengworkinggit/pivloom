#!/usr/bin/env bash
# Read-only HTTPS/routing probe. Does not prove login, SSE or product E2E.
set -uo pipefail
workbench="${1:?usage: verify-public.sh <workbench-host> <preview-host> [revisionId]}"
preview="${2:?preview host required}"
revision="${3:-}"
existing_site="${PIVLOOM_EXISTING_SITE:?set PIVLOOM_EXISTING_SITE to the site to preserve}"
[[ "$workbench" =~ ^[a-z0-9][a-z0-9.-]+$ && "$preview" =~ ^[a-z0-9][a-z0-9.-]+$ ]] || exit 2
[[ -z "$revision" || "$revision" =~ ^[a-f0-9-]{36}$ ]] || exit 2
fail=0
report() { printf '%-46s %s\n' "$1" "$2"; }
check() {
  if [[ "$2" = "$3" ]]; then report "$1" "PASS ($3)";
  else report "$1" "FAIL (expected $2, got $3)"; fail=1; fi
}
status() { curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 45 "$1"; }
check 'workbench /login HTTPS' 200 "$(status "https://$workbench/login")"
check 'same-origin API ready' 200 "$(status "https://$workbench/api/v1/health/ready")"
check 'existing site still served' 200 "$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' --max-time 25 "$existing_site")"
unknown=00000000-0000-4000-8000-000000000001
check 'tls-check denies an unknown revision' 403 "$(status "https://$workbench/api/v1/preview/tls-check?domain=$unknown.$preview")"
check 'tls-check denies a foreign suffix' 403 "$(status "https://$workbench/api/v1/preview/tls-check?domain=$unknown.example.invalid")"
if [[ -n "$revision" ]]; then
  check 'tls-check allows a stored revision' 200 "$(status "https://$workbench/api/v1/preview/tls-check?domain=$revision.$preview")"
  code=$(status "https://$revision.$preview/p/$revision/")
  case "$code" in
    200|403|404|410) report 'per-revision host answers over TLS' "PASS ($code; routing only)";;
    *) report 'per-revision host answers over TLS' "FAIL ($code)"; fail=1;;
  esac
else
  report 'per-revision TLS' 'NOT_RUN (provide a stored revision ID)'
fi
report 'authenticated SSE / browser workflows' 'NOT_RUN (run the documented product E2E separately)'
exit "$fail"
