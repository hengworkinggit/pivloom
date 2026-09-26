# #47 verification result retention and shared deadline

Implemented on `codex/verification-results`, based on main `81c9334` plus the separately authored #48 / #49 slices. This record describes deterministic fault tests and real isolated PostgreSQL tests; it is not a real-model or production latency result.

## Changes

- A completed behavior remains in the receipt when a later visual program, browser/provider operation, or evidence-capacity check fails. Only fully evidenced model checkpoints can be retained as passed; deferred image-delivery requirements are rechecked.
- The production review owns one 600-second budget, reserving the final 30 seconds for version verification, Chrome cleanup and persistence. A/B/C and provider calls receive the remaining deadline. Cancelled work cannot produce a receipt. Expired or incomplete receipts cannot promote an accepted revision; completed items remain visible.
- Plan setup is checked before browser work. The actual entry point forwards control resolution, initialState, key sequences and native browser capabilities. Native screenshot observation identity is preserved.
- Visual/control inference uses the shared token ledger. The run tool allowance funds Coordinator plus the initial Builder/Reviewer and two permitted repairs: 45 behaviors receive 1,332 calls; the finite maximum for the supported plan size is 2,052. This removes the old shared 384-call starvation; it does not claim every application will finish within the deadline.
- `check.completed` retains verification timing. `toolCalls` remains the existing model-tool ledger; physical browser command measurements belong to the #49 native-runner evidence.

## Validation

Red-green entry tests reproduced the original all-blocked visual failure, unreachable resolver, unbounded sandbox connection, stalled visual request, incomplete model review, and shared evidence/screenshot capacity failures before their fixes. Cancellation and invalid-version protections remain covered.

- API typecheck and ESLint passed.
- Full API suite, run with `npm run test --workspace @pivloom/api`: **494 passed, 98 skipped**, 50 files passed, 103.35 seconds. A subsequent small timeout-diagnostic adjustment was verified by all 38 review/deadline entry tests.
- Real isolated PostgreSQL `review.integration.test.ts` selected suite: **5 passed, 6 skipped**. Covered A4 passed + visual blocked surviving `runReview → finishReview → getCheck`, expired complete receipt refusing promotion, infrastructure rebind, linked retry and timeout retry. Object storage and sandbox/provider boundaries are explicit in-memory substitutes; private Supabase Storage cases were not run.
- The historical network-proxy “environment failure” was reproduced by launching Vitest from the repository root with `--root apps/api`. Running from the API workspace passes. Use the workspace npm script for the full suite.

## Remaining acceptance work

Root integration must provide real native-browser and real-model evidence and complete the original frozen-release matrix. The shadow capacity model still reports the former fixed run ledger until its `currentLimits` is updated to the new budget helper. This slice does not close #37 or claim the three-hour task complete.
