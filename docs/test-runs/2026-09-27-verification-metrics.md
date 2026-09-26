# #51 partial slice — Saved verification metrics in the Check API and workbench

This is the result-display slice of #51, not completion of the whole admission/performance ticket or of #37.

- `Check.verification` is optional and reads the existing `check.completed` event. The query binds owner, project, run, reviewer role, attempt, Check ID, revision ID and source hash. No database migration or browser timer is introduced.
- The public contract supports recorded start/deadline/elapsed time, timeout and incomplete reason, and optional preparation/execution/finalization/persistence milliseconds. Missing historical fields remain absent.
- `finishReview` records persistence time from entry until assembling the completion event, with the same total elapsed measurement already used by the durable event. This measures the saved server-side work; it is not a measurement of the final database COMMIT acknowledgement or network delivery to the browser.
- The check drawer displays passed/failed/blocked counts from the actual stored items, saved total and phase durations, and an explicit incomplete/timeout status. Unknown historical duration is “未记录”, not zero. Displaying a timeout does not make the candidate pass.
- The producer of preparation/execution/finalization measurements is the coordinated `runReview` change on the integration branch. This slice accepts and displays those fields without inventing missing phases.

## Verification — 2026-09-27, Node 24.19.0

RED: production `runReview` plus real PostgreSQL `finishReview` saved a verification event, but the reopened Check HTTP endpoint omitted it. GREEN: HTTP reads now exactly match that saved event and the direct Check read; another owner receives 404. Removing the telemetry from the isolated historical event leaves the Check readable without a fabricated field.

The integration test uses real routes/services/PostgreSQL/immutable source validation/receipt issuance/finalization. Auth, storage and an unavailable sandbox are explicit external fixtures. No live model, real browser or production operation is represented as verified by it.

- 15 targeted API tests passed, including all 8 candidate/Check HTTP integration cases and 7 evidence-capacity tests.
- 106 Web tests passed, including a workbench drawer with mixed 4 passed / 1 failed / 1 blocked, saved four-phase timing and timeout state, plus missing historical timing.
- API/Web typecheck, Web lint, changed API-file lint and `git diff --check` passed.

No issue was closed and no production deployment was performed by this slice.
