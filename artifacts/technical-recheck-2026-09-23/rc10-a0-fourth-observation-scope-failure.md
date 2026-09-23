# RC-10 A0 第四次正常重试：Reviewer 的 observation 引用未通过校验

时间：2026-09-23 23:18–23:30 UTC，生产 Web/API 同 SHA `1a5a1beffd0852c3e46aa1cdb282cafc44466696`，CI/生产探针通过。账号 A 在原项目 `bfbbe5cc-4207-4d3e-9620-84df5035e1bc` 的 UI 对最新失败任务点击“以新任务重试”，前三条失败 Run 保留，原 A0 Prompt/profile v2 未改。新 Run `b5d1f724-82b8-4844-85d0-1afa140235de`，deadline `23:48:58.665 UTC`，真实默认模型 `kimi-k2.7-code`。没有 fixture、手改 DB、调换模型或公共发布。

Planner 得到 schema v2 五组 18 个 required：核心计算与表达式 5、按钮输入与控制 3、异常与连续计算 5、键盘 3、中文界面/响应式/实现 3。原始 Plan 在 `rc10-a0-fourth-plan.json`，包括 `2+3×4=14`、`(2+3)×4=20`、小数、除零恢复、键盘、375px 和源码非模板要求。

Builder 于 23:29:10 完成并保存 v4 candidate Revision `d2f95b5e-b5ac-4721-9bf6-219ae27f7fb1`，`sourceHash=e735cb73c72ebf38208e96a135d0005950a10bf772e8e402f9a06f650bfc0c77`，build passed。七文件逐件下载/重算 SHA-256 全匹配（`rc10-a0-fourth-manifest-v4.json`）。源码 `src/App.tsx` 使用 BigInt 有理数与递归下降解析，`formatRational` 保留最多 12 位并去尾零；全 TS/TSX/JS/HTML 未发现 `eval(` 或 `new Function(`。从源码看可避免前两轮 CSP/浮点问题，但**尚未通过独立浏览器操作**，不能把这一推断写成 A0 PASS。Preview ready 时的 expiresAt `23:50:48.902 UTC`，覆盖 Run deadline 约110秒。

Reviewer 在 23:29:10 开始，仅完成 `browser_open`、`browser_screenshot`、两次 `source_read`。23:29:40 第一次 `record_behavior` 被 `OBSERVATION_SCOPE` 拒绝；23:29:45 又发一次 `record_behavior`，23:29:46 Run 即以 `AGENT_OUTPUT_INVALID` 终止。没有任何 `browser_click`/`browser_press`，没有生成 Check，也没有机会验证算术。工具事件只公开拒绝原因，不保存模型参数；`OBSERVATION_SCOPE` 表示引用的观察记录不属于此次检查或 ID 类型不匹配，**具体哪个字段错误尚未证实**。工具协议同时返回事件 `id` 与用于下次动作的 `observationId`，混淆是合理怀疑，但不能把它当已证实事实。

终态 `failed/cleanup`，`cleanupState=confirmed`；project `currentRevisionId=null`、`latestCheck=null`，候选源码保留，Preview 随清理 expired。脱敏 Run/角色/事件数据见 `rc10-a0-fourth-run-summary.json`，UI 截图见 `rc10-a0-fourth-failure-desktop.png` 与 `rc10-a0-fourth-failure-mobile.png`。本次失败非 TTL、非沙箱容量，也非候选业务运行结果；Reviewer 把一次 observation 引用错误后的第二次纠正失败直接视为 fatal。应让工具返回可执行的字段级修正提示并保留必要的纠正机会，或在协议层移除易混淆双 ID；必须保留行为证据校验，不能删掉 OBSERVATION_SCOPE 凑 5/5。

**A0 产品验收仍 FAIL；A1/A2 NOT_RUN。** 等 Reviewer 协议修复、部署同 SHA 并清理确认后，再从页面正常关联重试；候选源码的潜在质量需要独立浏览器及产品 Check 双重验证。
