# Native verification transport: real OpenSandbox probe

Implementation: verification-v2 integration branch. This is an engine fixture, not a newly model-generated user application or completion of #37.

The real production OpenSandbox service and configured gVisor sandbox image created a disposable workspace. The normal trusted build, source snapshot/remote source/preview marker checks, real agent-browser Chromium, native scene execution and `runReview` receipt path were used. Source/artifact object storage was an explicit in-memory external fixture; no provider request was made. PostgreSQL `finishReview` is separately exercised by #47 integration tests.

Command (credentials stay in the existing private env file):

```sh
PIVLOOM_NATIVE_PROBE=1 node --env-file=/path/to/private.env --import tsx apps/api/scripts/testing/native-review-probe.ts
```

## Outcome

Whole `runReview`: **62.747 seconds**, four expected passing items, one deliberately invalid visual scope **blocked**. Thirteen observations remained, source/preview marker verified, model calls zero, sandbox cleanup confirmed.

- 21 real keyboard calculations (129 keys), scoped result exactly 42, history exactly 20 entries.
- Reload and clear preserved historical records while result became 0.
- An independent scenario cleared app data.
- Keypad/historical text did not substitute for the scoped result.
- A visual scope that does not exist was blocked **without deleting the four completed results**.

The first real probe exposed the cost and unreliability of closing/relaunching Chromium for every scenario: it took 83.893 seconds, and a subsequent browser launch failed after three passing items. The fix resets the candidate document and its origin storage/cookies/cache inside the isolated review session, preserving the browser process. The first corrected probe took 58.464 seconds. The recorded result above is the later file-transport probe at 62.747 seconds; both retained the same four passed / one blocked outcomes. The initial failure is not counted as success.

A separate direct-container transport probe executed the 21-calculation case in 3.765 seconds (29 CLI operations), with reload/clear 0.358 seconds and fresh isolation 2.128 seconds. Those numbers exclude OpenSandbox preparation, trusted source checks and finalization, so they are **not** the product acceptance time.

Raw results: `artifacts/verification-v2-2026-09-27/native-review.json`. Independent class/entry-point regressions test the complete sequence, rejection of missing input evidence, scoped false-pass prevention and cancellation. Full real-model acceptance remains outstanding.

The file-transport follow-up transfers large evidence packets through a bounded private result file and screenshots as binary artifacts, avoiding the shell log tail. Regression cases cover >2 MB observation packets, a 1.6 MB PNG, malformed command responses still closing Chromium, cancellation while a result download stalls, and resuming an ambiguous control without replaying earlier actions. The focused transport/admission/review suite passed 41 cases; independent static re-review of the two original blockers found them resolved.
