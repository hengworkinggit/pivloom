# Verification v2 integration record

This record distinguishes controlled fixtures from real application acceptance. Issue #37 remains open until its real-model, browser, rollback and publication matrix is complete. A timeout or blocked result does not meet the ten-minute completion objective.

## Measured and verified

- Full integrated unit suites at `86dad2a`: API 528 passed / 109 skipped; Web 106 passed. Typecheck and lint passed. Following the controlled reset addition, 120 Reviewer/mode tests passed at `c3d5af8`.
- Real isolated PostgreSQL 17: 8 candidate HTTP cases; 6 review persistence/deadline cases; 6 selected executor lifecycle cases. These use explicit external auth/provider/sandbox/storage fixtures. The full executor suite additionally exposed five cases requiring follow-up; its results are not represented as all green here.
- Release maintenance: 9 actual shell/package regression tests passed. They use temporary directories and stub host commands; production retention verification is separate.
- Real production OpenSandbox/gVisor/Chromium: calculator fixture completed four expected passing cases and retained them when a fifth invalid visual scope was blocked, 62.747s. Forms/list/dynamic-controls fixture completed five functional cases in 66.586s. See the individual raw records. Neither probe called a model or persisted a production Check; both cleaned their disposable sandbox.
- Two-axis code review found the full-run deadline, deferred visual ordering, screenshot admission, native process lifecycle and shell-output truncation defects. Follow-up patches and targeted regressions addressed them. Full browser regression caught an additional abort signal masking original diagnostics; that was corrected without changing those assertions.

## Release and live QA preparation

Production migration `030_explicit_candidate_base.sql` was applied through the existing environment-checked maintenance command on 2026-09-26 around 21:14 UTC. Its nullable column and foreign key preserve compatibility with the previous application. No source snapshots or application data were rewritten.

Codex IAB open timed out at 30 seconds and reset its kernel. Following the repository fallback rule, independent QA uses a named local agent-browser 0.36.0 session; the product still uses pinned agent-browser 0.38.1 inside its sandbox. Login was performed through the page using the existing test-A identity. A new tab is not counted as a new authentication context.

The actual model settings page currently reports:

- DeepSeek `deepseek-flash`: streaming and tools verified; the delivered image was not correctly recognized. It cannot enter the current production generation admission gate.
- Ark `kimi-k2.7-code`: connection test failed; its capabilities are unverified. It cannot enter generation either.

The user has been asked to provide a working image-capable profile through model settings. There is no available qualified profile at this checkpoint. Model capability status, required behaviors and final promotion checks have not been bypassed. Real C0/C1/C2/rollback/C3 and a fresh Snake run are consequently still BLOCKED, not passed by the fixed probes above.

## Ten-minute claim

The implementation enforces a shared 600-second verification window beginning at the first Reviewer, including later repair Builders, rebinds, subsequent reviews and final persistence. Initial planning/building is outside that window. A deadline prevents late promotion; it cannot ensure the checks finish. Post-timeout evidence recovery is explicitly incomplete and may occur later.

Current data proves that these fixed supported browser scenarios can execute quickly and preserve evidence. It does not establish a successful ten-minute completion rate or percentile for arbitrary user increments. Full required checks yielding a trustworthy pass or application failure count as completed acceptance; infrastructure failure, timeout and unexecuted required checks do not.
