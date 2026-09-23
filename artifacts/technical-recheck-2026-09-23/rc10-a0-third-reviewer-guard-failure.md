# RC-10 A0 第三次正常重试：Reviewer 的 8 动作上限阻断合法括号计算

时间：2026-09-23 22:44–22:55 UTC。生产 Web/API 同 SHA `7c9244acba2131f08dab43932bbec427da1a294e`、CI 已绿。账号 A 在原项目 `bfbbe5cc-4207-4d3e-9620-84df5035e1bc` 的 UI 对第二次失败 Run 点击“以新任务重试”一次；旧两次 Run 保留。本次 Run `2478fa6d-4757-4c93-84d9-a833f5184a9c`，profile `ea2e0acf-4277-4670-8280-1e6635e7b363` v2，默认实际模型 `kimi-k2.7-code`，原 A0 Prompt 未改，未用 fixture、手改数据库或源码。

Planner 形成 schema v2 五组 17 个 required：计算核心 4、输入与控制 5、边界与恢复 3、结果与状态 3、界面与移动端适配 2。原始计划在 `rc10-a0-third-plan.json`。其中 B02 明确 `2+3*4=14`，B03 明确 `(2+3)*4=20`，B04 包含 `0.1+0.2`，其 expected 只要求非错误的数值，没有要求显示约 0.3。

Builder 生成 candidate v3 Revision `81e435c2-60eb-4905-b3fb-842a8cace844`，`sourceHash=2c5be61432bf6731e6fc893bc227b457526b4103dd6e318fe37cb2aaa378b27c`，build passed。七个源文件逐件下载重算 SHA-256 均与 manifest 一致（`rc10-a0-third-manifest-v3.json`）。逐件扫描 TS/TSX/JS/HTML，未发现 `eval(` 或 `new Function(`。候选 Preview `ready` 且绑定同 Revision/hash，expiresAt `23:15:55.144 UTC`；Run deadline `23:14:49.603 UTC`，租期覆盖约 65 秒。本次没有复现前一轮的沙箱 TTL 截断。

独立浏览器在候选 Preview 实际操作：`2+3×4=14`、`(2+3)×4=20`、`12` 退格为 `1`、`8÷0` 显示“不能除以零”、清空后 `5×6=30`、`(1+2` 显示“表达式无效”、键盘 `Escape→7→*→8→Enter=56`。390×844 下 document/body 宽度 390，无横向溢出，20 个按钮都在视口内且最小宽约 83.5px，点击 `2+3=5`。**但 `0.1+0.2` 实际显示 `0.30000000000000004`**，不满足 `docs/E2E.md` 对合理显示 0.3 的外部断言；截图为 `rc10-a0-third-decimal-precision.png`。候选与移动截图分别为 `rc10-a0-third-candidate.png`、`rc10-a0-third-mobile.png`。独立 QA 不代替产品 Check。

Reviewer 22:51:41 开始，逐项 `record_behavior` 两次并捕获两张图；在 B03 括号行为上失败。B03 计划要求依次点击 `(`、`2`、`+`、`3`、`)`、`*`、`4`、`=`，恰好 8 次；上一 B02 完成后仍有表达式，实际还需一次“清空”以开始独立用例，合计 9 次。`apps/api/src/runtime/reviewer.ts:252–255` 的 `MAX_UNRECORDED_ACTIONS=8` 在记录前禁止第 9 次，违反这个有效测试的最小操作数。生产事件正好显示在第二次 `record_behavior` 后 8 次 `browser_click` 完成，第 9 次 22:54:13 被 `RECORD_BEHAVIOR_REQUIRED:B03` 拒绝；模型再 `browser_observe`，随后又尝试点击，22:54:42 Run 以 `AGENT_OUTPUT_INVALID` 终止。代码 `reviewer.ts:244–250` 把这种本地流程拒绝计入仅一次的报告纠正次数，第二次触发 fatal。这是设计上确定性的门槛冲突，不能归因于真实算术失败、Preview TTL 或模型工具80次上限。

终态：Run `failed/cleanup`、`cleanupState=confirmed`；项目 `currentRevisionId=null`、`latestCheck=null`，v3 candidate/source snapshot 保留，临时 Preview 随清理 expired。失败截图 `rc10-a0-third-failure.png`；脱敏 Run/角色/事件顺序在 `rc10-a0-third-run-summary.json`。**A0 产品验收仍 FAIL，A1/A2 NOT_RUN。** 应允许合法的重置+完整算式操作，在未能及时记录时引导模型记录实际 failed/blocked 结果，并使流程守卫拒绝与报告内容校验分开；修复后再正常 UI 关联重试。即使后续 5/5，仍须修正或如实标记小数显示的外部验收失败。
