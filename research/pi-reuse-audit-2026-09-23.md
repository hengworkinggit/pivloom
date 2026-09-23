# Pi 复用审计：以官方 SDK 替代重复执行层

日期：2026-09-23。Pivloom 代码基线：`92ffbb940015a2ac9182c26d81d93dc45269d710`。本报告是技术方案输入，**没有修改业务代码、生产配置或数据库，也没有调用生产模型**。

## 1. 结论

继续直接使用 `@earendil-works/pi-coding-agent` 的进程内 SDK。Pivloom 已经使用官方 `createAgentSession` 和远程工具 `operations`，这部分方向正确。应该删减的是三角色重复的会话包装、手工上下文裁剪和并行维护两套工具声明；无需再叠加 LangChain/LangGraph，也无需把常驻 Fastify 改成 CLI/RPC 子进程架构。SDK 本身就是官方提供给 Node.js/TypeScript 宿主的集成入口。[官方 SDK 选择说明](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/sdk.md#rpc-mode-alternative)

Pi 已有可直接使用并有上游测试的：Agent 生命周期、取消及等待结束、流式消息/工具事件、瞬态模型错误重试、工具参数校验、远程文件操作接缝、工具图片回传、会话树和上下文压缩。Pi **不替代**平台的 PostgreSQL Run 事务、租户权限、沙箱销毁确认、不可变源码版本、Preview/发布和部署 SHA。把后者错误地交给 `SessionManager` 会重新制造一致性问题。

本次证据不止 README：已阅读固定提交的实现与测试，实际运行 **45 个上游离线测试全部通过**，另运行 **5 个已安装 SDK 离线探针全部通过**。这证明下述 SDK 接口和运行边界可复用，不代表当前 Pivloom 已修复，也不代表 Ark 模型已通过视觉能力验证。

## 2. 固定版本与许可证

| 对象 | 查到的事实 | 方案处理 |
|---|---|---|
| Pivloom 已安装依赖 | `pi-ai`、`pi-agent-core`、`pi-coding-agent` 均为 **0.86.1**；lockfile 与实际 `node_modules` 一致 | 当前改造先沿用三个精确版本，不使用浮动版本 |
| 0.86.1 官方源代码 | tag 对应 `13cbf77df2396303013a41646bcfa77b4271ae56` | 本文未另注明的源码/测试链接均固定到此提交 |
| 当前正式发布 | **0.87.1**，2026-09-22 发布；tag 对应 `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` | 可作为后续显式兼容迁移目标，不能无检查替换 |
| 调研时 main | `fde38ed7c2f64434beffc6c0ec3b9994cb89ae23`；不是本次依赖基线 | 不直接跟随 main |
| 许可证 | MIT，版权 `Copyright (c) 2025 Mario Zechner` | 直接依赖保留依赖许可证；复制实质代码/样例时保留版权和 MIT 文本，记录源提交和修改点 |

来源：[0.86.1](https://github.com/earendil-works/pi/tree/13cbf77df2396303013a41646bcfa77b4271ae56)、[0.87.1 发布](https://github.com/earendil-works/pi/releases/tag/v0.87.1)、[MIT LICENSE](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/LICENSE)、[本地锁文件](../package-lock.json)。

**不能直接升级的具体原因：**0.87.0 删除 `shouldStopAfterTurn`，改成 `finishTurn`；`SessionManager` 成为最终请求上下文的权威来源，直接赋值 `session.agent.state.messages` 不再改变后续历史；新增 `context_edit` 和 `context_with_system`。Pivloom 三角色均使用旧停止钩子，Reviewer 还手工重排请求上下文。若升级，按官方迁移示例转换停止钩子、审计上下文声明与错误/取消分支，跑完本报告的兼容测试后再换生产版本。[coding-agent breaking changes](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/coding-agent/CHANGELOG.md#0870---2026-09-21)、[agent-core 完整迁移示例](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/agent/CHANGELOG.md#0870---2026-09-21)

0.87.0 确实修正了 context 扩展裁剪后丢失 system/tool 声明的问题，也增加了按模型配置图片尺寸的能力。不能将“固定旧版”理解为这些改进永远不用；它们应作为**一次明确的 SDK 升级任务**，而不是同时引入新框架。[对应官方变更](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/coding-agent/CHANGELOG.md#0870---2026-09-21)

## 3. 可以直接用/复制的清单

| 目标 | 官方实现/样例 | Pivloom 的具体动作 |
|---|---|---|
| 创建隔离的角色会话 | `createAgentSession`；[12-full-control.ts:28–74](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/examples/sdk/12-full-control.ts#L28) | 以该样例统一角色初始化。保留显式 resource loader、独立 credential store、工具白名单；不重新实现 agent loop |
| 完整运行结束 | `await session.prompt()`、`session.waitForIdle()`、`agent_settled`；[agent-session.ts:662–671](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L662) | 以原生结束边界为准，`agent_end` 不直接代表角色完成 |
| 取消和停止重试 | `await session.abort()`；[agent-session.ts:1756–1775](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L1756) | 三角色共用一次 signal→abort 桥接；等待完成后再 dispose。业务取消原因、数据库终态和沙箱清理另行处理 |
| 自动重试 | `SettingsManager.inMemory({retry: ...})`；[agent-session.ts:2986–3093](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L2986) | 直接使用 Pi 的错误分类、可取消退避、retry 事件。不要再套一层按所有异常重试的循环 |
| 远程 read/write/edit/bash | 官方 tool factories 的 `operations`；[ssh.ts:45–123](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/examples/extensions/ssh.ts#L45) | 保留现有 OpenSandbox 实现，复用 Pi 工具 schema、编辑 diff/patch、输出裁剪及执行机制；只写远端传输接缝 |
| 工具参数和兼容 | `ToolDefinition.parameters`、`prepareArguments`；[types.ts:452–489](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/extensions/types.ts#L452) | 使用同一份工具声明；必要的 GLM 参数兼容放到原生 prepareArguments。域约束如行为 ID、revision、owner 仍由平台检查 |
| 截图给 Reviewer 模型 | 官方 `screenshotTool`；[agent-session-tool-result-images.test.ts:13–24](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/test/suite/agent-session-tool-result-images.test.ts#L13) | 按样例直接返回 `ImageContent`，同时保留 artifact 元信息；不把 artifact ID 当视觉输入 |
| 会话持久化与恢复 | `SessionManager.create/open/inMemory`；[11-sessions.ts](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/examples/sdk/11-sessions.ts) | 若需要保存原始 Agent transcript，直接使用官方格式。平台项目/版本/Run 仍由现有 PostgreSQL 数据层保存 |
| 长会话上下文 | 官方 compaction 和 context 扩展；[compaction.md:25–47](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/compaction.md#L25) | 用官方压缩机制替代 Reviewer 固定只保留最后两轮的手工拼接；保留按 ID 读取完整检查证据的领域工具 |
| 故障/并发测试夹具 | 官方 `registerFauxProvider` 与 [suite/harness.ts](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/test/suite/harness.ts) | 复制上游 fixture 模式模拟 retry、abort、image、tool ordering；将这类离线兼容测试与真实模型 E2E 分开报告 |

“直接复制”以 API/测试夹具和必要样例为单位，不复制整套 CLI。`ssh.ts` 是执行接缝的官方例子，不是托管多租户安全实现；不要原样复制它的字符串替换路径、shell 字符串拼接或把终止本地 SSH 进程视作远端资源已回收。Pivloom 的路径约束和远端停止确认有保留价值。

## 4. 生命周期：哪些边界 Pi 已经解决

### 4.1 正常、重试、取消必须区分

离线探针观察到一次瞬态错误后的事件顺序：

```text
agent_end(willRetry=true)
auto_retry_start
auto_retry_end(success=true)
agent_end(willRetry=false)
agent_settled
session.prompt() 返回
```

因此不能在第一次 `agent_end` 时写入“已完成”或销毁工作区。Pi 官方测试还覆盖重试成功后继续执行工具、延迟 message_end 处理后才返回，以及 tool call/result 顺序。[retry 测试:138–190、250–335](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/test/agent-session-retry.test.ts#L138)、[事件顺序回归](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/test/suite/regressions/1717-2113-agent-session-event-settlement.test.ts#L29)

`abort()` 会取消当前 retry、compaction、branch summary 和 Agent，随后等待 `waitForIdle()`。`dispose()` 只是同步清理/中止入口，不是可等待的远端终止证明。先 await abort/原运行 promise，再解除订阅并 dispose；如果 provider 或远程 operations 不遵守 AbortSignal，SDK 不能凭空杀掉那端的工作。远端构建、浏览器、沙箱的停止仍要分别确认。[abort](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L1756)、[dispose](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L913)、[BashOperations signal](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/tools/bash.ts#L55)

### 4.2 现有重试解释有源码级错误

Pivloom [budgets.ts:63–72](../apps/api/src/runtime/budgets.ts#L63) 声称 Pi 重试计数跨整个 role 累积，所以提高到六次。**0.86.1 实现恰好相反：成功的 assistant 响应会立刻把 `_retryAttempt` 归零**。[官方 agent-session.ts:737–745](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L737)

方案必须改成：`maxRetries` 管一次连续错误链；平台 Run 截止和明确的停止原因管整个任务。重试策略需验证“失败→成功→下一轮再失败”的计数，而不是靠旧注释。保留 Provider transport `maxRetries: 0` 与 Pi session 重试分层的明确选择，避免重试次数乘起来；不重新引入用户已取消的累计 Token 限额。

### 4.3 不能删掉异步事件落库屏障

Pi `AgentSession.subscribe` 的 listener 返回类型是 void，`_emit` 直接逐个调用，不 await 返回的 Promise；Pi 自己保存 SessionManager 的消息顺序，并不等待 Pivloom 的 PostgreSQL/SSE 落库任务。[同步 emit:623–627](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L623)、[内部消息保存:706–745](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L706)

因此现有 `eventTail` 的需求真实存在，应合并成一个薄的脱敏持久化适配器，并在提交 role/Run 终态前 drain，落库失败必须被观察。不能因为采用官方事件就删除这一屏障，也不能把 `void emit(...).catch(() => {})` 当可靠落库。

## 5. 对现有三个角色逐项处理

| 现有位置 | 直接保留 | 合并/替换/删除 |
|---|---|---|
| [pi.ts:160–215](../apps/api/src/runtime/pi.ts#L160) `createServiceModel` | `ModelRuntime`、独立内存凭据、明确 endpoint/API、受控 BYOK fetch | 保留一份，不再给每个 role 实现独立 provider 客户端。核对模型真实能力，metadata 不等于探针验证 |
| [pi.ts:217–575](../apps/api/src/runtime/pi.ts#L217) `runBuilder` | 官方 read/write/edit/bash definitions 与远程 operations，源码路径边界，业务权限 | 角色重复的 loader/settings/session/subscribe/abort/result 提取收敛为共同 SDK 宿主；执行循环仍直接用 Pi。不能删除 OpenSandbox `destroy` 确认 |
| [coordinator.ts:96–316](../apps/api/src/runtime/coordinator.ts#L96) `runCoordinator` | 项目需求、澄清、计划 schema 和服务端交接事务 | 删除把“最多五项、仅保留一项旧行为”当充分验证的业务规则；它不是 Pi 限制。用官方 ToolDefinition/schema + prepareArguments，目标是删掉 providerContext 中另造一套出站工具声明；先用非法参数/纠错测试证明行为等价 |
| [reviewer.ts:128–498](../apps/api/src/runtime/reviewer.ts#L128) `runReviewer` | sealed handoff、revision/sourceHash、真实 browser observations、artifact、领域结果校验 | 截图改用官方 ImageContent；移除 DOM-only 假设和固定 last-two-turn 拼接，优先官方 compaction/context seam；生命周期与模型事件复用共同宿主 |
| 三者 `session.agent.streamFunction` | 需要 DNS 固定、凭据隔离、每请求观测的 transport 注入 | 统一一层 transport wrapper，只转发 request options/AbortSignal/usage；不要让 streamFunction 同时承担角色记忆重写、schema重写和业务决策 |
| `SessionManager.inMemory` | 每 RoleRun 独立会话，在 PostgreSQL 已是平台事实来源时合法 | 不能凭此宣称进程重启后 Agent 透明续跑；若将来保存 transcript，用官方格式并明确恢复边界，不额外发明并行会话树 |

这些改动是“减少重复并使用公开 API”，不是另造一个跨框架的 AgentRuntime 抽象。共同宿主只负责依赖装配、事件转存和停止桥接；项目状态和业务工具继续留在原有领域模块。

## 6. 会话树、文件快照和版本回滚不是一回事

### 官方 SessionManager 真实行为

`SessionManager.branch(id)` 只验证 entry 是否存在并修改 `leafId`，保留所有旧 entry；`AgentSession.navigateTree()` 重建该分支的消息和工具状态，可选择生成分支摘要。它没有恢复 Pivloom 生成文件、Preview、检查和发布目录的操作。[branch:1430–1441](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/session-manager.ts#L1430)、[navigateTree:3383–3447](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L3383)

本次探针：写入 `app.txt=v1`，保存 v1 对话，再写 `app.txt=v2` 和 v2 对话，branch 回 v1；上下文只剩 v1 分支，但文件仍是 **v2**，重新打开 JSONL 还能找到 v2 历史。这个行为正是会话分支设计，不能当作源码回滚成功。

SessionManager 官方持久化是 JSONL 本地文件，并在第一条 assistant 消息后 flush；不是现有 PostgreSQL 的事务适配器。平台必须在模型开始前先记录已接受的 Run，不能仅依赖 Pi 文件来承诺“所有失败都落库”。[持久化实现:1071–1105](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/session-manager.ts#L1071)

### 官方确实有 git-checkpoint 样例，但不满足本产品回滚

不能说 Pi 完全没有相关方案。官方 [git-checkpoint.ts](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/examples/extensions/git-checkpoint.ts#L10) 演示了 entry ID→Git stash checkpoint 的关联：

- 使用进程内 `Map`，不是持久化的产品版本记录。
- `turn_start` 调 `git stash create`，fork 时调 `git stash apply`。
- `ctx.hasUI` 为 false 就直接返回；headless 服务不会自动恢复。
- `agent_settled` 清空 checkpoints。
- 不处理 owner、accepted revision、Preview、版本号、部署或数据库事务。

因此只借鉴“对话位置必须关联一个可恢复源码快照”的数据关系，**不原样复制为 Pivloom rollback API**。Pivloom 已有不可变源码包，应继续复用其恢复构建能力；目标快照构建/标识检查成功后，再在平台事务中一起切 current revision、当前对话基线及操作状态。不要为了搬一个演示额外把全部源码存储迁到 Git。

`AgentSessionRuntime.switchSession/fork` 是替换整个会话运行环境的 API；同样不是源码事务。只有将来真正需要在一个 Pi 宿主中切 session/cwd 才采用。[13-session-runtime.ts](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/examples/sdk/13-session-runtime.ts)

## 7. Reviewer 视觉链路：直接使用 Pi 图片结果，不限制生成产品类型

官方可复用返回形状如下（`pngBytes` 必须是本次真实 browser screenshot，不能是文件名或 artifact ID）：

```ts
return {
  content: [
    { type: "text", text: JSON.stringify({ artifactId, observationId, revisionId }) },
    { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
  ],
  details: { artifactId, observationId, revisionId },
};
```

这是官方截图工具测试使用的 `ImageContent` 形式。Pi 的 `afterToolCall` 会调用 `normalizeToolResultImages` 处理工具图片，不需要平台重写一套图片归一化器。[官方 screenshotTool](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/test/suite/agent-session-tool-result-images.test.ts#L13)、[接入点:529–548](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts#L529)、[图片处理实现](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/utils/tool-result-images.ts#L22)

但仍有三道独立条件：

1. Pi 真正收到图片 content，`images.block` 没有阻断；当前 Pivloom 截图工具只给 artifact ID/hash，未满足此条件。[SDK blockImages 处理](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/sdk.ts#L269)
2. 当前实际 `model.input` 声明包含 `image`；OpenAI Completions 适配器只在该条件满足时附送 `image_url`。把 `supportsImages` 改为 true 是声明，不是证明。[provider adapter:1401–1448](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/src/api/openai-completions.ts#L1401)、[官方请求转换测试](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/test/openai-completions-tool-result-images.test.ts#L71)
3. **同一 provider/base URL/model 的真实端到端视觉探针**正确读出只在图像里、DOM/source/prompt 没有的随机信息。协议接受 HTTP 200 和 usage 有值不等于看懂图片。此项本轮没有调用生产模型，状态必须写未验证。

Canvas/贪吃蛇不能通过“强制生成 DOM 棋盘”规避。应保留普通 DOM 和 Canvas 生成的支持目标；借官方浏览器操作能力进行真实方向键、暂停、吃食、碰撞测试，再以图像+正常可见 HUD 观察。视觉模型不具备能力时，应明确让用户配置可用的 Reviewer 模型或将相关检查 blocked；不能读源码后假装完成了视觉验收。

## 8. 上下文、持久化与 SDK 路线选择

当前 Reviewer 把历史截成最后两个 assistant turn，再拼自己维护的 observation index。Pi 已有 compaction，知道不能在 toolResult 中间截断、会写 CompactionEntry、保留最近上下文。应先采用官方机制并实测长游戏检查，避免自行维持另一套 transcript 编排。[压缩触发/流程](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/compaction.md#L25)、[切分规则](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/compaction.md#L111)

这里仍要保留领域事实：每项待验收行为、已完成行为、完整 observation/artifact 可以通过工具重新读取，不靠压缩摘要判定通过。压缩会产生额外模型调用，也可能失败或被取消；必须纳入现有 deadline/usage/事件，而不是变成另一个累计 Token 停止条件。

对当前常驻 Fastify，进程内 SDK 能直接绑定每个 Run 的 BYOK fetch、远程 operations、request context 和类型。RPC 的价值是异语言/进程隔离；它在 Pi 内仍使用同一 AgentSession，改成 RPC 并不能自动修复平台数据库和资源生命周期，还会增加子进程退出、协议、凭据传入与流重连工作。[0.87.1 官方 SDK 定位](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/coding-agent/docs/sdk.md)

仓库内还有新的 durable/experimental server 方向，但当前上游 0.87 周期仍在加入存储后端与变更 API；本项目不能把“存在目录”当作成熟托管服务方案。现阶段不导入另一套 session backend、协调器或 durable store 来替代 Pivloom 已有的 PostgreSQL。[当前版本变更与实验入口](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/coding-agent/package.json)

## 9. 本轮实际执行的验证

### 上游原样测试：45/45

[已保存的运行证据摘要](upstream-pi-tests-2026-09-23.json)转录自实际工具输出，明确标注没有原始磁盘日志；[SDK探针原始JSON](upstream-pi-probe-2026-09-23.json)也已保存。

在 `/tmp/pivloom-pi-audit` 检出 `v0.86.1`，使用 Node **24.19.0**、本机 Vitest **4.1.11**，运行时设置 `PI_OFFLINE=1`。未修改被测源码或测试断言；上游缺省不带生成 model catalog，已从本机同版本 0.86.1 npm 包补齐生成 JSON，测试依赖复用已安装包。最初导入阶段缺生成数据/依赖的失败没有计作测试失败或业务缺陷。

```sh
# 在已配置好 v0.86.1 开发依赖与 model catalog 的 packages/coding-agent 下
PI_OFFLINE=1 npx vitest run \
  test/agent-session-retry.test.ts \
  test/agent-session-concurrent.test.ts \
  test/suite/agent-session-tool-result-images.test.ts \
  test/suite/regressions/1717-2113-agent-session-event-settlement.test.ts
# 4 files, 16 tests passed; 本次耗时 2.65s

PI_OFFLINE=1 npx vitest run test/suite/agent-session-compaction.test.ts
# 1 file, 29 tests passed; 本次耗时 2.19s
```

这些测试用 faux/mock streams，覆盖重试、并发 prompt/steer/followUp、异步内部事件顺序、图片归一化接入和压缩行为。没有把需要真实 API key 的 `agent-session-tree-navigation.test.ts` 算作通过，也没有把 stub assistant 当真实模型生成证据。

### 已安装 SDK 探针：5/5，networkCalls=0

| 探针 | 实际断言 |
|---|---|
| retry settlement | mock 连续错误一次后成功；两次 provider call；只有一次最终 `agent_settled`；prompt 返回时 `isIdle=true` |
| abort during tool | 原生工具 signal 收到 abort；`await session.abort()` 与原 prompt 均结束；session idle |
| image tool result | 实际 base64 PNG 出现在下一次模型 stream context 的 toolResult 中；没有调用任何视觉模型 |
| branch vs workspace | JSONL 历史仍保存 v2；回到 v1 的上下文只含 v1 用户消息；工作区文件保持 v2，证实不是源码回滚 |
| remote operations | 官方 `createWriteTool/createEditTool/createReadTool` 通过 Map-backed 远程 operations 完成写→改→读，读到改后内容 |

探针脚本与结果仅在本机研究目录：`/tmp/pivloom-pi-audit/reuse-probe.mjs`、`/tmp/pivloom-pi-audit/reuse-probe-results.json`。可复现的官方样例/测试已固定链接；临时探针不能替代后续仓库内的回归测试。

## 10. 必须进入 Pivloom E2E/回归方案的验收项

| 编号 | 必须验证 | 防止的误判 |
|---|---|---|
| PI-01 | 首次瞬态失败→成功→下一轮再次失败；记录原生 retry/settled 事件和请求计数 | 不再把每链重试次数错说成整个 role 次数；不在首次 agent_end 提前终态 |
| PI-02 | 模型流、远程工具、retry sleep、compaction 分别取消；无新请求；SDK idle；平台终态和远端清理分别可核对 | 不把同步 dispose、Promise.race 超时或本地 signal 当远端清理证明 |
| PI-03 | 串行工具与异步事件落库；一条事件写入失败；保证终态不领先于已确认事件、失败能对账 | Pi 内部顺序不等于 PostgreSQL 已写入 |
| PI-04 | 官方远程 read/write/edit/bash；非法路径拒绝；合法多 edits 原子应用；命令非零/取消正确返回 | 不重新实现编辑器；不把 signal killed 的 null exit code 当成功 |
| PI-05 | 一份工具 schema 的合法/非法/GLM兼容参数、Pi preflight 失败和领域失败；纠正后能继续 | 不以“本地很宽松、出站很严格”两套声明隐藏校验问题 |
| PI-06 | 标准 ImageContent→provider payload→同配置真实图片回答；另测 text-only/blocked images | screenshot 文件存在、artifact ID 或 HTTP200 不等于视觉验收 |
| PI-07 | 长 Reviewer 会话触发官方 compaction；工具声明、全部旧要求与完整证据可回读；取消/压缩失败分类 | 不因只留最后两轮而遗忘旧功能，不因压缩重新引入总 Token 上限 |
| PI-08 | SDK branch 探针与平台版本回滚分开；平台回滚核对文件哈希、current revision、Preview marker、对话基线 | 不把会话树切换声称为文件回滚 |
| PI-09 | 进程重启后平台 stale Run 收口、清理、重试；已持久化 transcript 可读取但不虚构透明续跑 | JSONL/InMemory 与真正持久任务恢复不能混同 |
| PI-10 | 若升级0.87.1，迁移 finishTurn + canonical context 后重跑PI-01至09及新计算器/Canvas贪吃蛇 | 升级后工具丢失、终止判断失效、历史分支漂移 |

新计算器、贪吃蛇、两轮增量、账号隔离、源码/Preview/版本/对话一致和部署 SHA 仍是整链 E2E 的验收范围。上面的 Pi 兼容测试帮助先排除底座用法错误，不能代替这五项技术复核要求。

## 11. 审计边界

- 先使用 `codebase-memory-mcp` 查询 Pivloom 与上游图；上游索引 `pivloom-pi-audit-0861` 为 fast 模式。其 tools/test 路径部分被 fast 规则排除，已按 coverage 提示读精确源码；未把图中没有节点当作功能不存在。
- `codegraph` 在本工作区没有索引，CLI 明确允许退回常规工具，因此针对图里定位的符号和文件读取源码。
- 以上均为官方仓库、发行包、固定 commit 源码和实际离线结果；未使用二手文章证明接口行为。
- `agent-reach check-update` 返回 v1.5.0 已是最新。本轮不安装新框架、不升级运行依赖、不恢复定时任务。
