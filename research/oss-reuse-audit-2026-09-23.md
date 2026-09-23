# Pivloom 复核：开源回滚与任务生命周期复用审计

日期：2026-09-23。Pivloom 核对基线：`92ffbb940015a2ac9182c26d81d93dc45269d710`。对照方案：[technical-recheck-v2](../docs/specs/technical-recheck-v2.md)。

本报告只审版本恢复、取消、超时/重试、终态持久化、清理，以及与 Preview 授权有关的可用模式。Pi 与浏览器工具的主调研另行覆盖。本轮实际读取了下列固定提交的实现和测试；**没有运行上游完整测试，没有在 Pivloom 移植代码或执行新的生产生成**。表中的 COPY/ADAPT 是实施决策，不是已实现声明。

## 1. 可直接下的决策

1. **不替换 Pi，也不把 OpenHands/OpenCode 整个运行时再套一层。** 三者的事件、会话、数据库和工作区生命周期各自完整；整套移植会产生第二个状态真相。用 Pi 负责模型循环和已有取消能力，用 Pivloom PostgreSQL 负责用户、Run、Revision、Check、资源与当前版本的事务一致性。
2. **版本恢复选 Dyad 的协调顺序和回归测试作为主要来源；源码存储仍用现有不可变版本快照。** Dyad 已把恢复拆成校验、阻止新写入、源码操作、对话操作、恢复检查点。可移植这一流程，不能照搬 Electron/Git/SQLite/Neon 实现，也不能把它“创建回退 commit”的语义说成 Pivloom 的 `v3 → v1` 指针切换。[实现][dyad-restore-message] [恢复检查点][dyad-reconcile]
3. **立即取消参考 OpenHands 的 `interrupt`，不能拿 `pause` 代替。** 先置取消标记，再中止当前异步任务；尚未结束的工具仍能读取取消状态。复用这个顺序与测试，但用 Pi/AbortSignal 实现，避免为取消问题引入 Python 服务。[实现][oh-interrupt] [测试][oh-interrupt-tests]
4. **终态事务参考 Dyad；不要再吞落库错误。** 终态写入、队列移除、暂停原因在一个事务中，写入失败恢复内存投影并抛出；恢复后不偷偷重新跑已受理工作。移植这些不变量到现有 PostgreSQL repository 即可，不必复制其 1,200 行队列持久化框架。[终态][dyad-terminal] [重启恢复][dyad-hydrate]
5. **可直接移植的小单元是取消按钮 latch，以及已有重试层缺少时的 Retry-After/退避计算。** 重试只能由一层负责；Pi 已有的能力优先用，禁止再把整轮生成包装成自动重试。[取消 latch][dyad-latch] [重试策略][oc-retry]
6. **没有找到可原样替代“PostgreSQL + OpenSandbox/gVisor + 私有 Preview + 已验收 Revision”的整套模块。** 这是这三份指定源码的适配结论，不是对 GitHub 所有项目的否定。项目仍需薄的 owner 校验、快照恢复、原子 current 切换与远端资源对账；必须清楚标注为适配代码，不宣称“上游已经替我们保证”。

## 2. 候选成熟度、固定版本与许可

Star 数和更新时间由 GitHub API 在本轮查询，只是维护活跃度的辅助证据。是否采用由实际模块、测试和架构兼容性决定。

| 候选 | 本轮 API stars / pushed_at (UTC) | 审计固定提交 | 许可与边界 |
|---|---|---|---|
| OpenCode | 209,559；2026-09-23 10:43:01 | `18ef3cc7c5a25b82114c953a80ccc09f4988f74e`；默认 dev 提交时间 04:38:22 | 根 MIT。所审 `packages/core`、`packages/opencode` 无另列限制；树中 `packages/ui`、`packages/http-recorder` 的 LICENSE 也是 MIT；`packages/docs/LICENSE` 为 Mintlify 的 MIT。复制保留相应版权与许可。 |
| OpenHands 主仓 / software-agent-sdk | 主仓 88,958；08:35:52。**SDK 单独 1,159**；09:42:14 | 主仓元数据/根许可：`431393cc047f9ce6de45e8f649af0c9071259b92`；实际 SDK 源码：`9e042d1f0bf7233b2a1a2bca4872625768eaac71`，提交时间05:39:46 | 两仓所查根 LICENSE 均 MIT；SDK 所查 Python 路径使用根 MIT，TypeScript client 另有 MIT LICENSE。不能把主仓 star 数当作新 SDK 的 star 数或可靠性证明。 |
| Dyad | 21,602；2026-09-23 05:47:06 | `0ffb5b7333264473e61b4773ce6e25001ebd06db`；提交时间05:47:05 | 根 LICENSE：`src/pro/` 以外 Apache-2.0；**`src/pro/` 是 FSL-1.1-ALv2，限制 competing use**，并非当前统一 Apache-2.0。根 NOTICE 还列依赖归属。 |

来源：[OpenCode API](https://api.github.com/repos/anomalyco/opencode)、[OpenHands API](https://api.github.com/repos/OpenHands/OpenHands)、[SDK API](https://api.github.com/repos/OpenHands/software-agent-sdk)、[Dyad API](https://api.github.com/repos/dyad-sh/dyad)；[OpenCode LICENSE][oc-license]、[OpenHands LICENSE][oh-main-license]、[SDK LICENSE][oh-license]、[Dyad LICENSE][dyad-license]、[Dyad Pro LICENSE][dyad-pro-license]、[Dyad NOTICE][dyad-notice]。

**Dyad 的实际选择：**只抽取 Apache-2.0 区域的指定单元及测试；不要为了依赖解析把 `src/pro/main/ipc/handlers/local_agent/` 复制进来。那里有 `retry_replay_utils.ts` 等看似正好有用的实现，但其许可不适合作为 Pivloom 通用开源底座。本轮明确拒绝该目录，避免先复制、再发现无法按预期公开发布。[目录许可][dyad-pro-license]

## 3. 精确复用清单

适配成本“低”指替换类型/import 和接入一个现有边界；“中”指必须改数据/异步/owner/错误语义；“高”指引入另一套运行时或存储真相。本报告不将估计换算成未经实测的工时。

| 能力 | 来源与具体模块 | 决策 | Pivloom 接入及不能照搬的部分 |
|---|---|---|---|
| Stop 点击后立即锁住重复点击，等服务器确认结束才解锁 | Dyad `src/components/chat/useCancellationRequestLatch.ts` 1–64 与同名测试 | **COPY，低** | 复制 hook 与三个交互用例；将 `chatId:number` 对应成 Run/项目 UUID；权威 `cancel_requested/terminal` 决定解除 latch。该 hook 只管 UI，不证明远端已终止。 |
| 回滚流程/恢复状态 | Dyad `src/version_preview/state.ts`、`transition.ts`，`version_preview_persistence.ts`、`version_preview_definition.ts` | **ADAPT，中** | 抽取 `requested target / applied target / fallback / recovery` 的区分、同项目最多一个变更、失败保留可恢复状态。删除本项目不需要的 detached HEAD、branch、录屏状态；I/O 改为读取历史源码并准备新沙箱，再事务切 current。 |
| 源码、当前对话一致 | Dyad `version_handlers.ts::restoreToMessageHandler` 1247–1822 | **ADAPT，中** | 借其先校验再变更、校验 chat→app 归属、恢复源码后才提交对话上下文、finally 释放 admission 的顺序。Pivloom 保留历史对话和版本，并记回滚事件；不复制它的新建 chat/复制所有消息算法。 |
| 终态、去重、重启恢复 | Dyad `src/chat_stream/persistence.ts::markIntentTerminal` 1026–1120 / `hydrateChatStreamPersistence` 173–296 | **ADAPT，中** | 映射到现有 Run 终态事务及恢复扫描：写库成功才移除执行责任；失败可关联/重试；重启不重放未确认完成的副作用。不要另加 Dyad 的 SQLite 队列表、全局内存 Map 和 IPC actor 总线。 |
| 取消顺序与迟到工具 | OpenHands SDK `LocalConversation.interrupt` 2705–2738；`arun` 2507–2576；`CancellationToken` | **ADAPT，低至中** | 使用现有 AbortController/Pi abort 接口。取消先可观察，再中止模型/工具；旧 run 的 signal 对迟到回调仍是 aborted，新 run 用新 signal。用户取消与 deadline/shutdown 保留不同原因。 |
| Provider 短暂故障退避 | OpenCode `packages/opencode/src/session/retry.ts::delay/exponential` 43–83、错误分类85–155、policy183–206 | **条件 COPY/ADAPT，低** | 只补 Pi 当前没有的行为；复用 Retry-After ms/秒/HTTP-date、指数退避、抖动及无效 header 测试。接入现有错误类型、取消和整体 deadline；不复制 Go 套餐付费 UI，也不把超长 Retry-After 原样等下去。 |
| 本地 Git snapshot/revert 引擎 | OpenCode `packages/core/src/snapshot.ts`、`session/revert.ts`；`packages/opencode/src/snapshot/index.ts`、`session/revert.ts` | **REJECT 整块，取测试** | 依赖本地 Git/worktree、Effect service、Session event/storage；Pivloom 已有 Supabase 源码快照。再放一个影子 Git 会增加同步点。上游测试中的新增/删除/修改/跨项目隔离值得移植。 |
| OpenHands `close` 资源清理 | `LocalConversation.close` 2764–2814 和 terminal cleanup 测试 | **ADAPT 不变量，不 COPY 实现** | 无论是否保留历史，都关闭执行资源；某个 executor 清理异常不能阻止其他资源清理。但上游这里会记录部分异常后标清理完成，不能用作我们“远端 gVisor 容器已销毁”的证据；仍需 OpenSandbox 删除确认与 pending 对账。 |
| OpenHands workspace Cookie | `auth_router.py`、`dependencies.py`、`test_workspace_cookie_auth.py` | **ADAPT 部分，拒绝整套** | 可参考预览专用 HttpOnly Cookie、匹配属性清除端点、普通 API 不接受该 Cookie。不能把它当成 Supabase 用户登录 session 绑定或即时撤销实现，详见第6节。 |

小单元复制时随代码保留上游仓库、固定 commit、原路径、适配说明；MIT 保留版权与许可，Apache-2.0 部分保留 LICENSE、适用 NOTICE 和修改说明。**不得通过 import 无意引入 Dyad Pro 源码**。

需与实现一起取走的测试入口：[Dyad latch 三个用例][dyad-latch-tests]、[版本转移的状态/事件全表和随机序列测试][dyad-transition-tests]、[恢复检查点持久化测试][dyad-checkpoint-tests]、[新增/修改/删除/移动后切回旧版本的 E2E][dyad-tree-tests]、[终态去重与进程恢复持久化测试][dyad-persistence-tests]、[OpenCode Retry-After/错误分类测试][oc-retry-tests]。版本状态类型与纯转移函数的直接来源为 [state.ts][dyad-state] 和 [transition.ts][dyad-transition]。

## 4. 为什么回滚不能直接拿 OpenCode 的 undo

OpenCode 的两个相关实现都围绕会话消息和本地文件树：`packages/opencode/src/session/revert.ts` 检查 session 非 busy、收集消息之后的 patch、保存当前 snapshot、执行 revert；其 `cleanup` 明确删除撤销点之后的消息/parts。新 core 的 `SessionRevert.stage` 则从 message boundary 规划要恢复的文件并发出事件。它们都不是“已验收应用版本 + Check + 多租户 Preview”的产品事务。[旧适配层][oc-revert] [core stage][oc-core-revert]

另一个容易忽略的细节：core Snapshot 的 `checkout` 说明是检出 tree 中的条目，**tree 中不存在的文件保持不变**；选择性 `restore` 才对指定路径做删除。因此不能把一次 checkout 成功当作“所有文件准确等于旧版本”。Pivloom 应从完整不可变 manifest 构建干净沙箱，而不是把旧文件覆盖到含新文件的工作目录。[Snapshot 接口][oc-core-snapshot]

可直接借用的是上游测试问题集：[snapshot tests][oc-snapshot-tests] 覆盖删除、新增、多文件、子目录、unicode、跨项目/工作树隔离和重复 patch 顺序；[snapshot-tool-race test][oc-snapshot-race] 用立即返回工具结果的假 LLM 检查真实文件已变化时 diff 不能是空。这不是模型生成真实性验收，而是确定性的快照时序回归。

**Dyad 更接近，但也不能整块复制。** 它实际把历史 tree 写成新的 revert commit，可能恢复 Neon 时间点、重部署 Supabase functions、另建 chat。其源码在本地源码恢复和 chat 更新之间保存 `nextStep=chat-mutation`；进程重启时核对真实 HEAD/branch/clean 状态，不能证明一致则进入 recovery-required。[源码操作与新 commit][dyad-revert-code] [chat 原子更新][dyad-chat-commit] [重启对账][dyad-reconcile]

对 Pivloom 的具体收敛：

- 保留旧计划的语义：当前 `v3 → v1`，不创建假新模型版本；历史 v2/v3 保留，下一次生成用新的递增 revisionNo。
- 固定目标 accepted Revision + sourceHash + 历史 Check；准备 Preview 成功且 marker 对上后，单个 PostgreSQL 事务改变 current、记录回滚事件和对话基线。准备失败保留旧 current。
- 持久化操作保存 `fromRevision / targetRevision / preparedBinding / phase / error`；沿用已有 repository/operation seam，状态由明确转移函数驱动，不增加通用 workflow 框架。
- 重启分别处理“沙箱创建后未绑定”“已准备未提交”“事务已提交但 HTTP 丢失”。重复请求应返回同一操作结果；不能仅凭本地 Promise 消失就解锁或显示成功。
- 回滚不自动更新已发布站点，不修改生成应用 localStorage；这两项是现有产品语义，不能随 Dyad 的数据库回滚能力扩大范围。

以上是对已有架构的有依据适配，不是声称上游已有 Pivloom 的数据库表或公有云部署逻辑。

## 5. 生命周期：能抄顺序与测试，不能抄掉故障

### 5.1 取消与终态

OpenHands `pause()` 文档明确：当前 LLM 调用结束后才暂停；`interrupt()` 先置 token，再取消异步 task。`arun` 把已中断动作补成错误观察，防止下一轮模型请求带有无 tool-result 的孤立 tool call；finally 保留已取消 token，防止线程/工具晚到时看见“取消状态消失”。这些是 Pi 包装层应遵守的边界，不能把 Python 代码原封不动换成 Node 就宣称处理完。[实现][oh-interrupt]

上游可移植的确定性测试包含：慢 LLM 被打断后在2秒测试窗口内返回；多次快速 interrupt；自然完成后 interrupt 不倒改结果；预先取消时跳过工具；取消后的迟到工具仍看到 token。[实际断言][oh-interrupt-tests] 注意：同文件名为 `test_interrupt_is_resumable` 的测试本体是两次自然完成，并未在中间调用 interrupt，**不能凭这个测试名声称“中断后恢复”已经充分验证**；Pivloom 要单独验证真实中断后的下一轮。

Dyad 的 UI/IPC 集成测试从真实 Cancel 按钮进入，检查数据库保留取消消息、页面显示 Cancelled、下一轮传给假 LLM 的上下文仍含取消标识。这种“UI → 后端 → DB → 下一轮上下文”的测试比只测 AbortController 更贴近此次复核。[集成测试][dyad-cancel-test] 但它依赖本地 Electron harness，Pivloom 应重用同样断言，改用 Web/API/PostgreSQL。

旧方案的 Builder cancelled 分支必须直接进入 `finishCancelled`；被取消的 candidate 不进入失败兜底。取消提交与成功 promotion 争用时，以数据库合法转移/CAS 结果确定唯一终态；UI 提前显示“正在停止”可以，但资源确认和终态落库前不谎报“已停止并释放”。

### 5.2 失败持久化与重启

Dyad `markIntentTerminal` 在事务里同时写终态、删除队列项、更新队列状态；事务抛错时还原之前的内存 record/aggregate 并继续抛错。`hydrateChatStreamPersistence` 恢复持久化队列时先暂停，claimed 重新入队，损坏 intent 隔离，避免重启后静默执行。[终态事务][dyad-terminal] [恢复扫描][dyad-hydrate] 这些代码是 SQLite/进程级 Map 组合，不能提供 Pivloom 多请求/多 owner PostgreSQL 的事务保证。

Pivloom 修订点：终态失败不能被 `.catch(() => {})` 消掉后从 tasks Map 删除；把“处理中的执行”“待持久化终态”“待清理资源”分清。数据库恢复后重试幂等终态/对账；不重新发送已执行过的模型与写文件调用来“补”状态。中断后重试产生新 Run，关联旧失败 Run，旧记录仍可读。

### 5.3 超时、Provider 重试和清理

OpenCode `session/retry.ts` 有明确 retryable 分类、Retry-After 和有限次数；无 header 退避上限30秒，有 header 则可长得多。`packages/core/src/util/retry.ts` 的通用 Promise 退避 **没有 signal 参数，等待使用裸 setTimeout**，不应直接用于要求立即取消的 Run 主链。[具体实现][oc-retry] [通用 retry][oc-core-retry]

本项目应只保留一个 Provider 重试控制点：优先 Pi 已有能力；若缺需求，再移植纯计算和用例，由当前 AbortSignal/deadline 调度器执行等待。不要复制上游订阅限额文案、重新加入累计 token 上限，也不要对已开始执行工具副作用的整个 Run 盲目重放。

OpenHands close 测试能证明调用 executor.close，即使 `delete_on_close=False` 也要关闭；它不能证明远端沙箱已消失。其清理源码会捕获部分 executor 异常后继续并置 `_cleanup_complete`，正好说明 Pivloom 还需要独立 `cleanup_pending → confirmed`：按 owner/run/sandbox ID 回收，失败近期重试，确认远端不存在后才释放对应资源占用。[源码][oh-close] [测试][oh-cleanup-tests]

## 6. Preview 授权：OpenHands 提供局部模式，不提供用户登出保证

OpenHands SDK 的 `POST /api/auth/workspace-session` 用已验证的 `X-Session-API-Key` 换 Cookie；`DELETE` 用相同路径和属性清除 Cookie。Cookie 仅用于 workspace 静态资源，其他 API 继续要求 header；测试检查未授权401、Cookie 属性、有效 Cookie 可读、Cookie 不能授权其他 API。[路由][oh-cookie-route] [鉴权][oh-cookie-deps] [测试][oh-cookie-tests]

**不能照搬的事实：**

- Cookie 值是 session API key 本身；校验是该 key 是否在 agent-server `config.session_api_keys` 中，没有 Pivloom owner/Supabase `session_id` 模型。
- 文件开头称 short-lived，但常量实际是10年 Max-Age（注释说明浏览器会截断）。不能只读概述就称它短期凭证。
- DELETE 只清浏览器 Cookie，未实现已拷贝凭证的服务端撤销；因此不证明退出 A 后旧 Preview 的新网络访问立即失败，也不证明 A、B 共享浏览器切换的隔离。

取其“资源专用 Cookie + 只读资源路径 + 清除端点”测试边界即可；Supabase session 撤销和服务端验证应依据 Supabase 的真实能力决定，不为了看起来像 OpenHands 就新增一套长期 API key。[对应代码][oh-cookie-route] [动态配置校验][oh-cookie-deps]

## 7. 替换旧方案中尚未落到成熟依据的设计

| 旧方案位置 | 应调整为 |
|---|---|
| §2.3 的“有界重试/对账”，但未给持久化前后边界 | 引用 Dyad terminal 事务/内存回退模式，定义 terminal 写库失败时谁继续持有责任；应用重启重新读取持久化 Run/资源。禁止只在 catch 里 log 然后丢弃任务。 |
| §2.3 的取消/停止原因统一化 | Pi 的同一 signal 贯穿模型和工具；借 OpenHands interrupt 顺序及迟到工具测试；用户取消、deadline、shutdown 分开落库。无需新增第二个 agent runtime。 |
| §3 自定义回滚流程 | 明确采用 Dyad 的准备、互斥、应用、持久化检查点/重启对账模式，映射现有不可变 Revision；不要复制 Git/Neon 逻辑，不把 Pi 分支对话当文件回滚。 |
| §3 只看 hash/marker 的回滚验收 | 加入 Dyad add/edit/delete/move 完整文件集对照和 OpenCode snapshot race；marker 正确但残留新增文件必须 FAIL。 |
| §4 预览 grant 绑定 session | 不能援引 OpenHands Cookie 当完整方案；只移植资源 Cookie 边界用例；用户 session 的撤销逻辑由 Supabase 一手接口与本项目现有能力决定。 |
| §7 “重试”混合 Provider、终态落库与整轮生成 | 拆成 Provider 传输重试、幂等终态重试、显式新 Run 重试三层；只有 Provider 层计算退避，任何一层不能重复另一层副作用。 |
| §8 E2E 依赖人工等待某阶段 | 借 Dyad cancelled integration 的确定性 gate：先等待 Run 被受理/该阶段已开始及 DB 行存在，再点击真实 Cancel，减少靠 sleep 碰运气。 |

## 8. 必须进入修订 E2E 的具体用例

这些是新增/加严的验收内容，**尚未执行，不标 PASS**。Provider fixture 用于稳定注入，真实模型计算器/贪吃蛇属于另外一组，不能互相替代。

| ID | 移植来源 | 在 Pivloom 必须观察到的结果 |
|---|---|---|
| LIFE-CANCEL-UI | Dyad latch + cancelled_message integration | 快速双击 Stop 只产生一次有效取消；马上显示正在停止；刷新/退出重登读到同一 cancelled Run；再次生成仍可操作。 |
| LIFE-CANCEL-STAGES | OpenHands interrupt tests | Coordinator、Builder、构建、Reviewer 分阶段启动 gate 后取消；模型/工具不再启动新调用；Run 为 cancelled、current 不变、旧功能仍可访问。另测 deadline 原因不是 cancelled 或 SERVICE_RESTARTED。 |
| LIFE-LATE-TOOL | OpenHands retained cancel token | 模拟工具比模型任务晚结束；取消后迟到结果不能写入/提升 current、不能改回成功；新 Run 使用新 signal。 |
| LIFE-STOP-SUCCESS-RACE | OpenHands complete-then-interrupt + Pivloom CAS | 取消先提交与成功先提交两种顺序各一次；只有一个终态、一个 promotion 结果，无 cancelled→succeeded 反跳。 |
| LIFE-TERMINAL-DB | Dyad terminal transaction | 把终态事务第一次写入注入失败；执行器不静默丢任务，DB 恢复后最终状态可读、资源可对账、项目可继续操作；没有再调用一次模型来填状态。 |
| LIFE-RESTART | Dyad hydration/checkpoint | 分别在受理后、沙箱创建后、Check 完成但终态提交前杀验收进程；重启读取持久化记录，明确中断，不悄悄重做副作用。 |
| LIFE-CLEANUP | OpenHands cleanup coverage + 本项目远端确认 | 第一次 destroy 失败，保留资源 ID/pending；近期重试后确认远端不存在。其他 owner 的沙箱、正式发布静态文件仍在。 |
| RETRY-PROVIDER | OpenCode retry tests | 429/503/网络中断按单一控制点重试，Retry-After 生效；无效 header 回退；401/非法参数/上下文过大不盲重试；退避中 Cancel 能结束；调用计数符合一次策略，不能 Pi×外层重复。 |
| ROLLBACK-TREE | Dyad version_integrity + OpenCode snapshot | 合成版本含新增/修改/删除/移动文件；v3→v1 后完整文件路径集合和逐文件内容等于 v1，不只检查主文件或总 hash；Preview 实际行为等于 v1。 |
| ROLLBACK-CONTEXT | Dyad restore-to-message | currentRevisionId、revisionNo、源码、Preview marker、对话当前基线统一；历史仍可看；下一轮的 baseRevisionId 是 v1，不是最近历史 v3。 |
| ROLLBACK-FAILURE | Dyad restore recovery tests | 准备新沙箱/构建失败则旧 current 不变；已准备未提交重启可清理/继续对账；已提交但响应丢失重复请求不再切第二次。 |
| ROLLBACK-SCOPE | OpenCode worktree isolation + Pivloom owner | 双标签并发生成/回滚不覆盖；另一个 owner 的 Revision/Preview 目标拒绝；不能用公开发布站点可访问作为私有 Preview 越权结论。 |
| SNAPSHOT-INSTANT-TOOL | OpenCode snapshot-tool-race | fixture 让写文件工具立即完成；源码确有改动时 diff 必须显示；快照必须在副作用前捕获，不能由异步 UI 事件时序决定。 |
| PREVIEW-COOKIE-SCOPE | OpenHands workspace_cookie_auth | 新未登录会话无权读私有预览；Preview Cookie 无权调用修改型 API；清 Cookie 后旧标签新请求失败；再加 A退出→B登录和独立A设备不被误退出。 |

此表应与主方案的四次真实提交（计算器 R1、功能 R2、视觉 R3、贪吃蛇 S1）、完整旧行为保留、原始 Check、源码差异、部署 SHA 证据合并。每个生命周期 fixture 的 PASS 仅证明该故障条件，不得拿它替代真实模型生成与真人可操作 Preview。

## 9. 本轮证据边界与方法

通过 agent-reach 指定的 `gh api` 路由取得默认分支 commit、stars、更新时间、树、许可及源码，下载到 `/tmp/pivloom-oss-audit-{opencode,dyad,openhands-sdk}`。先用 codebase-memory-mcp 索引/搜索/trace 找符号；codegraph 在这些临时仓库没有索引并明确返回 unavailable，随后按命中路径和行号读取源码。fast 模式跳过的 TS 测试已直接阅读对应文件，不能以图中缺失推断没有测试。

本轮没有执行生产 SQL、模型调用、部署或修改账号。未运行上游测试套件，也没有把任何上游绿色测试宣称为 Pivloom 的通过结果。选择这些来源的依据是可审计实现及具体断言；适配完成后仍须跑上表和完整真实样本 E2E。

[oc-license]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/LICENSE
[oc-revert]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/packages/opencode/src/session/revert.ts#L38-L123
[oc-core-revert]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/packages/core/src/session/revert.ts#L27-L121
[oc-core-snapshot]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/packages/core/src/snapshot.ts#L43-L110
[oc-snapshot-tests]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/packages/opencode/test/snapshot/snapshot.test.ts
[oc-snapshot-race]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/packages/opencode/test/session/snapshot-tool-race.test.ts#L126-L189
[oc-retry]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/packages/opencode/src/session/retry.ts#L26-L206
[oc-core-retry]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/packages/core/src/util/retry.ts#L27-L42
[oc-retry-tests]: https://github.com/anomalyco/opencode/blob/18ef3cc7c5a25b82114c953a80ccc09f4988f74e/packages/opencode/test/session/retry.test.ts
[oh-main-license]: https://github.com/OpenHands/OpenHands/blob/431393cc047f9ce6de45e8f649af0c9071259b92/LICENSE
[oh-license]: https://github.com/OpenHands/software-agent-sdk/blob/9e042d1f0bf7233b2a1a2bca4872625768eaac71/LICENSE
[oh-interrupt]: https://github.com/OpenHands/software-agent-sdk/blob/9e042d1f0bf7233b2a1a2bca4872625768eaac71/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L2507-L2738
[oh-interrupt-tests]: https://github.com/OpenHands/software-agent-sdk/blob/9e042d1f0bf7233b2a1a2bca4872625768eaac71/tests/sdk/conversation/test_interrupt.py#L80-L424
[oh-close]: https://github.com/OpenHands/software-agent-sdk/blob/9e042d1f0bf7233b2a1a2bca4872625768eaac71/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L2764-L2814
[oh-cleanup-tests]: https://github.com/OpenHands/software-agent-sdk/blob/9e042d1f0bf7233b2a1a2bca4872625768eaac71/tests/tools/terminal/test_conversation_cleanup.py#L60-L170
[oh-cookie-route]: https://github.com/OpenHands/software-agent-sdk/blob/9e042d1f0bf7233b2a1a2bca4872625768eaac71/openhands-agent-server/openhands/agent_server/auth_router.py
[oh-cookie-deps]: https://github.com/OpenHands/software-agent-sdk/blob/9e042d1f0bf7233b2a1a2bca4872625768eaac71/openhands-agent-server/openhands/agent_server/dependencies.py#L13-L61
[oh-cookie-tests]: https://github.com/OpenHands/software-agent-sdk/blob/9e042d1f0bf7233b2a1a2bca4872625768eaac71/tests/agent_server/test_workspace_cookie_auth.py
[dyad-license]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/LICENSE
[dyad-pro-license]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/pro/LICENSE
[dyad-notice]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/NOTICE
[dyad-restore-message]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/ipc/handlers/version_handlers.ts#L1247-L1822
[dyad-revert-code]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/ipc/handlers/version_handlers.ts#L496-L877
[dyad-chat-commit]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/ipc/handlers/version_handlers.ts#L1589-L1801
[dyad-reconcile]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/ipc/services/version_preview_definition.ts#L112-L170
[dyad-terminal]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/chat_stream/persistence.ts#L1026-L1120
[dyad-hydrate]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/chat_stream/persistence.ts#L173-L296
[dyad-latch]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/components/chat/useCancellationRequestLatch.ts
[dyad-latch-tests]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/components/chat/useCancellationRequestLatch.test.tsx
[dyad-state]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/version_preview/state.ts
[dyad-transition]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/version_preview/transition.ts
[dyad-transition-tests]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/version_preview/transition.test.ts
[dyad-checkpoint-tests]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/ipc/services/version_preview_persistence.test.ts
[dyad-tree-tests]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/e2e-tests/version_integrity.spec.ts
[dyad-persistence-tests]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/chat_stream/persistence.test.ts
[dyad-cancel-test]: https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/ipc/handlers/__tests__/cancelled_message.integration.test.ts#L38-L176
