> 这是专项调研笔记。部分选型建议基于该子问题独立提出；最终跨项目组合与本次实施范围以[综合决策报告](atoms-product-and-architecture.md)为准。

# Pi 架构调研（2026-09-21）

结论：这次短时网页生成 Demo，Pi coding-agent SDK 是合适的 agent 执行底座；用它现成的工具循环、流式事件、会话和上下文压缩，自己做项目、预览、版本和验收。不要 fork Pi 内核，也不要把其终端界面当产品界面。长期可保留这个适配器，但任务恢复、多租户、沙箱、产物持久化与发布属于产品服务层。

## 版本与证据范围

- 旧地址 `badlogic/pi-mono` 经 GitHub API 重定向到 [earendil-works/pi](https://github.com/earendil-works/pi)。当前 npm 命名为 `@earendil-works/pi-*`，不能继续按旧 `@mariozechner/*` 文档拼装最新 API。
- 最新稳定 release 为 [v0.86.1](https://github.com/earendil-works/pi/releases/tag/v0.86.1)，发布时间 2026-09-20，commit `13cbf77df2396303013a41646bcfa77b4271ae56`。安装候选应精确锁定该版本，并锁依赖。
- 本次结构/源码阅读固定 main commit [`c7cdb460aa8a0cebef3446c4166729b8a0d97ead`](https://github.com/earendil-works/pi/tree/c7cdb460aa8a0cebef3446c4166729b8a0d97ead)，比稳定版领先 8 个提交。四种 remote Ops 接口与 stable 一致，read 的新增变化是 image resize options。本报告不把 main 未发布变化当稳定 API。
- [MIT 许可证](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/LICENSE)。部署分发时保留版权与许可声明；模型和依赖条件另行适用。
- 使用 agent-reach 的 GitHub/gh 后端；先 codebase-memory-mcp 索引/架构/符号/调用链，再 `get_code_snippet` 精读。当前未发现 codegraph server，因此以可用图工具的 snippet 替代。图将 `src/core/tools` 整个目录排除，coverage 明确报告 gap，工具适配部分按已知精确路径定点读取。未运行 Pi、未安装依赖、未做模型效果/性能基准。

## 分层与调用链

| 层 | 官方包/模块 | 对我们有什么用 |
|---|---|---|
| 模型 I/O | `pi-ai` | 多 provider、模型定义、消息/工具协议、stream 接口 |
| 推理循环 | `pi-agent-core` | `Agent`、工具调用、流式事件、取消、steer/follow-up、执行前后 hook |
| coding harness | `pi-coding-agent` | `AgentSession`、会话历史、compaction、skills/extensions、默认 coding 工具、SDK/RPC |
| 终端 | `pi-tui` | 终端交互组件；Web 产品无需继承 |
| 新方向 | `chord` / `pi-durable` | 服务/RPC/状态复制及耐久记录设计；须与已交付功能分开评估 |

结构证据：[`createAgentSession()`，sdk.ts:175](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/coding-agent/src/core/sdk.ts#L175) 建立 ModelRuntime、SettingsManager、SessionManager、ResourceLoader，再建 Agent 和 AgentSession；恢复已有消息、模型和 thinking。图的出向调用链验证了这一组装关系。

运行路径是 `AgentSession.prompt → Agent → agent-loop.runLoop → provider stream → tool batch → next turn`。[`AgentSession.prompt:1321`](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/coding-agent/src/core/agent-session.ts#L1321) 做输入 hook、模板/skill 展开、流中消息排队、鉴权、压缩检查和工具载入准备；[`runLoop:162`](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/agent/src/agent-loop.ts#L162) 的内循环处理模型及工具，外循环检查 follow-up。`shouldStopAfterTurn` 可以在已完成工具批次后停止；steering 在工具批次结束后生效，不应在 UI 上承诺瞬间撤销已执行外部操作。

[`pi-agent-core` README](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/agent/README.md) 给出 `agent_start/turn_start/message_update/tool_execution_start|update|end/turn_end/agent_end`。这足以映射为产品的规划、生成、构建、检查、完成活动面板。工具默认可并行；同文件写入要参与已有 mutation queue，或把写工具批次设为 sequential。模型说完成不等于项目验收完成，产品状态机应只由 build/test/preview 证据推进到 ready。

## 现成能力与边界

| 能力 | 已有事实 | 产品仍需承担 |
|---|---|---|
| SDK | `createAgentSession`、`subscribe`、`prompt`、取消/排队/模型切换 | HTTP/SSE 或 WebSocket、鉴权、用户/项目映射 |
| RPC | `pi --mode rpc`，stdin/stdout 的 LF JSONL；命令响应、异步事件 | 子进程生命周期、崩溃处理、网络桥接；RPC 接受成功不代表执行成功 |
| Session | JSONL 的 id/parentId 树，可 resume/fork/compact | 项目文件、数据库、版本/截图、发布产物另存；会话分支不自动回滚代码 |
| Compaction | summary + recent messages，自动阈值、分支摘要、扩展覆盖 | 产品 PRD/验收标准/版本事实应做结构化真相源，别只靠模型摘要 |
| Extension | 注册工具、命令、事件；同名覆盖内置工具，skills、资源加载 | 受控扩展列表、产品契约；不要允许终端用户安装任意服务器扩展 |
| 多代理 | 默认不内置；官方 subagent example 可单个/并行/链式子进程 | 调度、共享代码冲突、预算、工件归并、任务恢复 |
| 沙箱 | 官方明确无内置 sandbox，project trust 只是资源加载许可 | OS/容器/微 VM/云沙箱执行边界、预览隔离、凭据边界 |
| Durable task | 有 JSONL 会话；新 `pi-durable` 有记录契约与内存存储 | 不能当成熟的跨崩溃 durable workflow/多租户任务引擎 |

依据：[SDK](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/sdk.md)、[RPC](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/rpc.md)、[compaction](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/compaction.md)、[extensions](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/extensions.md)、[security](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/security.md)。

Session 的具体落盘路径可看 [`SessionManager._persist:1071`](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/coding-agent/src/core/session-manager.ts#L1071)：首次 flush 写已有 entries，随后 append JSONL。它不是用户项目数据库或工具副作用的事务管理器。

多代理官方 [example](https://github.com/earendil-works/pi/tree/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/examples/extensions/subagent) 每个子代理开独立 Pi 进程，支持流输出与取消，示例并发上限 4、任务上限 8。这证明可扩展，不证明默认已有生产多代理调度。短时 Demo 用单执行代理＋确定性验证器更可控，先保证真闭环。

`pi-durable` [README](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/durable/README.md) 明确 current public API 是 durable record contracts 和 detached MemoryStorage。固定 main 图中 src 只有 `index.ts/types.ts/memory-storage.ts` 三文件。[handoff](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/durable/docs/pico-v5-handoff.md) 把 scheduler、SQLite/JSONL publication、task recovery 列在后续实现序列；其中“尚无 Pico5 implementation”状态落后于已存在的内存存储，故不能不加区别引用该句。结论应是“有耐久架构方向，尚不能直接依赖它交付完整耐久任务系统”。

## 云沙箱接入的准确挂点

`CreateAgentSessionOptions.tools` 在 v0.86.1 是 **工具名字 allowlist**；具体定义传 `customTools: ToolDefinition[]`。不要照旧例子传 `tools: AgentTool[]`。`customTools` 同名覆盖 builtin，源码见 [`_refreshToolRegistry:2835`](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/coding-agent/src/core/agent-session.ts#L2835)。

官方 public exports 提供以下工厂，可直接构造 remote 定义，不必 fork：

| 工厂 | `operations` 契约 |
|---|---|
| `createReadToolDefinition(cwd, {operations})` | `readFile(path): Promise<Buffer>`、`access(path): Promise<void>`、可选 `detectImageMimeType` |
| `createWriteToolDefinition(cwd, {operations})` | `writeFile(path, content)`、`mkdir(dir)` |
| `createEditToolDefinition(cwd, {operations})` | `readFile`、`writeFile`、`access`；复用精确替换、diff/patch、同文件 mutation queue |
| `createBashToolDefinition(cwd, {operations})` | `exec(command,cwd,{onData,signal,timeout,env}): Promise<{exitCode: number|null}>` |

固定稳定版源码：[read](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/tools/read.ts)、[write](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/tools/write.ts)、[edit](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/tools/edit.ts)、[bash](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/tools/bash.ts)。接口在 [extensions 文档 Remote Execution](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/extensions.md#remote-execution) 有正式用法。

推荐组装形状（示意，未运行）：

```ts
const remoteTools = [
  createReadToolDefinition(workspacePath, { operations: remoteRead }),
  createWriteToolDefinition(workspacePath, { operations: remoteWrite }),
  createEditToolDefinition(workspacePath, { operations: remoteEdit }),
  createBashToolDefinition(workspacePath, {
    operations: remoteBash,
    exposeSessionEnvironment: false,
  }),
  previewTool,
  verifyTool,
];
const { session } = await createAgentSession({
  cwd: workspacePath,
  agentDir: isolatedAgentDir,
  modelRuntime,
  resourceLoader: controlledResourceLoader,
  tools: remoteTools.map(t => t.name),
  customTools: remoteTools,
  sessionManager,
  settingsManager,
});
```

`DefaultResourceLoader` 支持 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`，可再由受控 inline factories 注入。不要自动扫描用户仓库和宿主的任意 `.pi` 插件。每个 session 配独立目录和设置，沙箱路径需由 adapter 映射；同一宿主多个 session 不要都把同一 `/workspace` 当共享文件锁标识。

不要把传 `cwd` 当沙箱，真正的 read/write/exec 应由 cloud sandbox SDK 执行。Bash adapter 需要实现 `signal` 取消、timeout、onData 流、非零 exitCode，不把宿主 `env` 原样转发；仅传白名单环境变量。预览服务从沙箱单独开放端口。

更细的边界：换 remote Ops 只替换工具 I/O，SDK 仍可做本地配置和会话 I/O。[read path resolver](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/tools/path-utils.ts#L86) 会探测本地候选路径，然后仍返回解析后的路径；[OutputAccumulator](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/tools/output-accumulator.ts) 会把超大 bash 输出落本地 tmp。应处理日志工件地址映射，避免模型得到宿主 tmp 路径后要求远端 read 一个不存在的文件。可在 remote bash adapter 内截断并存沙箱/对象存储，或用自定义 `exec` 工具定义彻底控制输出路径。

## SDK 还是 agent-core + 六工具

**本次优先 coding-agent SDK。** SDK 难点集中在 remote adapter 与资源隔离，是明确的适配工作；而只用 agent-core 会要求自行实现 session persistence/resume、compaction、coding prompt、可靠 edit 与文件跟踪、重试及产品事件映射。它更薄，但总体开发量通常更大。对短时间交付的判断是工程推断，未做开发时间实验。

只有已有文件工具、任务数据库和上下文策略，或者将 Demo 严格限制在单文件/很短上下文、不需要连续维护时，`pi-agent-core + 自定义工具` 才可能更简单。并非“core 比 SDK 更稳”。也可保持统一 `AgentRunner` 接口，以后替换具体实现，不提前造抽象平台。

可以控制为四个 coding 工具加 `preview/verify`；build 与 verify 优先让产品服务确定性执行，把失败日志回送 agent 自动修复，设最大修复次数与运行预算。需要持续 dev server 时由 SandboxManager 管理进程和端口，Pi 官方默认没有 background bash 产品能力。

## 最小闭环与差异化

最小链路：需求→简短可确认规格→生成/增量修改→真实构建→可交互预览→刷新后保留→在线版本链接。产品至少独立存 `Project/Run/Version/Check`，Pi session entry id 作为追踪信息，不替代这些实体。每次成功版本绑定源文件快照、模型/provider、构建结果、截图/验收结果。

更有价值的创新是在“可靠交付”上显性化：用户提出“加一个筛选按钮”，系统生成一张可点选的变更卡，显示页面差异、行为验收和可回退版本；只有真实点击、控制台/网络错误检查通过，才标记可用。这是 Pi 的工具与事件之上的产品设计，不应归功于 Pi 自带。

长期演进优先顺序：沙箱/产物稳定保存→执行预算/取消/重连→版本与验收证据→发布权限与回滚→耐久任务恢复→并行代理。多代理仅在收益可测且写入冲突有明确策略时引入。
