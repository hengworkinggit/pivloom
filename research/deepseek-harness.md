> 这是专项调研笔记。部分选型建议基于该子问题独立提出；最终跨项目组合与本次实施范围以[综合决策报告](atoms-product-and-architecture.md)为准。

# DeepSeek Harness：面向网页 AI 应用生成 Demo 的架构评估

调研日期：2026-09-21。GitHub 固定 commit：`ddefc45fbc7f8e46dd73185e68295696d1297887`（2026-09-17，release 0.1.6-alpha.2）。只读官方站、官方仓库文档与源码；未运行带模型请求的集成测试，因此下面分清“已核实能力”和“落地推断”。

## 结论

**6–8 小时从零做自然语言→代码→预览→多轮修改→持久化→在线体验 Demo，不建议把完整 DeepSeek Harness 作为默认首选直接依赖。建议用 Pi SDK 这类轻量运行底座，参考 DSH 的事件日志和能力接口设计。** 如果团队已熟悉 Cordis，或目标实际是可重组、可审计、多模型的通用 Agent 工作台，DSH 值得做独立技术验证，并可通过 TS SDK 接入；不要为了一个网页生成 Demo 改造其完整 Web 产品和插件树。

理由不是 DSH 没有能力：它有完整 TypeScript/Python SDK、headless、可恢复会话、模型适配、多智能体、工具执行和本地 sandbox。但当前 SDK 的取消/逐请求结果/交互审批协议存在明确边界，插件树与 profile 组合增加学习面；而网页生成产品最重要的模板约束、真实预览、应用版本、错误修复和发布 URL 都不由通用 harness 自动提供。官方也明确是 developer preview，会有破坏兼容的变更。[README](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/README.md)

## 已核实的定位和能力

| 主题 | 官方实际能力 | 对 Demo 的含义 |
|---|---|---|
| 许可/状态 | 根仓库 MIT；版本 0.1.6-alpha.2；developer preview 明示破坏兼容变更 | 可以商用与修改（保留许可），但应锁版本，不按稳定平台承诺设计 |
| 核心 | Cordis 管理插件生命周期/依赖；model/tool/session/loop/UI 都是可替换插件 | 最值得借鉴的是职责边界，不必在 Demo 内复制插件市场 |
| Profile | web、headless、sdk、sdk-minimal、acp；ordered bundles + patch 覆盖 | 同一 runtime 可有多个产品入口，适合后期桌面/Web/自动化共用 |
| Session | append-only SessionEvent 是模型历史来源；deriveMessages 投影历史；durable facts 与 live stream 分离 | 会话恢复、工具审计、失败诊断应由事件驱动；但不能把 Agent 日志误当生成应用的文件版本库 |
| SDK | TS client 启动同版本 dsh 子进程，stdio JSON-RPC；run、session、notification；Python 也存在 | 能嵌入自有后端，DSH 不仅是 CLI |
| Headless | 一次任务一个进程；支持 --json 和 --session-id 恢复已持久会话 | 适合批处理，网页交互优先 SDK；--json 文本是 step 提交后输出，非逐 token |
| Code mode | PTC：run_code + 生成的工具 SDK；模型用 TypeScript 编排多工具 | 是工具编排模式，不是“自动生成网页产品”的专属模式 |
| PTC 执行 | 当前 Node provider 每次 fresh process，共享 session 文件策略；有时限、输出限额、V8 heap 上限 | 新版本架构不应按旧搜索结果声称仅 worker-thread；非持久 REPL |
| Sandbox | Linux bwrap→Landlock；macOS Seatbelt；Windows restricted-token ACL。约束宿主文件效果，不构成云多租户容器 | 上线执行陌生用户生成代码仍要独立执行环境与租户边界 |
| Subagents | 可插拔 spawn/fork in-process、DSH SDK、ACP、Codex、Claude Code provider；one-shot 与 continuable child 不同 | 不必把多 Agent 作为 MVP 要求；子 Agent 调度不会自动解决应用构建并发写冲突 |
| Workflow | 可选脚本编排能力，模型编写 JS 调用 subagent，事件记录阶段/成员结果 | 不是持久工作流平台的默认同义词；脚本进程、取消清理与恢复边界需单独验证 |
| 模型 | DeepSeek direct adapter + llm-pi-ai；支持自定义 OpenAI Chat Completions/Responses、Anthropic Messages endpoints | **DSH 已复用 Pi AI 的多模型适配**，两者不是完全互斥的替代品 |

一手证据：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/architecture.md)、[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/LICENSE)、[官方产品页](https://www.deepseek.com/harness/en/)、[TS SDK](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/client/README.md)、[Headless](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/bundle/headless/README.md)、[PTC mode](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/README.md#ptc-mode)、[Node PTC](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/ptc-runtime/ptc-runtime-node/README.md)、[Sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sandbox/sandbox-local/README.md)、[Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/subsystems/subagent.md)、[Workflow](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/subsystems/workflow.md)、[Pi AI adapter](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/llm/llm-pi-ai/README.md)。

## 精读代码得到的边界

遵循用户代码发现规范：先用 `codebase-memory-mcp` 对 /tmp 独立 clone 建图，显式 project `nano-atoms-deepseek-research`，再 search_graph→trace_path→get_code_snippet。环境没有 codegraph server，因此用图工具自身精确源码能力替代；没有用硬搜跳过图做符号发现。graph 统计含 82,179 nodes / 212,657 edges，数字只说明所分析仓库不是一个极小 loop。

1. `ReactLoopAgent.step` 位于 `packages/core/agent-loop/src/agent.ts:353–499`：prepareRequest→提交 system/user events→stream→durable assistant settlement→executeToolCalls；tool calls 还欠结果时进入下一个 step。失败/重试 attempt 留日志，成功 message 才进入模型历史。[源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/agent-loop/src/agent.ts#L353)
2. `HarnessSession.run` 位于 `packages/sdk/client/src/api.ts:176–224`：subscribeSessionTree→prompt 返回 messageId→等 durable inbox receipt→收集直到整个 Agent idle→从 events 取 finalResponse。它**不是把结果严格归因到单个 prompt**，在允许 steering/并发排队时产品层需要自己管理 request/run 状态。[源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/client/src/api.ts#L176)
3. `PtcWorkflowEngine.start` 位于 `packages/workflow/workflow-ptc/src/index.ts:133–188`：校验 meta/脚本、选 subagent provider、应用 maxTotalAgents/maxConcurrentAgents、以 parent.session sandbox policy 创建 run 并发出观察事件。适合借鉴明确并发限额与父子归属。[源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/workflow/workflow-ptc/src/index.ts#L133)

## 决定是否直接接入前必须验证的原生边界

- **取消**：SDK 文档明确 wire 无 cancel/session-close；终止当前 turn 要关闭 runtime process。网页停止按钮若要求只停一个 project 的 run，要么每项目/会话独立子进程，要么自行扩展协议；不能声称 SDK 已有精细取消。[协议限制](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/protocol/README.md#known-limitations-and-deferred-work)
- **事件流**：headless --json 的 text/thinking 是 committed message 后输出；SDK SessionEvent notifications 不等同于 Web live token channel。需验证所选入口的首 token、tool_started、stdout、preview_ready 能否满足自己的 SSE UI，不要按“支持 streaming”笼统验收。
- **审批**：SDK server→client request/交互审批仍未实现；自定义工具产生 ask 时要验证无界面情况处理。不要照搬 Web UI 的审批能力到 SDK 的承诺。
- **隔离**：官方 SAFETY 明确未经安全审计，不可单独作为不可信任务的安全控制；sandbox-local 分享宿主 kernel/filesystem。在线 Demo 若执行用户代码，容器/云 sandbox 是单独的一层。
- **minimal profile**：Python minimal 文档明确该 profile 采用 danger-full-access，缺少很多默认工具/compaction/子 Agent；不能把 minimal 理解为默认更安全。标准 sdk profile 和 minimal 应分别测试。
- **持久化**：SDK 会话日志持久化和 app files/preview/deployment 的持久化不同。仍需 projectId、revisionId、artifactManifest、working directory、previewURL 的产品数据库。
- **模型兼容**：UI 列出 provider 与真实 tool-call/reasoning/image 支持分开验收；custom gateway 的 developer role/max_tokens/response 协议存在兼容配置。官方 provider 页面与 adapter 文档对 OAuth 入口的描述层次不同，Demo 推荐显式 API key 而不承诺 Codex 账户登录即用。

## 值得借鉴的最小设计

建议自己的产品层保留少数稳定接口：`AgentRunner.run(input, events)`、`Workspace.read/write/patch`、`Execution.exec`、`Preview.start/status`、`ArtifactStore.snapshot/restore`。**本次只选择一个 Runner 和一个 Execution Provider**，不要装 Pi + DSH + Codex 三套运行时。

值得直接学：

1. durable events 与实时 UI events 分层。后端事件 `run.started → file.changed → check.finished → preview.ready → run.completed/failed` 记录为可追加日志；UI 文本 token 可以短暂不落盘；完整产物以 snapshot/manifest 为准。
2. 模型能力、执行能力、产品功能分离。换模型不应改 preview service，换 Docker/E2B 不应改 Agent loop。
3. 工具流水线统一：schema 校验→权限/路径检查→执行→标准化结果→事件。允许工具失败喂回 Agent 修复，但应用 build 成功才显示可用预览。
4. 自定义版本节点串联 prompt、改动文件、build log、preview URL。可回退、可展示的交付过程，是面向用户的创新；“everything-is-plugin”本身不是用户收益。
5. 多 Agent 放后面。先让单 Agent 在受控模板上稳定完成生成→构建→修复（限 1–2 次）→预览，再考虑并行设计/验证。

若团队坚持 DSH 实现本次 Demo，最保守路线：**标准 sdk profile + TS SDK + 单会话串行队列 + 独立 workspace/container + 自己的 SSE 事件投影**；锁定 0.1.6-alpha.2；不要改 DSH Web UI，不启用 workflow/teams/Code mode，先验收一次生成、多轮修改、process restart resume、停止、超时、构建失败修复这六件事。任何一项在 45–60 分钟 spike 内不稳定就回退轻量 Runner。这个时间限是工程建议，不是已经测得的性能。
