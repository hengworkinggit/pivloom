# ADR：Atoms 长期 coding runtime、远程工作区与持久任务

日期：2026-09-21。范围已改为完整产品建设，**不再按 6–8 小时笔试 Demo 优化**。本 ADR 是拟采用的实现方案，SDK 能力与我们需实现的服务明确分开；尚未运行 Pi→E2B→恢复的端到端集成，不代表上线就绪。

## 1. 决策

**主 runtime 采用 `@earendil-works/pi-coding-agent@0.86.1`；Pi 在可信 Node worker 内运行，通过自定义工具访问 E2B。任务调度选 BullMQ 6.3.8 + Valkey 9.1.2，Postgres 保存业务真相、事件及检查点；不同时引入 Temporal。** 保留一个薄 `CodingRuntime` adapter，第一版只实现 Pi。DSH/Codex 是未来可评测替换的 backend，不嵌套在 Pi 内；AI SDK 可供 UI 组件/流协议适配使用，不再起第二个 coding loop。

完整应用以**可持续编辑的多文件 Git 工作区**为产物，默认生成 React + Vite + TypeScript + Supabase 模板；Builder 自身用 Next；API/SSE/WebSocket 网关用独立 Fastify 服务，长任务由常驻 worker承担，不放入短生命周期HTTP函数。后续为 SEO/SSR 场景提供独立 Next + Supabase 模板。Fragments 的单文件 schema 不适合作为长期主生成协议。

选择 Pi 的依据是产品控制权、多模型、TypeScript 自定义远程工具、现成 coding session/compaction 的组合，而非“模型效果必然超过 Codex”。尚无同题质量、成本、成功率实测。

## 2. 候选比较与版本

| 候选 | 已核实强项 | 与本产品关键差距 | 决定 |
|---|---|---|---|
| Pi coding-agent SDK | 多模型、read/write/edit/bash、自定义同名覆盖、事件、会话树、恢复、压缩；不用 fork loop | 无完整 SaaS 队列/副作用事务/租户隔离/应用版本与部署；默认工具仍是本机 I/O | **主 runtime**；补产品服务与远程 Ops |
| DeepSeek Harness | Cordis 可组合能力、append-only SessionEvent、多 agent/provider、TS/Python SDK；已复用 Pi AI | 当前 developer preview；SDK wire 缺少 cancel/session-close、server→client 交互审批；`run`等待会话树 idle 的归属边界需适配 | 借鉴 durable/live events 分离与能力接口，不安装第二套 loop |
| Codex | 完整 coding harness、Thread/Turn/Item、中断/恢复/多 agent 原语；开源 Rust + TS SDK | TS SDK启动本机 `codex exec`，不能直接套 Pi 的 remote Ops；进程/持久卷/云运行二进制是另一套集成。app-server 官方仍有 experimental/production 限制 | 保留以后 A/B 候选；不 fork Rust，不把 Desktop 云能力当开源自带 |
| AI SDK | 当前 ToolLoopAgent 多步工具调用、模型适配、流式 UI、stopWhen/prepareStep、审批与实验 sandbox上下文 | 它也能做 coding agent，但可靠编辑/项目会话/压缩恢复/文件工具仍要自行组装；不是只有单次streamObject | 不再作为主 coding loop；需要时单独用于非coding一次性结构化调用或UI适配 |

固定版本证据：

- Pi `v0.86.1` → `13cbf77df2396303013a41646bcfa77b4271ae56`，MIT，包要求 Node ≥22.19；建议 worker 统一 Node 24 LTS 并通过集成验证。[release](https://github.com/earendil-works/pi/releases/tag/v0.86.1)、[package](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/package.json)、[LICENSE](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/LICENSE)
- DSH `dsh-v0.1.6-alpha.2` → `ddefc45fbc7f8e46dd73185e68295696d1297887`，MIT；没有非 prerelease latest（GitHub latest API 404，releases 列表能读到 alpha）。[SDK协议限制](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/protocol/README.md#known-limitations-and-deferred-work)
- Codex当前稳定 `rust-v0.155.1` → `be2951ea34f0d295ed0becf97079f92fa5f6950e`，Apache-2.0；前次精读 main为 `48f897e4ce94152818ce0563b3a8aac3a70ce9b8`，不声称两者全部 API 相同。[release](https://github.com/openai/codex/releases/tag/rust-v0.155.1)、[固定TS SDK源码](https://github.com/openai/codex/blob/48f897e4ce94152818ce0563b3a8aac3a70ce9b8/sdk/typescript/src/thread.ts#L70)、[app-server](https://learn.chatgpt.com/docs/app-server)
- AI SDK稳定 `ai@7.0.107` → `08ae5ad05bc12496dd1ffcf64e34419e0831300d`，Apache-2.0（GitHub仓库API显示NOASSERTION，已读实际LICENSE，不沿用推断）。当前 v7 的API不能照 v5/v6 starter示例直接抄。[LICENSE](https://github.com/vercel/ai/blob/08ae5ad05bc12496dd1ffcf64e34419e0831300d/LICENSE)、[ToolLoopAgent](https://ai-sdk.dev/docs/agents/building-agents)、[loop control](https://ai-sdk.dev/docs/agents/loop-control)
- `e2b@2.51.0` → `ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b`，SDK Apache-2.0；云服务费用、限制独立于SDK许可证。[release](https://github.com/e2b-dev/E2B/releases/tag/e2b%402.51.0)
- BullMQ `v6.3.8` → `48a550b39ce29f69e398dde6e3ce3c62c873b723`，MIT；Valkey `9.1.2` → `7f1dffedff6de73058b2c2a389422b6ecd56c8fb`，BSD-3-Clause；官方 GLIDE latest `v2.5.2`，Apache-2.0。安装时锁定实际npm版本、lockfile和镜像digest，不能把latest标签当不可变供应链。[BullMQ release](https://github.com/taskforcesh/bullmq/releases/tag/v6.3.8)、[Valkey release](https://github.com/valkey-io/valkey/releases/tag/9.1.2)、[GLIDE release](https://github.com/valkey-io/valkey-glide/releases/tag/v2.5.2)

## 3. 运行拓扑与职责

```text
Builder Web（Next）
  → Fastify API/Gateway：身份/项目权限/提交Run/显式取消/SSE及WebSocket代理
  → Postgres transaction：Run + 输入 + Outbox
  → Outbox publisher → BullMQ / Valkey
  → trusted Node worker（Pi session + model keys + 工具网关）
       → E2B adapter → 单项目/尝试的Linux工作区、依赖、构建、dev server
       → Browser verifier（复用产品选定browser工具层）
       → ArtifactStore：Git/source manifest/checkpoint/screenshots/logs
       → controlled deployment/backend provisioner
  → durable RunEvents + SSE → Web（断线不停止worker）
```

Pi 是推理/工具循环；RunCoordinator 是产品阶段状态机；BullMQ 是投递/重试/并发调度。三个角色不重复负责“决定下一次工具调用”。模型可提出计划、代码修改、检查动作；最终 `ready/published` 状态由真实检查/部署回执推进。

**信任边界**：只有可信 worker/model gateway 持模型API key。E2B中的生成代码、依赖安装脚本、bash和浏览器脚本都视为不可信。它们不能继承 worker 的环境变量、全局 Supabase service-role、云平台token、GitHub token或发布凭据。远程工具仅发送明确白名单env；项目特权后端操作走受控服务代理或严格项目范围短时能力。不要把 Pi 与任意生成代码放在同一进程，亦不要把“cwd=/workspace”当隔离。

## 4. 多角色协作：统一 runtime，分离上下文

采用固定角色契约而非几个持续聊天的“人格窗口”：

- Coordinator/PM：生成 `ProjectSpec`、任务依赖与验收标准；产品服务验证schema、建立Stage/Task。
- Designer：产出设计约束/资产引用/页面结构。可使用无写代码权限的独立Pi session。
- Builder：唯一负责主工作区改动的Pi session，工具可多次 read/edit/write/exec，多文件不限数量；生成或修改真实项目，不输出一个巨大JSON字符串作为全部代码。
- Reviewer/QA：独立上下文读取候选版本、构建结果和浏览器证据；不能直接写主分支。模型视觉判断配合确定性行为断言，最终报告结构化。
- Deployer：确定性产品服务为主，根据版本工件执行发布、记录deploymentId；不是让模型随意shell拿全局密钥。

每个专用agent都是**同一种 Pi adapter 的独立调用/session**，有自己的预算、输入工件、输出schema、role和parentRunId。产品阶段DAG决定何时运行及合并，不套 DSH workflow→Pi→Codex 三层agent loop。协作可以表现为用户可见角色消息，但必须来自真实任务和输出。

允许并行的是需求研究/设计建议/只读审查。初期项目采用单写租约；确需并行coding时，各agent从相同baseVersion创建隔离branch/sandbox，只交付patch/commit，集成者串行合并并重新验收。不可让多个独立Pi会话同时直接写同一E2B工作目录。深度、并发数、总token/金额预算在父任务分配；子任务预算之和受父预算控制。

## 5. Pi 的具体复用点与远程工具

已核实 `createAgentSession` 组装 Agent/AgentSession/SessionManager/ResourceLoader；`tools` 在0.86.1是**名字allowlist**，`customTools`接定义，同名可覆盖内置。直接复用coding SDK的prompt、流、编辑语义与compaction，不fork loop。[SDK](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/sdk.md)

| 复用对象 | 挂点 | 我们实现 |
|---|---|---|
| `createReadToolDefinition` | `operations.readFile/access/detectImageMimeType?` | E2B文件读、受限路径映射 |
| `createWriteToolDefinition` | `operations.writeFile/mkdir` | E2B写入、内容hash、文件变更记录 |
| `createEditToolDefinition` | `operations.readFile/writeFile/access` | E2B读改写，沿用精确替换/diff与同文件mutation queue |
| `createBashToolDefinition` | `operations.exec(command,cwd,{onData,signal,timeout,env})` | E2B命令句柄、输出流、超时、PID/进程组取消与日志工件 |
| SessionManager | `create/open/inMemory(cwd,{id},entries)` | sessionId和checkpoint关联、外部entries保存恢复 |
| `session.subscribe` | UI事件观察 | 产品事件投影；不当事务屏障 |
| `session.agent.subscribe` | 底层可await的Agent事件监听 | 如需执行阶段屏障，必须使用此类可await挂点及工具wrapper，并做验证 |

[Remote Execution官方用法](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/extensions.md#remote-execution)、[四工具稳定源码目录](https://github.com/earendil-works/pi/tree/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/tools)。

read/write/edit路径只允许项目root；处理`..`、绝对路径、symlink逃逸。文件搜索/目录/诊断也必须远端实现，不误启用本机默认工具。大bash输出需要截断+远端/对象存储工件地址，Pi默认OutputAccumulator可能落宿主tmp。`DefaultResourceLoader`关闭自动扫描的extensions/skills/contextFiles，只注入我们受控资源；每session独立本地目录。模型调用catalog/auth也设deadline，不能无界等待。

E2B为工作环境，**Git快照/对象存储才是项目持久真相**。当前官方E2B支持pause/resume（包含内存与文件系统）、connect到运行/暂停实例、单独命令句柄及kill；暂停会断开外部连接，恢复需重连。公开预览URL不是永久部署。[lifecycle](https://docs.e2b.dev/sandbox)、[persistence](https://docs.e2b.dev/sandbox/persistence)、[commands](https://docs.e2b.dev/commands)、[commands API](https://docs.e2b.dev/sdk-reference/js-sdk/v2.28.2/sandbox-commands)

注意最后一个API网页是带版本的2.28.2参考，2.51.0适配必须编译和实测确认，不能靠网页拼出未知函数签名。我们的`exec`契约稳定，底层E2B具体调用由adapter测试保护。

## 6. 持久化与恢复语义

至少分开保存四层：

1. **产品状态**：Project/Conversation/Run/RunAttempt/Stage，当前候选与已发布Version，cancelRequestedAt、budget、leaseOwner、fencingToken。
2. **Agent状态**：模型、thinking、SDK版本、Pi session entries、compaction记录；按`sessionId+entryId`去重。结构化Spec/架构决策/验收标准为独立工件，不只藏在compaction摘要。
3. **代码与环境**：Git commit/tree、模板/lockfile/源文件manifest、迁移清单、artifact hash；sandboxId和dev-server进程仅运行时引用。
4. **副作用账本**：ToolInvocation(runId,attemptId,toolCallId,argsHash,status,outputRef)，部署和数据库迁移各有幂等键/外部ID/回执；UsageLedger记录模型请求及费用。

会话恢复已有官方入口：`SessionManager.inMemory(cwd,{id: sessionId},entries)`，再`createAgentSession`。若采用文件模式，也可`SessionManager.open(path)`；不要在多用户服务调用`continueRecent`猜用户身份。[稳定SDK会话段](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/sdk.md#sessions)

**检查点是我们新增的协议**：在安全边界保存Pi entries +代码快照+已完成tool ledger+budget+当前阶段，写完对象存储后事务提交Checkpoint row；最后切换checkpoint pointer。代码和会话必须来自同一边界。中途每个工具完成可先记账，不必每个token全量打包工作区。安全边界至少是完整工具批次/turn完成，部署前后独立checkpoint。事务提交失败不把候选版本标为ready。

恢复分三种：

- 页面刷新/SSE断线：worker继续跑，客户端携带lastEventId读`seq > cursor`重放，随后接实时流。
- worker进程重启：读取RunAttempt和最新检查点；确认/隔离旧执行进程，恢复已完成状态，再用恢复说明和当前工作区继续。**不是恢复到V8任意指令，也不是重播所有shell命令。**
- sandbox被kill或不可用：从已持久化Git/manifest新建E2B模板，安装锁定依赖，恢复工作区并重启preview；业务数据独立在生成应用Supabase后端，不依赖sandbox磁盘。

未完成工具分类型reconcile：读取/构建可安全重试；文件写入比对目标hash；发布先查deploymentId/幂等键；DB迁移查migration版本/回执；无法判定的外部副作用进入`needs_attention`，不自动盲重放。队列至少一次执行，不能宣传exactly-once。新attempt取得更高fencingToken；旧worker不能提交版本。对已发出的远端shell，仅数据库fencing无法撤销副作用，因此接管时kill/隔离旧sandbox，或确认命令停止后再恢复，避免双写。

**重要源码细节**：`AgentSession._emit`同步遍历listener并不await；`Agent.subscribe`明确接收Promise，官方说明按注册顺序await。普通`session.subscribe(async()=>db.insert())`不保证写库先于后续tool；UI投影可用它，关键日志用受控await屏障/工具wrapper。[session `_emit`](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/coding-agent/src/core/agent-session.ts#L626)、[Agent subscribe](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/agent/src/agent.ts#L265)、[事件顺序文档](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/agent/README.md)。

`pi-durable`当前只有公开记录契约和MemoryStorage方向，不能替代上述产品持久任务服务。[README](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/durable/README.md)

## 7. 队列、取消、事件与预算

**BullMQ + Valkey**：固定BullMQ6.3.8官方docs已有`createValkeyGlideClient`，不是把Redis兼容性当猜测；GLIDE adapter PR已合并。选择Valkey9.1.2，队列实例独立于可淘汰缓存，`maxmemory-policy=noeviction`，设置持久化/备份/资源报警；Postgres outbox保证API提交的Run能重新投递。按运行队列和检查/发布队列区分并发、优先级与资源预算，不为每个token创建job。[固定connections](https://github.com/taskforcesh/bullmq/blob/48a550b39ce29f69e398dde6e3ce3c62c873b723/docs/gitbook/guide/connections.md)、[合并PR](https://github.com/taskforcesh/bullmq/pull/4321)、[Valkey许可](https://github.com/valkey-io/valkey/blob/7f1dffedff6de73058b2c2a389422b6ecd56c8fb/COPYING)

BullMQ丢锁/worker崩溃会使job重新待执行；应用仍需幂等与checkpoint。worker不做本地CPU重活，构建在E2B。graceful shutdown先停止领取、设关闭deadline，再abort/记检查点；`worker.close()`自身没有超时。官方v6有worker-local `cancelJob()`及processor AbortSignal，跨进程API仍需Postgres取消标记+控制通知找到owner。[stalled/graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown)、[idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)、[cancellation](https://docs.bullmq.io/guide/workers/cancelling-jobs)

取消流程：API先持久`cancel_requested`→通知owner→`session.abort()`→remote adapter终止本run命令/浏览器动作→等待settle并flush→标记cancelled。外部动作不会因AbortSignal自动撤销；需要远端kill和回执。取消清理超时标`cancelling/needs_attention`并隔离执行环境，不提前显示已停止；用户取消不得走普通重试重新运行。停止当前run通常保留可用preview；不默认kill整个项目环境。

`session.abort()`源码会abort重试/compaction/branch摘要/Agent，再waitForIdle；挂住的自定义工具仍要求我们遵守signal/timeout。[源码](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/coding-agent/src/core/agent-session.ts#L1786)

事件采用统一信封：`eventId/runId/attemptId/seq/parentRunId/type/at/payload/schemaVersion`。映射Pi事件到`stage.started/message.delta/tool.started/tool.output/file.changed/check.completed/version.created/run.completed`。token/stdout高频流批量缓存，终态消息、工具结果、版本、检查必须持久并可重放；seq唯一键防重复。不要把模型内部reasoning作为必展示产品内容。

费用按唯一model request/tool call记录`provider/model/input/output/cacheRead/cacheWrite/pricingVersion/estimatedCost`，包括compaction、设计/QA子任务、失败重试，不重复计算session总量。`getSessionStats`已覆盖普通assistant、tool usage、compaction/branch usage，但它是session聚合统计，不能直接当一笔run账单。[源码](https://github.com/earendil-works/pi/blob/c7cdb460aa8a0cebef3446c4166729b8a0d97ead/packages/coding-agent/src/core/agent-session.ts#L3506)

预算在每个模型/工具/子任务前检查：总美元软硬上限、最大turn/tool数、wall-clock、沙箱CPU/磁盘/时长、最大修复轮数。token费用可因供应商迟报而有误差，预留余量、限制单次输出，并最终对账；不能承诺绝对无超额。模型路由先固定默认强coding模型、较便宜的只读总结模型；用任务评测决定切换，不把动态路由当已证实节费。

**暂不选Temporal**：目前明确阶段+checkpoint+受控side effects可由上述栈完成。Temporal在跨天等待、复杂补偿/跨服务业务工作流明显增多时更有价值；即使用它，Activity仍可能重复执行，仍需副作用幂等，不会自动恢复Pi循环中所有工具现场。若将来迁移，是替换RunCoordinator持久调度而非再包一层模型loop。[Temporal官方Activity语义](https://docs.temporal.io/activity-definition)

## 8. 核心接口示意（这是我们设计的接口，不是Pi/E2B已存在API）

```ts
interface CodingRuntime {
  execute(input: {
    runId: string; attemptId: string; role: AgentRole;
    checkpoint?: CheckpointRef; workspace: WorkspaceRef;
    specRef: ArtifactRef; budget: RunBudget;
  }, context: {
    signal: AbortSignal;
    emit: (event: ProductEvent) => Promise<void>;
    tools: ScopedToolRegistry;
  }): Promise<RunOutcome>;
}
interface WorkspacePort {
  read(path: string): Promise<Uint8Array>;
  write(path: string, value: Uint8Array, expectedHash?: string): Promise<FileRevision>;
  exec(request: ExecRequest, signal: AbortSignal): AsyncIterable<ExecEvent>;
  snapshot(boundary: string): Promise<SourceSnapshot>;
  // preview进程由SandboxManager管理，不假装bash自动提供持久服务
}
interface CheckpointStore {
  load(ref: CheckpointRef): Promise<Checkpoint>;
  commit(input: {
    runId: string; attemptId: string; fencingToken: number;
    sessionEntriesRef: ArtifactRef; source: SourceSnapshot;
    completedTools: string[]; stage: string; usage: UsageCursor;
  }): Promise<CheckpointRef>;
}
```

Pi adapter只负责：载入`SessionManager`→构造受控resourceLoader/modelRuntime→四远程工具及产品工具→`createAgentSession`→订阅并投影→`session.prompt`→取消/settle→检查点。工具外包一层`ledger + scope + budget + deadline + result normalization`。多角色返回工件，而不是传递整个历史和无限复制token。

建议落地包：`apps/web`、`apps/api`、`apps/worker`、`packages/runtime-pi`、`packages/workspaces-e2b`、`packages/run-store`、`packages/project-artifacts`、`packages/product-events`、`packages/templates`。这是边界划分，可先同repo少数包实现，不提前做插件市场/微服务集群。

## 9. 默认模板与多文件生成策略

推荐默认 **Vite + React + TypeScript + router + Tailwind/shadcn + Supabase**，真实目录至少：

```text
src/pages/  src/components/  src/features/  src/lib/
src/lib/supabase.ts  src/types/database.ts
supabase/migrations/  supabase/functions/
public/  package.json  lockfile  tests/
```

其优势是Web应用前端与托管数据能力边界明确、Vite HMR与React元素tagger容易接入、静态构建工件便于预览/版本/部署。同样能有登录、表单、数据表、上传、实时数据和服务器函数，不能把SPA等同只能静态展示。[Supabase官方React+Vite教程](https://supabase.com/docs/guides/getting-started/tutorials/with-react)

服务端密钥、支付/webhook、第三方API放生成应用的Edge Functions或专门后端；浏览器只拿项目URL/public key，所有业务表与Storage policy显式生成并验收RLS，不能因为教程有示例就假定任意新建表默认安全。Builder控制面Supabase project与生成应用backend不同，代码回滚不自动倒回数据库或业务数据。

Next模板针对SEO/SSR、服务端渲染/路由业务；不要声称Vite不能SSR，Vite官方也有SSR接口，但自己拼SSR会增加模板复杂度，所以选择现成Next模板更清楚。两个模板从创建时明确选择，后续迁移是显式任务。[Vite SSR](https://vite.dev/guide/ssr)

生成采用模板仓库→Plan/Spec→按文件工具增量修改→依赖变更受控→typecheck/build→启动preview→真实浏览器/业务检查→候选版本→发布。编辑器文件树、diff、用户手改、视觉定位改动均操作同一工作区版本；视觉tagger引用路径/行号只是定位提示，内容hash与AST/源码复核避免旧行号误改。Dyad Apache许可的独立React/Vite tagger可复用，不能顺带复制其`src/pro` FSL模块。[tagger](https://github.com/dyad-sh/dyad/tree/2fc642bc84513a87b99361a9b399634fffa3cdb4/packages/%40dyad-sh/react-vite-component-tagger)

## 10. Hard gaps 与上线前最小集成验证

以下是真实必须补齐的工程，不是SDK已有的承诺：

| 验证 | 通过标准 |
|---|---|
| Pi→E2B四工具 | 多文件创建、中文路径、精确edit、非零exit、stdout/stderr流；宿主文件不改变；大日志工件可读 |
| 多轮项目维护 | 生成含路由/组件/数据访问的应用→改一个功能→build+真实操作通过；未请求文件保持语义正确 |
| 真实取消 | 在模型流、长命令、浏览器动作、compaction分别停止；run不自动重试，子进程无残留，UI状态与回执一致 |
| 断线与重连 | 关闭页面/刷新不取消工作；重连事件不重复、不丢最终消息与文件版本 |
| crash恢复 | 在工具开始前、远端写后结果落库前、checkpoint指针提交前、部署回执前分别kill worker；不重复发布/迁移、不丢已确认版本 |
| 队列/Valkey故障 | producer/worker断网、锁丢失、重投递、Valkey重启；outbox可补投，fencing防旧worker提交，GLIDE阻塞连接/取消行为通过 |
| 沙箱丢失 | kill E2B后从manifest重建，多文件和依赖恢复，预览恢复，业务数据仍存在 |
| 多租户与凭据 | A不能读B项目/对象/预览；E2B环境无全局model/service-role/deploy tokens；恶意路径受限 |
| 预算 | 子agent+compaction+重试累计可追溯；超预算不继续开新模型/工具动作；费用与供应商账单抽样核对 |
| 版本与数据 | Git回退能重建对应UI；数据库迁移单独记录/审批/恢复策略，禁止默认回滚生产数据 |

建议先做这组spike再写完整角色协作UI。此前根侧agent-browser的本地画面/点击测试只证明浏览器层可运行，不替代这里的Pi/E2B/任务恢复验证。

## 11. 证据方法与限制

本轮读取已有专项研究，并使用agent-reach的gh/Exa后端核实官方最新文档/版本。Pi沿用`nano-atoms-pi-research`图，先search_graph/trace_path定位`createAgentSession`、`AgentSession.abort/subscribe/_emit/getSessionStats`、`SessionManager.open/inMemory`，再get_code_snippet；相关文件coverage无记录缺口。环境未提供codegraph，用codebase-memory-mcp的定点snippet代替。图固定main `c7cdb460...`，对比stable领先8个commit；本轮引用的会话/取消/事件相关差异仅图像处理变化，稳定SDK文档另外读过。没有深扫未建图的新代码，没有安装或运行新的框架，也没有公开或搜索私人题面。所有研发投入、架构适配成本与选型结论是工程判断，而不是已测性能结果。
