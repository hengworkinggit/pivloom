# DEV-04 执行中刷新与事件连接恢复

对应 [#5](https://github.com/hengworkinggit/pivloom/issues/5)。基线 `281621f` 加本票工作区更改，**本票验收通过**。覆盖 F04/F06/F07、T08/T09、E10/E19/E20/E26 及 I01/I04；不包含跨进程 Agent 栈恢复、用户取消、真实 Reviewer 或正式版本晋升。

## 环境与故障边界

- Codex 内置浏览器操作真实工作台 `http://localhost:45231`；继续使用自托管 Supabase、OpenSandbox Docker/gVisor 和页面已有的 Ark `glm-5.3-flash` 配置。
- 专用浏览器测试项目 `cb7aac35-16a0-40f7-959d-0e004ce5b37f`，由 UI 创建。初始鉴权 HTTP/数据库读回确认 Run、消息、角色、版本和沙箱均为 0。
- 本地验证代理源码：[network-proxy.ts](../apps/api/scripts/validation/network-proxy.ts)。它不被生产 API 导入，只监听本机回环；维护命令通过权限 0600 的 Unix socket 发出，不接受浏览器 fault 参数或 prompt 指令。
- 代理仅针对该项目的一次真实 202 丢弃响应，以及该项目一条已建立 SSE 连接的主动关闭；必要时将首次重连延迟最多 8 秒以观察 UI。生成执行器、模型、沙箱与数据库均继续正常工作。
- 代理只记录方法、状态、Run/event ID、幂等 ID 与请求 hash，不记录 Authorization、请求正文、模型 Key 或预览访问凭据。
- 独立 HTTP 边界自测通过：首次接受响应丢失、同 key 的显式重放仍到原上游任务、一次断流可读到 EOF、第二次断流命令被拒绝；日志不含凭据或请求正文。此自测的上游是明确的 HTTP fixture，不是生成质量样本。

## 当前验收状态

| 检查 | 状态 | 范围 |
| --- | --- | --- |
| 真实数据库提交通知与历史/实时交接 | PASS | 独立启用的集成测试已复现旧代码丢终态窗口并通过修复；4 组分别独立执行通过；累计 10 组 fixture 精确清理均为 0 |
| 前端迟到快照、404、重连 cursor/抖动 | PASS | HTTP/组件边界测试，不能代替以下真实浏览器操作 |
| E10/E20 同一个真实 Run 的刷新、断线恢复、离开后继续 | PASS | 运行中重载、原游标重连、离开后后台继续，重开读回同一 Run、候选及终态 |
| E19 两标签冲突、未知接受结果与原 key | PASS | 一次真实 202、竞争 409；失败侧保留 81 字草稿；未知结果重载后显式同 key/body 重放，仍为原 Run |
| E26 桌面、390px、中文草稿与键盘 | PASS | 实际宽度与 scrollWidth 均 390；切面板/换行/重载不丢中文草稿，方向键切源码、Enter 展开日志 |
| 最终测试、lint、typecheck、build | PASS | API 81 PASS / 17 opt-in SKIP，Web 47 PASS；跳过不计为真实集成通过 |
| Standards/Spec 复查 | PASS | Standards 0 项；Spec 唯一 P2 已修复，真实数据库和 HTTP 回归通过，复查无剩余 P1/P2 |

真实项目的阶段快照见 [browser-state.json](../artifacts/dev-04-2026-09-22/browser-state.json)。正式候选仍遵循 DEV-03 边界：无真实 Reviewer 时不能把 CHECK_BLOCKED 当作 completed/current。


## 真实工作台执行记录

2026-09-22 13:11:42–13:20:54（Asia/Shanghai），Run `5d25deaa-67c4-4198-9e31-0e6be3275be9` 使用页面保存的 Ark `glm-5.3-flash` 配置 v1，执行真实 Pi Builder / 远端 gVisor / Supabase。API Boot `17e84c53-0ccf-47b4-82e9-43a798820a87`，基线 `281621f` 加本票修改。只有一个 Builder session、一个 Run、一条用户消息；结束后另有一条结果消息，不能把总消息数 2 当作重复提交。

- 两标签同时提交同项目：第二标签被接受，第一标签返回 PROJECT_BUSY，81 字原草稿仍在。接受响应在本地代理被刻意丢弃；未知结果页面重载后仍显示待确认提示和 59 字请求。显式点击确认使用相同幂等 key 和 body hash，202 replayed=true，未创建第二 Run。
- 13:13:25 主动关闭一次目标 SSE；UI 显示“正在连接实时执行记录…”，原生成阶段未被取消。5 秒观察延迟后从 after=218 重连，之后流上收到 36 个不同 event ID，未重复。没有声称捕获了瞬间的另一条重连文案。
- 页面离开后服务仍执行 read/write/edit/bash 与可信构建；浏览器工具曾连接超时，两原标签在回合清理后已不存在。重开同项目后从权威 GET 恢复 48 条历史及终态；这部分不是声称通过 SSE 看到了全部末尾事件。
- 候选 Revision `df34573b-af20-4072-88bf-a19f0d589dec`，sourceHash `0f3c29597b746924ba50c3bd8874fe06320ffcad485ca5378df45c0209e68dc6`，10 个源码文件。仍按 DEV-03 明确 CHECK_BLOCKED / 尚未检查，current=null；不冒充 Reviewer 通过。
- 实际跨源 iframe 计数器初始 0，加一两次得到 2，减一得到 1；刷新预览后仍 1，重置后 0。代码面板可读取保存的 10 文件。
- 390px 工作台输入“下一轮草稿：保持中文输入”并 Shift+Enter 换行，再输入第二行；切换结果、方向键切代码、返回对话及整页刷新，草稿保持 20 字、原 Run/候选不变。Enter 可展开默认折叠的 48 条真实日志。截图已在本任务的 Codex 浏览器工具结果留存，未把内联截图伪称为本地文件。
- 重开时曾短暂显示“服务暂时不可用，请稍后重试。”，随后自动读回同一终态；未吞草稿、未自动重发生成。该瞬时失败保留为测试观察，不隐去。

[阶段状态](../artifacts/dev-04-2026-09-22/browser-state.json)、[故障代理原始日志](../artifacts/dev-04-2026-09-22/network-journal.jsonl)、[幂等与游标摘要](../artifacts/dev-04-2026-09-22/network-summary.json)、[最终检查](../artifacts/dev-04-2026-09-22/checks.json)。原始代理日志中，首次接受前普通请求因 undefined 比较曾误记为无 runId 的 stream 日志；已增加非空判断和独立 HTTP 回归，保留原记录，统计只使用真实 runId。

## Standards

独立审查 `git diff 281621f`：0 项发现。末尾 200 条 SQL 与本地代理修正的增量复查亦为 0；没有以代码审查替代真实 E2E。

## Spec

初审 1 项 P2：历史快照只取最早 200 条，长日志终态重开时会漏掉 run.finished。修复为取最后 200 条再升序返回，保持 owner/run 限制、字符串 ID 和有限响应。真实数据库回归先失败（首 ordinal=1，预期 7），修复后仓储断言通过；同次后续 HTTP 读回超过 15 秒，失败记录保留。复跑同一 15 秒截止，HTTP 11.799 秒通过，返回 ordinal 7–206 且末条 run.finished；其中鉴权 827ms、快照 SELECT 9439ms。未放宽时间限制，数据库边界延迟仍是后续部署时需要关注的性能事实。独立 Spec 复核无剩余具体 P1/P2。

## 范围与维护

当前只支持单实例进程内通知，持久事件负责重新连接补齐；不实现跨进程 Agent 栈透明恢复。tool 输出的 250ms/8KiB 批处理、单事件 16KiB 和运行日志 2MiB 上限、跨块凭据脱敏及取消收尾使用独立外部 HTTP/沙箱适配 fixture 验证，不能将压力 fixture 算作真实模型质量样本。


[真实事件集成与清理](../artifacts/dev-04-2026-09-22/events-checks.json)、[日志公共边界测试](../artifacts/dev-04-2026-09-22/runtime-checks.json)。真实事件测试包括 COMMIT 后通知/回滚不通知/普通订阅者不阻塞、历史与终态提交交接、未来游标、计数和字节队列上限、15 秒心跳、断开不取消和最后 200 条终态读回。授权到期子用例使用明确的外部 Auth HTTP 短 exp fixture；不宣称等待了 Supabase 自然过期。模型与沙箱不参与这些事件集成测试。

临时故障代理与 45314 API 已停止，最终构建的正常 API 恢复在 45310；实际 ready、数据库状态和原站点核对通过。候选预览沙箱由正常关闭流程回收，DB 标 destroyed、远端 sandbox 容器为 0；源码和测试项目保留，默认模型未变，原站点 HTTP 200。[恢复与清理记录](../artifacts/dev-04-2026-09-22/cleanup.json)。

正常服务恢复后的内置浏览器重载复核通过：同一 Run/候选、48 条默认折叠日志和 20 字两行草稿仍在；预览如实显示已到期，源码快照保持可读。
