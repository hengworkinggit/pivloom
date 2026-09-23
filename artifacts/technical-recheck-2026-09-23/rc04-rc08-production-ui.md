# Production UI smoke at 9aea161

Verified on 2026-09-24 (Asia/Shanghai) in an independent named agent-browser session with test account A. This was read-only: no generation, model test, publish, rollback, or private Preview restoration.

- `GET /version` (Web) and `GET /api/v1/version` (API) returned HTTP 200 with the same full commit `9aea161831ce251b2e9f44476223b66b8f9190d5`. The workbench's visible deployment badge showed Web and API `9aea1618`, with controls to copy each full SHA.
- Model settings at desktop and 390×844 showed the saved default profile, model ID `kimi-k2.7-code`, and status `连接与图像测试通过`. The displayed detail stated that connection, streaming, tool calling, and actual-image understanding were verified. At 390px the card and controls remained visible without page-width clipping. The workbench model selector exposed the saved default profile and `kimi-k2.7-code`; no selection change was made.
- Test account A could log in and open its existing project `3c866a6a-26e9-4af4-89d4-d84127b7d430`. The workbench showed current revision v16, a 17-version history, source file list (7 files), source content in `src/App.tsx`, version/sourceHash/Run ID and linked demand/result. Its v16 check summary read `已检查 5 项行为：5 项通过`.
- The read-only comparison from accepted v15 to current v16 completed: 7 files on each side, 5 unchanged, 2 modified (`src/App.tsx`, `src/style.css`). Desktop comparison worked. The 390px attempt to open the comparison disclosure was intercepted by an overlapping result section, so the mobile comparison interaction is not claimed as passed.
- The existing private Preview correctly showed `预览已到期`; it was not restarted because doing so would create an active sandbox during release cutover.
- The permanent published app `https://3c866a6a-26e9-4af4-89d4-d84127b7d430.app-69-5-7-187.sslip.io/` returned HTTP 200; its JavaScript and CSS assets both returned HTTP 200. The original `https://beats-steps-69-5-7-187.sslip.io/` returned HTTP 200.

Screenshots: [desktop model settings](rc04-rc08-production-model-desktop.png), [390px model settings](rc04-rc08-production-model-mobile.png), [390px workbench](rc04-rc08-production-workbench-mobile.png), [390px history/source](rc04-rc08-production-history-mobile.png), [desktop history/source](rc04-rc08-production-history-desktop.png), [desktop comparison](rc04-rc08-production-diff-desktop.png).
