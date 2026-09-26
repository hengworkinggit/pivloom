# V04 / #50 — Explicit candidate continuation

Scope: owned saved build-passed candidates can be inspected/restored and explicitly selected as the next generation's source. Selection is not acceptance or publication.

## Implementation

- `CreateRunRequest.selectedBaseRevisionId` and migration `030_explicit_candidate_base.sql` persist an explicit candidate separately from `expectedCurrentRevisionId`.
- Admission validates ownership, project, build success, saved plan, terminal source run and cleanup. `baseRevisionId`, Coordinator `previousPlan`, Builder handoff and source loading all reference the selected revision.
- Normal requests keep their accepted-current semantics. Queued default follow-ups can still chain; explicitly selected requests are parked if the accepted-current CAS changes, retaining the chosen candidate rather than silently rebasing.
- Clarification resumes the saved explicit candidate even from a newly opened browser without a local selection.
- The workbench has separate inspect/continue actions, an unverified candidate baseline notice, and restoration for unavailable as well as expired saved builds. Selecting/inspecting does not call rollback or publication.
- A pending selection is stored in this browser under owner/project scope and survives a remount/sign-out. Submitted selection is stored server-side on the Run and visible in the conversation after reauthentication. A pending unsent browser preference is not cross-device synchronization.

## Verification (2026-09-27, Node 24.19.0)

- RED: real HTTP/PostgreSQL test against the previous repository implementation returned accepted source instead of the explicitly selected candidate.
- GREEN: 7 isolated PostgreSQL/HTTP tests passed, covering selected source/plan/Builder handoff and monotonic revision 4; idempotent replay/conflict; cross-owner/project and build-failed refusal; no-accepted-version continuation; restore queue without promotion/check fabrication; explicit CAS conflict; default queued chaining; clarification after reopening.
- RED/GREEN: workbench user-action test first failed for absent continuation control, then passed for explicit selection, remount persistence and the submitted selected/expected pair without rollback/publication calls.
- Web: 104 tests passed; typecheck and lint passed.
- API: 462 tests passed, 102 explicit opt-in tests skipped; typecheck and changed-file lint passed. Whole-API lint finds the existing unrelated `runtime/replay.ts` unused `observedTextLength`; this slice does not alter replay.

The HTTP suite uses real routes, services, PostgreSQL transactions/ownership, immutable source bundle validation and dispatch preparation. Auth and object storage are explicit external fixtures, and remote capacity is represented by controlled sandbox records. No real model, live browser, sandbox creation or production writes were performed in this slice. Real deployed restore→Preview→increment→new-login and the original #37 release matrix remain integration acceptance work; the above does not claim them passed.

Run isolated integration with `PIVLOOM_CANDIDATE_INTEGRATION=1`, `PIVLOOM_EXECUTOR_DATABASE_URL`, `PIVLOOM_EXECUTOR_ENVIRONMENT_ID`, and `MODEL_CREDENTIALS_ENCRYPTION_KEY`. It requires a disposable `pivloom_executor_test_*` database with matching environment identity; it never targets production. Migration 030 is installed only inside that verified disposable fixture when missing.
