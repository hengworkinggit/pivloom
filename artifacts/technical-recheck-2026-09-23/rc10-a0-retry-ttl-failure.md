# RC-10 A0 正常重试：Reviewer 被候选 Preview TTL 截断

环境：2026-09-23 22:20–22:36 UTC，生产 Web/API 同 SHA `083c22d1c72664ed61b12508aefd0954b614d65c`；独立 QA `agent-browser 0.36.0`，专用浏览器会话。项目仍为 `bfbbe5cc-4207-4d3e-9620-84df5035e1bc`。从工作台对上轮失败 Run 点击“以新任务重试”一次，保留原失败 Run `ee9a158f-b06a-46b1-8416-ed6696ca731c`；本轮 `4d43a018-9ce0-4c16-9b8a-5935a6895d1c`，A1/A2 未提交。模型 profile `ea2e0acf-4277-4670-8280-1e6635e7b363` v2，profile 名称“火山方舟 · GLM 5.3 Flash”，实际默认 model ID `kimi-k2.7-code`；Run `modelId=null` 表示使用该默认 ID。未使用 fixture、手改 DB 或放宽 Preview CSP。

协调者这次生成 schema v2 的五组、25 个 required，工作台逐项可读（G1–G5 分别 6/10/3/4/2；B01–B25 无缺漏）。完整原始 Plan 在 `rc10-a0-retry-plan.json`；展开首尾截图为 `rc10-a0-retry-plan-ui-top.png`、`rc10-a0-retry-plan-ui-g5-end.png`。旧 v16 项目的历史 Check 在同一生产 SHA 上仍显示“历史平铺 5/5”，原 API `groupResults=null`、items=5，见 `rc06-historical-flat-ui.png`；这只是 #22 的显示兼容证据，并非本次新应用 Check。

Builder 22:24:58 完成并保存 v2 candidate Revision `46f4a405-83b1-442d-b0c9-5258d059291c`，`sourceHash=af6df6acb3b024bda8630f35bb9cd7ce06d890707021c7edd900ce574ce0a622`，build passed。七个源文件逐件下载、重算 SHA-256，全部与 manifest 一致，见 `rc10-a0-retry-manifest-v2.json`。与上轮 v1 的 8 文件/不同 sourceHash 相比，这确实是另一次模型生成的不同候选，不能把失败重试算作 A1 增量。

独立浏览器在新标签对 v2 候选执行 `清空 → 2 → 加 → 3 → =`：表达式依次是 `0`、`2`、`2+`、`2+3`，结果却为“无效表达式”，见 `rc10-a0-retry-broken-addition.png`。更复杂的优先级、括号、小数、除零输入同样误报无效，退格 `12→1` 正常。候选 `src/App.tsx` 的 `evaluate()` 使用 `new Function('return ' + sanitized)()`，并把它的任何异常转换为“无效表达式”；Preview 实际 HTTP CSP 为 `script-src 'self'`（没有 `unsafe-eval`）。这是生成源码与沙箱执行策略不兼容的确切机制。页面没有未捕获错误，因此只查 console/构建会漏掉。应由 Reviewer 真实操作标为 failed 并要求 Builder 使用普通表达式解析器；不能通过放宽 CSP 或模型自述放行。

新版 Reviewer 已改善逐项记录：22:24:58 开始，最终有 `record_behavior` 13、截图 12、`browser_click` 63；22:29:16 一次多余点击被 `RECORD_BEHAVIOR_REQUIRED:B05` 拦下，随后模型成功记录该项。未见 Check 形成之前的完整 verdict，因此不推断这 13 项哪些 passed/failed。

阻断发生在候选 Preview 的固定过期时间：`expiresAt=22:36:19.859 UTC`。22:36:14 一次浏览器点击仍成功；22:36:20.928 下一次 `browser_click` 开始，22:36:20.940 以 `BROWSER_BLOCKED` 失败，22:36:21.039 Run 终止为 `failed`、error=`CHECK_BLOCKED`，同时 `cleanupState=confirmed`。此时 Run 自身 deadline 为 22:50:19，仍有约 14 分钟。项目 `currentRevisionId=null`、`latestCheck=null`、私有 Preview `expired`；v2 candidate/source snapshot 保留。UI 失败截图 `rc10-a0-retry-ttl-failure.png`。这次失败直接由候选沙箱/Preview TTL 早于 Reviewer 生命周期造成，不能归因于模型工具预算耗尽或表单重试。

**判定：A0 仍 FAIL，产品 5/5 Check 未生成，A1/A2 NOT_RUN。** 先修复 Reviewer 活跃期间的候选沙箱租期/续租及其与 Run deadline 的关系；之后从页面正常关联重试，并验证 Reviewer 抓到 CSP 造成的算术失败且进入修复。不得直接再重试同版本来碰运气。

脱敏结构化证据：`rc10-a0-retry-run-summary.json`（Run/角色/工具/终态/Preview）、`rc10-a0-retry-plan.json`、`rc10-a0-retry-manifest-v2.json`。上述文件没有账号凭据、token 或 API key。
