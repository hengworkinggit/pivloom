# Final deployment: fresh A session and accepted calculator v8

Production Web and API both report commit `2e6f917449a7c2b80d3a2897c9dd27d1acec3bc3`, built at `2026-09-24T11:15:48.326149Z`. [CI](https://github.com/hengworkinggit/pivloom/actions/runs/35992009113) passed both the build/unit job and the runner-local PostgreSQL integration job.

This is a real, new `agent-browser` session (`rc12-final-a`). No existing browser state was loaded. Account A signed in through the production login form; credentials were read from the ignored private fixture and are not included here. This supplements the previously recorded A/B/logout matrix without repeating its unchanged authorization cases.

| Item | Observed result |
| --- | --- |
| Project | The existing calculator project `bfbbe5cc-4207-4d3e-9620-84df5035e1bc` opens after the fresh login. |
| Conversation | Original requests, the history increment, both rollback messages and the visual increment remain visible. There are 21 conversation articles, including the runtime activity article. |
| Source | The Code tab exposes all seven saved files. Opening `src/App.tsx` loads its source in the read-only v8 viewer; navigating away and back and opening Code again retains the same file list and version. |
| Version | Current accepted v8 is `36b6a2eb-4852-4cc0-8292-a24a63456cba`, source hash `424bd83f1d55475c0a6acc038e69e6a2e59b121328575dcc199b84d2ee872e2d`. The v7/v6 accepted history and older candidates remain distinct. |
| Check | The saved v8 Check displays 5/5 groups and all 21 child checks. This is the original genuine A2 result, not a new model review. |
| Preview | The temporary preview had expired. The normal “重新启动预览” action rebuilt it from the accepted source; the v8 iframe then loaded. Opening the same authenticated preview as a full page and clicking `2`, `+`, `3`, `=` produced `5` and the `2+3 = 5` history row. No model generation was submitted. |
| Deployment badge | The workbench visibly displays Web `2e6f9174` and API `2e6f9174`, matching both public version endpoints and the release records. |

Evidence: [DOM summary](fresh-a-v8-dom.json), [workbench/preview](fresh-a-v8-preview.png), [source viewer](fresh-a-v8-source.png), [independent preview after real button input](fresh-a-v8-app.png), [release records](release-summary.json).

The desktop workbench screenshot only shows the portion of the calculator fitting inside the embedded preview. The independent preview screenshot supplies the complete application view and the actual calculation result. This run does not repeat all 21 A2 behaviors or claim a new-browser localStorage history should contain another browser's private entries.

The one-off production probe at `2026-09-24T11:18:08.652Z` passed all nine checks: workbench HTTPS, API readiness, original site, permanent published app and its version marker, account A login, project access, model-profile access, and publication metadata. Recurring monitoring was not reenabled.

## Subsequent Reviewer-only release

Web/API were subsequently deployed together at `cedc7b70f68bf6b3fddafa410a17950f8a3cfc75`, built `2026-09-24T12:19:00.048268Z`. The intervening executable changes affect Reviewer checkpoint reminders and the choice of native keyboard batches for real-time games; the frontend, identity, rollback and generated calculator source were not changed. [CI](https://github.com/hengworkinggit/pivloom/actions/runs/35998292965) passed.

After signing into a newly launched browser at this deployment, the calculator still opened as v8 with source hash `424bd83f1d55475c0a6acc038e69e6a2e59b121328575dcc199b84d2ee872e2d`. The workbench shows both deployment badges as `cedc7b70`: [actual workbench screenshot](final-cedc7b7-deployment-badge.png). Both public version endpoints and clean release archives match: [final release metadata](final-release-summary.json). The earlier fresh-session gameplay evidence remains explicitly attributed to `2e6f917`; it is not relabeled as a new full run at this later commit.

## Persisted Reviewer progress release

Web/API now run `241b71637bd08a65703a9a4819a9233e4637855e`, built `2026-09-24T14:09:44.955790Z`. [Public version endpoints and clean archive metadata](review-progress-release-summary.json) agree; [CI](https://github.com/hengworkinggit/pivloom/actions/runs/36010554851) passed both jobs. Changes since `cedc7b7` are restricted to Reviewer image/checkpoint delivery, bounded provider retry progress, reuse of a sealed candidate after a Reviewer timeout, and their integration tests/CI setup. The Web implementation, authentication, rollback, and generated calculator source are unchanged. The prior UI screenshots retain their original SHA attribution.

The one-off [production probe](review-progress-health.json) at `2026-09-24T14:22:58.553Z` passed all nine checks, including test-account authentication and the existing permanent published app. The running Snake check is separate: neither this health result nor provisional behavior checkpoints constitute a completed product Check. Recurring tasks remain stopped.
