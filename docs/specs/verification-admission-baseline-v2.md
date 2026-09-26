# Verification admission and cross-type baseline

Related: #46, #48, #51. This document describes a **partial #51 implementation**, not completion of the recovery, UI, or real-model acceptance ticket.

## One admission seam

`apps/api/src/runtime/verification-admission.ts` exports:

```ts
admitVerification(plan, {
  remainingMs,          // from the review entry point's existing shared deadline
  maxSteps?,           // optional, caller-owned measured/resource limit
  maxExpandedKeys?,
  maxExplicitWaitMs?,
})
```

The input is an already parsed `Plan`. The helper uses the actual public `BehaviorProgramSchema`; it does not implement a second program schema or estimate model throughput. It returns JSON-serializable:

- `stats`: behaviors, required behaviors, declared step entries, expanded real keys, explicit wait milliseconds, missing programs, missing initial states, scoped target assertions, declared visual behaviors and legacy page-text assertions.
- `invalidPrograms`: behavior ID, specific reason and public-schema issue paths/messages.
- `programs`: every original behavior ID and required flag, with `READY` or `NOT_RUN`, a failure category/reason, and whether legacy shared initial state was assumed.
- `budgetExceeded`: resource, actual required amount, caller's limit, and exceeded/exhausted reason.
- `timing`: explicit wait time, remaining shared time, `unmeasuredMs: null`, `completionGuarantee: false`.

`READY` means structurally admissible, **not executed, passed, or predicted to finish on time**. `partial` preserves valid and invalid entries without dropping either. A run budget violation makes the entire request `NOT_RUN`; the helper does not silently truncate, batch, or select a cheaper subset. Invalid test definitions remain `invalid-test`, while an otherwise valid program rejected by an overall budget is `not-run`.

The module does not choose default per-run throughput caps. An unconfigured cap is omitted rather than represented as Infinity. Negative remaining deadline time is exhausted. Browser command latency, environment startup, resolver/model work, visual judgment, evidence storage and finalization remain unmeasured; explicit waits are only a known lower bound. A low wait count cannot imply a fast successful run.

## Suggested production wiring — not implemented by this helper

In `runReview`, after parsing/binding the handoff and creating the shared deadline, but before preparing a browser or starting model requests:

1. Call the single admission seam with the **remaining** shared deadline and any already justified run resource limits.
2. Persist the returned accounting with the current run/role/revision/source binding. Do not attach a success verdict to admission.
3. On an overall budget rejection, submit explicit unexecuted items through the existing Check path. They are not app defects and must not trigger Builder repair. Preserve the original required denominator.
4. On partial invalid definitions, expose those exact reasons. The entry point may execute independently valid programs, but it must retain the complete sealed plan and account for every invalid item. Do not remove behaviors from the handoff to manufacture full coverage. A structurally ready `continue` scenario still needs its intended preceding state; admission cannot prove runtime preconditions or invent a dependency graph.
5. Reuse existing cancellation, version identity, failure classification and finalization. Admission does not acquire a second deadline, retry automatically, or accept an old result as evidence for a new revision.

Legacy prose and programs remain readable. Historical unscoped page-text assertions describe only page-text facts; they do not establish a result field, list state or Canvas pixels. An old unspecified initial state is reported as legacy shared state, never falsely described as a fresh isolated scenario. Known erroneous old programs require an explicit test revision; admission does not repair their meaning through keyword heuristics.

## Cross-type fixture baseline

These are controlled test assets and read-only comparison instructions. They are not production apps or evidence that a fresh model generated the correct implementation. Platform assertions cross the real public schema/kernel seam; external browser/provider adapters are fixtures where stated.

| Type | Correct sample and scoped observation | Negative/control sample that must be rejected | Existing evidence and remaining work |
|---|---|---|---|
| Calculator-like input/history | After clear, Expression is empty and Result is 0 while history retains `1+2=3`; all 21 real submissions preserve the latest 20 records and final result 42 | Result 999 with keypad/history containing 0 must fail; six or eleven computations do not cover a 21-computation requirement | `tests/runtime/replay-programs.test.ts` exercises actual kernel with external browser fixture; root separately integrates native-browser and real-model runs. No latency SLA follows from the fixture. |
| Generic form/list CRUD | Named input and submission list; a successful save appears in the intended list, and an independent fresh scenario starts empty; reload inside a save scenario retains the record | Same text in navigation or another list cannot satisfy the assertion; zero/multiple ambiguous outcome matches produce a definition error; changed assertion target/count cannot silently pass preservation | `tests/runtime/replay-programs.test.ts` and `tests/generation/verification-programs.test.ts`; require native-browser good/bad app pair before declaring cross-type product acceptance. |
| Dynamic UI | An asynchronous submission settles, then the named queue item is inspected; explicit wait is counted in admission | Stale or absent outcome is not guessed from old page text; a disabled/unavailable control, stale locator and true app failure need distinct runtime evidence | Controlled asynchronous fixture exists in `replay-programs.test.ts`; complete live dynamic-control behavior, cancellation while pending, and post-cancel restoration remain integration obligations. |
| Canvas/game | Real start/direction input and before/after image evidence establish drawing/movement; DOM score is supporting evidence only | Blank canvas, menu-only render, disconnected keys, fake score increments, and missing collision behavior must not pass from HUD text | Historical assets exist under `tests/fixtures/canvas-negative/`. `local-reviewer-probe.mts` lists these five modes but uses a real provider and is **not run by this change**. Admission merely preserves declared `evidence: visual`; the new unit test verifies that a valid DOM score assertion does not remove the visual requirement. A current visual-provider/browser run remains necessary. |

For each real positive/negative comparison, keep the same candidate version, program and environment; record verdict, evidence and phase duration. Do not replace a deliberately broken sample with an easier sample or report one positive run as a measured false-pass/false-fail rate. A new version gets new execution evidence even when its test program is reused.

The admission module does **not** infer Canvas semantics or detect whether a plan forgot to declare a visual claim. Nor can it prove API/auth/database behavior by counting DOM assertions. Those need appropriate runtime tests and, for unsupported application classes, an explicit coverage limitation.

## #51 acceptance audit at this partial change

| Ticket requirement | Evidence delivered here | Still required before closing #51 |
|---|---|---|
| Distinguish app assertion, test/setup, infrastructure, timeout and not-run; route repair correctly | Admission identifies schema-invalid test definitions and work that never ran; #48 kernel distinguishes incorrect scoped outcome from missing/ambiguous target | Production mapping for all five categories; verify test/infra failures do not blindly dispatch Builder, including failures after partial success. Helper alone does not prove this. |
| Control no-change same-candidate/same-program duplicates; scope repair while retaining required accounting | Stable program preservation exists in #48; admission retains every required ID and never truncates a request | A reachable duplicate-run guard, explicit retry reasons or changed inputs, targeted repair plus necessary regression, and full required release accounting in real entry/transaction tests. No such ledger is added here. |
| Workbench/API show actual coverage/time and preserve completed evidence | Serializable preflight workload/limitations available | Persist and expose actual executed coverage, per-phase wall time and current version identity; UI validation; late fault must preserve completed items. Preflight counts are not executed coverage. |
| Good/bad calibration across calculator, forms/lists, dynamic UI and Canvas, cancellation and recovery | Public-seam regressions and the comparison matrix above | Current real browser/model positive and negative samples for every claimed class, cancellation and recovery evidence; no performance/false-positive rate is inferred from mocks or historical Canvas artifacts. |
| Same model/environment true increment timing includes whole review; reliable completion within ten minutes is measured, timeout/blocked is not success | Shared remaining time accepted; explicit waits can reject a provably impossible run before execution | Full production entry-point integration and bounded fresh real-model increment(s), complete review time including prepare/save/finalization, successful required verdicts, fixed model/environment details. No check here qualifies as this acceptance. |

## Local verification

Small red-green slices covered: absent admission module; missing definition accounting; concrete budget overflow and exhausted deadline; non-finite budget rejection. Additional checks cover schema-owned 512-key program limits and preservation of a visual requirement alongside DOM assertions.

```sh
PATH=/Users/heng/.nvm/versions/node/v24.19.0/bin:$PATH \
  npx vitest run --root apps/api tests/runtime/verification-admission.test.ts tests/generation/verification-programs.test.ts
```

Result at this partial implementation: **15 tests passed** (10 admission cases, 5 existing program-contract cases). This command makes no browser, model or production calls. Full merged-suite/production results belong to the integrating branch.
