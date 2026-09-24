# RC-11 关联重试：动态引用已恢复，报告纠错仍失败

2026-09-24 UTC；生产 Web/API 同 SHA `855671398e0f292877bfd6508ff60ef6d6fdd3ab`。测试账号 A 在产品页面对首次失败 Run `ce4b4bee-bb40-4bbd-b32f-904a7cae4403` 发起一次“以新任务重试”；本报告只读观察该 Run，没有重复提交、暂停任务、改源码/数据库、注入游戏状态或永久发布。独立 QA 浏览器为命名 `agent-browser 0.36.0` 会话，产品 Reviewer 使用固定 `agent-browser 0.38.1`。

| 对象 | 实测 |
| --- | --- |
| 项目 | `b5031ebf-ec85-4c17-9433-3647d7d81a79` |
| 重试 Run | `11b550d6-6c86-4ade-afa6-a58b18e5dc9a`，`retry_of=ce4b4bee-bb40-4bbd-b32f-904a7cae4403` |
| 模型 | profile `ea2e0acf-4277-4670-8280-1e6635e7b363` v2；UI 显示实际默认 `kimi-k2.7-code` |
| 计划 | 固定 G1–G5，共 17 项子检查，原件 `plan.json` |
| 新候选 | Revision `f99724f1-98fb-4f28-b6e2-4bcf8cc734bd`，v2，build passed，源码 hash `23877d1b0475c59a471779e130d3ea4af6d734182117e9fd4ab4962ea86c9168` |
| 原始 Check | **没有创建**：Run 终态失败前未提交完整有效报告 |
| Run 终态 | `failed/cleanup`，`AGENT_OUTPUT_INVALID`，02:31:28.091 UTC，cleanup confirmed |
| Preview | 02:26:36 初次 ready，浏览器实际看到中文页面与 Canvas 初始棋盘；失败清理后沙箱 `destroyed`，URL 410，独立 OpenSandbox SDK `Sandbox.connect` 返回 404。不得把已加载浏览器内存页冒充仍可访问的 Preview。 |

Coordinator 4 次、Builder 14 次、Reviewer 12 次真实模型请求。Builder 在远端写入 `src/App.tsx`、修改 CSS、执行 tsc/Vite 构建；七个源文件已从页面只读代码视图保存到 `source/`，各自 SHA-256 均与 `manifest.json` 一致，明显不同于首次失败候选 v1。UI 记录了 v2 候选与旧 v1 历史；`preview-initial-loaded.png` 是新候选在沙箱仍活跃时的独立浏览器首屏。**没有在沙箱清理前完成 v2 玩法全量 QA，不能把 v1 的完整玩法测试或 v2 的源码推断算成本轮通过。**

精确 Reviewer 尾部事件：02:30:13 和 02:30:50 两次 `record_behavior` 成功；02:31:03 `browser_click` 返回可恢复的 `STALE_BROWSER_REF`，说明上一轮“元素失效即致命”的修复已在生产生效。02:31:09 `browser_observe` 成功。02:31:26.900 `record_behavior` 被严格拒绝为 `OBSERVATION_NOT_BOUND`：刚才的观察没有对应 behaviorId 的新交互。仅 16ms 后第二个 `record_behavior` 在同一模型响应中开始，尚未给模型机会读取第一次拒绝，旧实现按工具调用计数耗尽唯一纠错额度，Run 最终 `AGENT_OUTPUT_INVALID`。服务端没有把观察-only 证据错判为通过；失败在纠错轮次计数。`workbench-failed.png` 截取了页面终态与 117 条执行记录计数。

最小代码修复在独立 worktree 提交 `71bfcf55bf6e8303dcd6280edb2f025ca9b4b787`：同一模型响应里的多个无效报告逐个拒绝但只耗一次纠错轮；下一模型响应再无效仍 fatal；有效行为记录重置计数。Reviewer 提示明确要求 stale 后重观察、执行同一行为的新动作，然后记录，不允许仅凭 `browser_observe` 通过。红测复现本轮同一模型回复双 `record_behavior`；绿测保留严格证据规则，Reviewer 80/80、API typecheck/lint 通过。该提交**尚未部署，也没有对本 Run 盲重试**。

其他项目隔离：已发布作品项目 `3c866a6a-26e9-4af4-89d4-d84127b7d430` 的 current Revision、sourceHash、更新时间、消息数 61、Revision 数 17 在本轮前后完全一致（`other-project-before.json` / `other-project-after.json`）；其独立站点仍返回 HTTP 200。脱敏结构化原始摘要见 `run-summary.json`，该文件只含 Run/角色/候选/沙箱及 Reviewer 工具状态，不含账号密码或模型密钥。

判定：本轮真实模型生成与构建 PASS；产品 Check FAIL（未创建）；独立 v2 玩法全量 QA NOT_RUN；#27 不能关闭。

浏览器边界：主任务在本轮记录 Codex 内置浏览器（IAB）两次超时，本报告没有把 IAB 超时说成产品 Reviewer 故障，也没有以其作为测试通过证据。独立 QA 改用另一个命名 `agent-browser` 会话；在远端沙箱仍活跃时仅验证了 v2 首屏和 Canvas 初始棋盘，随后因 Run 失败自动清理而无法继续活体玩法。IAB 原始调用记录由主任务保留。
