# #43 — Release disk admission and bounded retention

2026-09-27: implementation and isolated shell acceptance; no production deletion, service switch or remote deployment performed.

The previous script uploaded/extracted the artifact before checking disk pressure and pruned by recency without protecting an old previous release. Local keep/disk variables were not explicit SSH arguments. The README also incorrectly said releases were never removed automatically.

Changes:

- Validate retention (2–20) and disk maximum (1–99) locally before SSH and remotely; pass both as positional arguments, independently of forwarded environment variables.
- Refuse an installation before creating `incoming` or uploading when the remote disk is above its threshold. Recheck before extraction, dependency installation/copy and switching.
- After successful health checks, preserve both the selected current release and the release used before the switch. Both count toward the retention limit; remaining slots use recency.
- Only direct, non-symlink directories with a matching component/SHA version manifest are deletion candidates. Unmanaged directories/files/symlinks are skipped and counted in output.
- Rollback does not allocate a new artifact or dependencies, so an already-high watermark does not block it; current/previous protection also applies when selecting an old rollback target. Existing service health failure recovery remains intact.
- Report each disk measurement and a JSON retention summary. No background monitoring or production-wide cleanup has been added.

RED: the original script's high-watermark test failed because `incoming` existed before refusal; high-watermark rollback was also blocked.

GREEN: `python3 -m unittest infra/release/test_deploy.py infra/release/test_package.py` ran **9 tests, all passed** (7 deployment shell cases and 2 existing package provenance cases). The full deployment shell runs through a fake SSH process executing Bash in a temporary tree, while df/curl/systemctl/ownership operations are controlled commands. The SSH fixture explicitly removes the local keep/disk environment variables to verify argument propagation.

Deployment cases cover refusal before upload, changed disk pressure before extraction, API dependency admission, old previous/current preservation with a strict total count, leaving unmanaged paths and external symlink targets untouched, high-watermark rollback, invalid settings before SSH, and readiness failure recovery. Related checks share seven scenarios. `bash -n` passed for both shell scripts and `git diff --check` passed.

Production validation remains a separate authorized deployment: inspect actual disk/retention logs, current and previous targets, readiness, public probes and Web/API/HEAD provenance. Isolated fake-host results do not establish production acceptance.
