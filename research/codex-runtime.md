> 这是专项调研笔记。部分选型建议基于该子问题独立提出；最终跨项目组合与本次实施范围以[综合决策报告](atoms-product-and-architecture.md)为准。

# Codex 架构研究（2026-09-21）

## 决策摘要

对 6–8 小时的在线 Atoms Demo，Codex 的合理角色是**可替换的代码执行后端**。若已经能在 Linux 容器中运行 Codex 并有 API 凭证，优先 TypeScript SDK 的 `startThread()` + `runStreamed()`，由自己的 Node worker 转成 SSE 给 Web UI；不建议先 fork Rust core，也不建议第一版实现整个 app-server 客户端。

对长期产品，app-server 的 Thread/Turn/Item、双向审批、流式事件、中断、恢复、MCP 是很值得参考的交互协议。但它不提供多租户 SaaS、业务数据库、预览发布系统。当前官方页面还明确将 app-server 命令/WebSocket transport 描述为 experimental、not supported for production workloads，必须锁版本、做兼容适配和故障恢复，不宜描述为可直接上线的 SaaS 后端。[官方 app-server](https://learn.chatgpt.com/docs/app-server)

## 实际开源范围

- `openai/codex`，Apache-2.0；本次固定 SHA `48f897e4ce94152818ce0563b3a8aac3a70ce9b8`（2026-09-21）。核心 runtime 是 Rust workspace；CLI、app-server、官方 SDK 可研究和复用。[LICENSE](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/LICENSE)
- 官方开源清单明确 IDE extension 和 Codex cloud 非开源。开源 harness 不等于桌面 UI、云调度平台或模型权重；不能将当前 Desktop 工具能力当成仓库直接提供的产品能力。[官方开源边界](https://learn.chatgpt.com/docs/open-source)
- 模型访问和托管服务独立于开源许可证；部署时要准备自己的合法凭证和预算，不能把开发者个人 ChatGPT 登录态当作公共 Demo 的多用户身份系统。[官方平台说明](https://developers.openai.com/blog/codex-as-a-platform)

## 源码核实

按用户要求先用 `codebase-memory-mcp` 建图，再用图定位和 `get_code_snippet` 精读。已索引项目 `nano-atoms-codex-research`，124,513 节点、903,682 边；环境没有 codegraph 服务，因此用 `get_code_snippet` 代替。以下关键路径 coverage 无记录缺口；不将图的启发式调用边当绝对事实。

| 层 | 已定位符号/源码 | 事实与意义 |
|---|---|---|
| TS API | [`Codex.startThread`/`resumeThread`, 25–38](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/sdk/typescript/src/codex.ts#L25) | 创建 Thread 包装对象；resume 依赖已有 thread id 和底层本地持久化，非远端 SaaS session 服务 |
| 流式包装 | [`Thread.runStreamedInternal`, 70–115](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/sdk/typescript/src/thread.ts#L70) | 把 sandbox/cwd/model/approval/signal 传入 exec，解析 JSONL，捕获 `thread.started`，向调用者 yield typed event |
| 进程边界 | [`CodexExec.run`, 91–258](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/sdk/typescript/src/exec.ts#L91) | 实际 spawn `codex exec --experimental-json`；带 threadId 时追加 `resume`；stdin 提交 prompt，stdout 逐行解析，AbortSignal 和 finally 清理进程 |
| Rust 核心 | [`submission_loop`, 411–617](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/codex-rs/core/src/session/handlers.rs#L411)、[`run_turn`, 163–817](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/codex-rs/core/src/session/turn.rs#L163) | 输入/操作分派与执行一轮工作；图揭示 input queue、hook、budget 等相邻职责，说明并非一个简单模型 API wrapper |
| 多代理控制 | [`AgentControl`, 50–143](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/codex-rs/core/src/agent/api.rs#L50) | 原生有 spawn/resume/send/interrupt/close/list/watch、执行容量与 usage accounting 接口；这些是 runtime 原语，非自动交付高质量网站的业务流程 |

**特别易错点：当前 TypeScript SDK 包装 `exec`；当前 Python SDK 文档则描述为 app-server JSON-RPC 客户端。不要笼统说所有 Codex SDK 都基于 app-server。** TS SDK 为 server-side、Node.js 18+，也不是浏览器内 SDK。[TS 源码 README](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/sdk/typescript/README.md)、[SDK 官方文档](https://learn.chatgpt.com/docs/codex-sdk)

## 可以拿走的架构思想

Thread = 持续对话；Turn = 一次用户请求及工作；Item = 消息/命令/文件变更/工具调用等。这适合让产品把“正在改代码、验证失败、等待用户、已生成预览”显示成真实事件，不依赖猜测模型输出。app-server 是双向 JSON-RPC：client request/response + server notification + server-initiated approval request；支持 stdio、实验性 WebSocket。支持 `thread/start|resume|fork`，`turn/start|steer|interrupt`。宿主需要自行管理连接、请求 id、事件归属、断线恢复和 UI。

上述 app-server 摘要只描述协议，不代表 UI 成品；详情统一参照[官方协议](https://learn.chatgpt.com/docs/app-server)。代码型业务工具通过 MCP/skills 扩展，业务规则应保留在产品控制层；用户是否能发布、访问哪个项目、使用谁的密钥，不应交给模型自行判断。[MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)、[Skills 文档](https://learn.chatgpt.com/docs/build-skills)

## 沙盒、持久化及多用户门槛

1. **运行环境**：SDK 启动本机原生进程，需要 Node + Codex binary + 可写工作目录 + 执行构建/测试的工具链。单个 HTTP 函数不能被默认视为持久 worker；在线 Demo 推荐常驻 Node worker 或按项目容器。
2. **隔离**：`workingDirectory` 是路径选择，不是租户隔离。每个项目分独立工作区；面向不可信用户进一步分容器/微虚拟机、资源预算和网络策略。Linux sandbox 涉及 bubblewrap/user namespace，需部署前验证，不能只在 Mac 跑通就认为云端可用。[Sandbox 文档](https://learn.chatgpt.com/docs/sandboxing)
3. **凭证**：`CodexExec.run` 默认继承进程环境；可通过 SDK `env` 限制并注入必要 API key。故必须避免把应用数据库、云发布密钥等全量环境暴露给生成代码执行进程。若业务发布需要凭证，用独立受控工具代理。
4. **持久化**：TS SDK README 写明 thread 存于 `~/.codex/sessions`；要保留对应卷/状态才可 resume。自己的数据库还需保存 user/project/run/thread 关系、消息、版本、预览 URL、状态和计费；文件、构建产物也应保存。聊天恢复不等于工作目录恢复。
5. **恢复与回滚**：resume 恢复对话；fork 分支对话；app-server 的历史 rollback 已 deprecated，它不是项目文件的撤销。网站“回到上一版”应基于 Git commit/snapshot + 构建产物版本，不能仅回滚聊天记录。[源码 app-server 说明](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/codex-rs/app-server/README.md#thread-rollback)
6. **产品工作流**：项目配额、同项目单写锁、取消/重试、预览代理、浏览器验收、发布权限、成本和审计都需自建。多代理增加冲突、成本和编排复杂度，Demo 先用一个生成 agent + 确定性构建/验证足够。

## Demo 建议

`Browser UI → Node API（鉴权、项目、消息） → run queue/worker → Codex SDK → project sandbox → build + preview`

`worker → 原始 agent events → 产品事件归一化 → DB + SSE → UI`

交互重点是“需求→真实代码修改→可操作预览→二次修改→刷新后恢复”。对于严格 6–8 小时，固定一套 Vite/React 模板、一个生成代理、一个隔离执行环境、一个预览机制、SQLite/Postgres 持久化；测试失败后至多一次自动修复。先不用多模型自动路由、复杂多代理、重写 Rust、用户侧 connector OAuth。

与 Pi 的关系：两者宜作为可替换 runtime 候选，不必叠成两层 agent loop。若团队 TypeScript 优先、需要多供应商和高度自定义工具，Pi 可做主 runtime、借鉴 Codex 的事件/审批/恢复模型；若现成 Codex API 环境可靠，Codex SDK 可最快提供完整 coding harness。无真实任务质量/时延/成本 A/B 数据时，不宣称谁生成效果更强。长期在自己的 `AgentBackend` 接口后切换；Demo 只落一种。
