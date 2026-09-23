# RC-09 rollback UI — isolated verification

Base: `e02e63bc64b44bba7ac8e7e24db994811e5b6bcb` (backend rollback contract). This record covers the UI only; it is **not** E35/E36/E38 production or real-sandbox acceptance.

The history panel offers rollback only for an accepted, built, non-current revision. The confirmation names the authoritative current revision and target, warns that the published site remains unchanged and old Check evidence is historical, and sends `{targetRevisionId, expectedCurrentRevisionId}` with a UUID `Idempotency-Key`. The browser saves the pending key/operation in owner-and-project-scoped session storage; a reload polls the saved operation, while an uncertain POST can be confirmed using its original key. Preparing, prepared, cancellation, cleanup, committed and failed states are visible. A committed operation selects the target revision and refetches the project, history, Preview and publication; the conversation shows the backend's durable `rollback` message separately. A Check from the old run is marked as historical rather than as a fresh post-rollback check.

Validation using Node 24.19.0:

- Web typecheck: passed.
- Web lint: passed, zero warnings.
- Web Vitest: 22 files / 90 tests passed, including the API CAS/Idempotency-Key contract, uncertain response across reload, same-key confirmation, cancellation, accepted-only entrance and explicit confirmation.
- Independent Next.js 16.3.5 local fixture, no production identity/API/model/sandbox: 1280×850 and 390×844 browser clicks both passed entry → v3→v1 confirmation → committed/current v1. At 390 px the confirmation buttons were clickable, document scroll width stayed 390 px, and the saved rollback event was readable under version provenance. The temporary route, dev server and browser session were removed/closed.

Screenshots: [desktop entry](rc09-rollback-ui/desktop-entry.png), [desktop confirmation](rc09-rollback-ui/desktop-confirm.png), [desktop committed](rc09-rollback-ui/desktop-committed.png), [mobile entry](rc09-rollback-ui/mobile-entry.png), [mobile confirmation](rc09-rollback-ui/mobile-confirm.png), [mobile committed](rc09-rollback-ui/mobile-committed.png).

Still required for #25: deployed API/Web on the same SHA with migration 016, real accepted A0/A1/A2 history, full source/Preview/marker tuple, post-rollback increment, restart/race/fault injections and owner isolation. The fixture screenshots only establish that the actual UI component is usable at both widths.
