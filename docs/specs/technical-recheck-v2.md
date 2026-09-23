# Pivloom 技术复核改造方案

版本：3.0（上游复用修订） · 2026-09-23。代码核查基线：`92ffbb940015a2ac9182c26d81d93dc45269d710`。状态：**源码调研与离线接口验证完成；业务移植及新版产品E2E待实施**。本轮已执行Pi官方离线测试/SDK探针和原版浏览器动作探针；没有运行新的生产模型生成，没有变更生产业务或账号。

用户要求的定时任务已经全部停用：当前只有一个 Codex 自动化 `pivloom-144`，其中包含服务器巡检、恢复和飞书评论监测，状态已从 ACTIVE 改为 PAUSED。本方案不重新开启这些任务。

## 1. 判断与范围

本次复核同时要求新样本、平台一致性与新功能，不能只在旧演示上补几张截图。继续使用 Next.js + Fastify + Pi + OpenSandbox/gVisor + Supabase；没有引入另一套 Agent 框架的必要。

| 要求 | 当前事实 | 本轮工作 |
|---|---|---|
| 全新计算器与贪吃蛇，真实模型、非固定业务模板 | Builder 确实调用 Pi；统一模板只有 React/Vite 工程骨架。历史验收以活动报名与读书清单为主 | 两个新项目、原始 Prompt、真实模型/工具事件、源码与独立浏览器验证；先补贪吃蛇所需浏览器能力 |
| 同项目两轮有效增量，旧功能保留 | 增量从当前源码 seed 开始，但契约仅强制保留至少一个旧行为 | 功能增量 + 视觉增量；完整旧要求保留、逐轮可读 diff 与全量回归 |
| 新浏览器、退出重登、账号隔离 | 平台 owner 隔离和历史测试存在；Preview 使用独立 capability/Cookie | 当前新项目全矩阵补测；私有预览授权与登录 session 的撤销关系需要补齐 |
| 版本回滚 | 现有“恢复预览”只重建同一版本，不会改变 current；没有用户回滚接口和完整历史选择 UI | 增加已验收版本回滚，并统一源码、预览、版本显示与当前对话上下文 |
| 超时、取消、失败落库、重试、清理 | 有状态机和恢复逻辑，也有明确分支问题及未覆盖失败窗口 | 按阶段复现和修复，不能只把时间参数调大 |
| 页面显示部署 SHA | 线上 health 仅返回 status/bootId；本次只读访问 `/api/v1/version` 为 404。打包器记录本地 HEAD，但页面不展示 | 构建时写入可信版本信息，API 和 Web 各自可查、页面可复制 |

真实生成、旧功能保留、浏览器和隔离的详细源码证据见[专项研究](../../research/technical-recheck-evidence-2026-09-23.md)。下述接口和数据字段是拟议设计，不代表已经上线。

## 1.1 技术路线已收敛：直接用官方能力，移植经过核查的局部模块

| 领域 | 采用来源与固定基线 | 复用决定 |
|---|---|---|
| 模型/角色执行 | Pi 0.86.1，13cbf77df2396303013a41646bcfa77b4271ae56，MIT | 直接用createAgentSession、await abort/waitForIdle、原生retry、ToolDefinition和远程operations；三角色只共用一个薄宿主 |
| 截图与长上下文 | 同版本Pi官方image tool-result测试及compaction | 复制标准ImageContent返回形式；使用官方压缩，删除DOM-only和固定last-two-turn消息拼接。保留完整证据回读工具 |
| 浏览器/小游戏动作 | agent-browser 0.38.1，aff6125c023b810ea3f2e5deec5379e9a4270bdc，Apache-2.0 | 直接用press/wait/batch/screenshot，不自建按键调度器/CDP内核；JSON argv和同revision作用域由薄适配器绑定 |
| 小游戏反馈 | OpenManus 3309bf4e416fb1c74b008f3e86494439a31bad53（MIT）；历史develop-web-game 30444aed500c00c85294d12074f6e3ee794f808a（目录Apache-2.0） | 移植截图进入下一轮模型、短输入后重新观察、Canvas/HUD/错误一起检查；不引入另一套Python Agent，不照搬模型硬编码名单或只采集不判定的exit0 |
| 停止按钮 | Dyad 0ffb5b7333264473e61b4773ce6e25001ebd06db，Apache-2.0目录 | 复制useCancellationRequestLatch及用例，适配Run UUID和权威终态 |
| 回滚与终态事务 | 同版本Dyad的version_preview和chat_stream/persistence | 移植准备→互斥→应用→事务提交→检查点恢复的顺序/测试；I/O接现有Supabase源码快照和PostgreSQL，不复制Electron/Git/Neon运行时 |
| 取消与清理 | OpenHands SDK 9e042d1f0bf7233b2a1a2bca4872625768eaac71，MIT | 移植先标取消再中止、迟到工具仍见取消、清理不遗漏的回归；Pi/AbortSignal与OpenSandbox实现实际动作 |
| 沙箱 | OpenSandbox JS SDK 1.1.0，server 15426df5d146d6ce7499a16bd1ed871e7242fe27，Apache-2.0 | 直接调用renew/kill/close并等待；close仅关闭客户端连接，kill才删远端实例，平台保留销毁确认 |
| 会话隔离 | Supabase官方session_id/auth.sessions与现有local signOut；OpenHands资源Cookie测试 | 不重造登录系统。预览授权关联真实session；只借OpenHandsCookie作用域，不能照抄它的长期API key |
| 部署SHA | Next已安装16.3.5的generateBuildId官方方案 + 当前发布manifest | 一次构建输入同一commit，Web/API各自内嵌产物元数据；不手填SHA、不读运行时checkout HEAD冒充 |

具体源码/许可证/测试：[Pi审计](../../research/pi-reuse-audit-2026-09-23.md)、[OpenCode/OpenHands/Dyad审计](../../research/oss-reuse-audit-2026-09-23.md)、[OpenManus/Manus小游戏审计](../../research/openmanus-games-reuse-2026-09-23.md)、[浏览器/会话审计](../../research/browser-session-reuse-2026-09-23.md)、[精确复用清单](../../research/reuse-manifest-2026-09-23.json)。

### 不采用的路线及原因

- Pi 0.87.1有breaking changes：shouldStopAfterTurn改finishTurn、上下文权威来源变化。先固定0.86.1，升级单列兼容迁移，不与本轮修复混在一起。
- Pi SessionManager分支只切对话，不恢复文件；git-checkpoint官方样例有内存Map/UI依赖，不能冒充平台跨重启回滚。
- OpenCode的shadow Git撤销依赖本地worktree，部分checkout不会删除旧目标中不存在的新文件，也会清理后续消息；本项目不再引入第二份文件状态真相。
- Dyad的src/pro是限制竞争用途的FSL目录，不能当Apache模块复制。只取报告列明的开放目录及测试。
- Manus官网有小游戏功能，但用户应用源码导出不等于产品Agent开源；不提出“copy Manus未公开实现”。
- OpenManus当前默认是Browser Use CLI 3.0 MCP；旧BrowserUseTool教程不再是当前路线。硬编码多模态名单会丢图，不能复制该判定。
- 固定历史develop-web-game能提供方法与代码片段，但已从main删除，脚本exit0不表示玩法通过；不作为持续维护的一键验收服务。

**确实需要保留的项目代码：**owner权限、五组业务要求、Run/Revision/Check事务、异步事件落库屏障、源码快照/Preview/发布关联。已查上游没有可直接替代这套业务模型的完整模块。这里保留最薄适配，不能把保留业务事务变成再造Agent框架。

## 2. 已定位的优先缺口

### 2.1 五个固定验收组，完整子检查

用户已明确选择：固定五个验收组，每组列完整子检查。五组是展示与执行分组，不是最多五条需求。每组至少包含一个实际子检查，组内所有required子项均通过才可计入5/5；failed/blocked/未执行子项不能被总分掩盖。

当前Plan/Review最多五个平铺条目，且preservesPreviousBehavior仅要求匹配一个旧条目。需要保留五组稳定ID，并把必需要求作为可追加、可追踪的子检查；下一轮携带全部旧required。新增功能追加子项；字段/视觉语义发生明确修改时记录被替代的旧子项，不能复用ID悄悄改义。UI同时展示组通过数和子项明细，原始JSON可核对。旧平铺Check只能按其原有证据读取，不追认更强覆盖。

具体数据边界：继续使用现有BehaviorTarget作为原子子检查，移除平铺列表最多五项的误限；增加五个group（稳定groupId、名称、behaviorIds）。子检查结果仍逐项绑定观察/截图，由服务端按behaviorIds聚合组状态，模型不能自行报一个总分。每个required子项必须完整且只归属一个组；缺失、失败或blocked都会阻止对应组通过。老Plan/Check未包含groups时按原始N/N显示并标历史格式，不倒填成新5/5。

这是Pivloom自己的验收领域契约，不是Pi/OpenManus现成产品功能。实现限制在现有contracts、计划校验、检查落库与展示；不另造验收DSL或独立服务。[原限制](../../packages/contracts/src/planning.ts#L24)、[只保留一项](../../packages/contracts/src/planning.ts#L40)、[当前计数](../../apps/web/src/components/generation-review.tsx#L64)

### 2.2 贪吃蛇复用成熟浏览器与真实图像反馈

原版agent-browser已经支持四向键、Space、等待、batch和截图，当前Pivloom外层白名单/工具接入没有完整暴露。直接复用其固定版本的命令/schema语义，平台只绑定session、origin、revision、取消信号和现有时限。批量动作使用官方JSON argv数组，短序列结束重新观察，不再开发自定义按键队列。

截图按Pi官方screenshotTool样例返回text元信息与真实ImageContent；模型input需要包含image，并通过当前实际Provider的图像探针。OpenManus的工具图像转发与历史develop-web-game的短动作→截图→判断方法提供参考，具体传输使用Pi已有归一化，保留真实MIME。

**撤回上一版DOM棋盘优先方案。** 新贪吃蛇保留Canvas，不能因为好测而换渲染方式。先验证截图链/按键/时序，再真实生成；Provider不支持图像时需换可验证的Reviewer配置并解决，不静默降级成DOM-only通过。正常暂停可以稳定游戏画面供推理，但不注入作弊加分/坐标/冻结状态。完整证据见[浏览器探针](../../research/upstream-browser-probe-2026-09-23.json)与[小游戏研究](../../research/openmanus-games-reuse-2026-09-23.md)。

### 2.3 取消、终态落库和清理有具体修复目标

| 代码路径 | 核查结论 | 修复与验收 |
|---|---|---|
| Candidate 返回 cancelled，Executor 对所有非 candidate 结果调用 finishFailed，后者写 state=failed | **取消分支不一致已由源码确认**；Coordinator/Reviewer 抛异常路径另走 finishCancelled | Builder 用户取消必须以 cancelled 收口；区分用户取消、Run 截止、模型超时、服务停止。各阶段分别验证 |
| execute 末端异常被 `.catch(() => {})` 吞掉后从 tasks 移除 | **落库失败窗口**；若 finishFailed/finishCancelled 本身因 DB 中断失败，可能只剩数据库活动状态 | 注入终态事务失败，恢复后有界重试/对账，不得静默丢失；日志可关联 Run；失败落库不依赖用户重启服务 |
| 清理轮询仅在资源 expiresAt 到期后执行 | **清理重试滞后窗口**；取消后的 pending 不一定很快再次确认 | pending 清理单独安排近期重试并持久化结果，不能只等预览 TTL；保留 owner/run/revision 精确回收边界 |
| 到期资源对活跃任务调用无原因 abort | **错误分类窗口**；可能进入 SERVICE_RESTARTED 分类 | 保存明确停止原因，校准沙箱续期/到期与任务截止，不把 TTL 耗尽说成服务重启 |
| close 等待 restores，但没有统一记录/中止 restore controller | **退出耗时窗口**；预览恢复可能等到其自身超时 | 恢复任务参与停止流程，进程重启后持久化操作可对账、项目不永久锁定 |

来源：[Candidate cancelled](../../apps/api/src/generation/candidate.ts#L355)、[非 candidate 收口](../../apps/api/src/generation/executor.ts#L190)、[finishFailed](../../apps/api/src/data/generation.ts#L532)、[外层取消](../../apps/api/src/generation/executor.ts#L258)、[任务收尾](../../apps/api/src/generation/executor.ts#L375)、[清理轮询](../../apps/api/src/generation/executor.ts#L305)。风险窗口尚未在本轮注入复现，不写成已发生的线上故障。

生命周期具体以Pi原生await abort、waitForIdle/agent_settled为基础；借OpenHands interrupt顺序处理迟到工具，借Dyad终态事务/错误回退处理DB失败。Pi subscribe的listener是void，不能删除异步PostgreSQL事件eventTail/drain屏障。

另纠正当前budgets.ts的错误解释：Pi 0.86.1成功assistant响应会重置retryAttempt，maxRetries针对连续错误链，不是整个role累计次数；只有Pi负责Provider重试，不再叠加OpenCode或外层重跑。OpenCode Retry-After计算仅在Pi确有未覆盖需求时局部移植。

当前参数为 Run 30 分钟、单模型请求 210 秒、Reviewer 单次 20 分钟、恢复预览 5 分钟、共享工具调用 80 次。这些是需要联调的不同边界；保留用户已明确取消的“无累计 Token 上限”，不得把旧 40 万限制重新加回。[参数](../../apps/api/src/runtime/budgets.ts#L14)、[Token 账本](../../apps/api/src/runtime/token-budget.ts#L18)

## 3. 版本回滚的具体语义

直接采用Dyad开放目录version_preview、restoreToMessage与终态持久化的协调顺序和回归问题集，接现有Pivloom快照/数据库。Dyad本身会新建revert commit、可能恢复Neon，不照抄其产品语义；OpenCode影子Git也不引入。

本项目采用**切回历史已验收快照**：例如当前 v3 回到 v1，页面明确显示“当前版本 v1”，历史 v2/v3 仍可查看；下一次生成使用新的递增版本号。回滚不调用生成模型，也不把旧源码复制成一个假新版本。

1. 增加 owner 隔离的历史版本列表，区分 accepted、candidate、rejected；只能把已验收版本设为 current。当前 UI 仅列 current 和 latestCandidate，需要真正的版本历史入口。[UI](../../apps/web/src/components/api-workbench.tsx#L77)
2. 拟新增 `POST /api/v1/projects/:id/rollback`，请求含 targetRevisionId、expectedCurrentRevisionId 和 Idempotency-Key；响应包含操作 ID 和状态。同项目生成、恢复和回滚使用同一项目操作锁，避免双标签页并发覆盖。
3. 按Dyad检查点模式保存最小操作记录：from/target、已准备的binding、phase/error、幂等键；沿用现有repository/operation边界，不增加通用工作流框架。回滚不能借普通生成Run冒充模型执行。
4. 先验证目标源码快照、sourceHash 和历史 accepted Check；需要时复用现有恢复构建函数重建该目标 Preview，核对 marker。只有准备成功后才在事务中切换 current、记录回滚事件并释放操作锁。恢复失败时保留原 current。
5. 对话历史不删除。增加清楚的系统消息“从 v3 回到 v1”，并把当前上下文、源码页、Preview、版本标签都指向 v1。历史 v2/v3 消息保留版本归属，不能继续把最近一次 Run 的结果当作当前版本。
6. 下一轮生成继承 v1 的源码和计划。现有 accept 已从 current_revision_id 获取 previousPlan，Executor 也据 baseRevisionId 加载源码，可直接复用；补测它不会把 v2/v3 的要求错误带回。[计划基线](../../apps/api/src/data/generation.ts#L397)、[源码基线](../../apps/api/src/generation/executor.ts#L143)
7. 回滚不自动重新发布永久站点。工作台当前版本与已发布版本分别显示，用户再次主动发布才更新公共地址，延续已有“发布可选”规则。

现有 `beginRestore/bindRestore` 仅重建 Preview 并释放 restore 锁，没有切换 current，不能把它包装成回滚完成。[恢复入口](../../apps/api/src/data/generation.ts#L951)、[恢复提交](../../apps/api/src/data/generation.ts#L1005)

回滚验收采用Dyad文件完整性和OpenCode snapshot race测试问题集：在新增/修改/删除/移动文件后v3→v1，核对完整路径集合（无残留新文件）、逐文件hash、currentRevisionId/revisionNo、Preview marker、对话回滚消息和下一轮baseRevisionId；刷新、新浏览器重登后仍一致。另测重复请求、越权目标、未验收候选、恢复失败、进行中的生成冲突、回滚过程中服务重启。历史 Check 必须标明其历史来源，不能伪造为对新沙箱刚执行的检查；恢复后另作真实浏览器回归。

生成应用自己的 localStorage 仍按 origin 隔离。版本回滚不等于业务数据库回滚，也不承诺跨域迁移报名记录或游戏记录。

## 4. 私有 Preview 与账号隔离：复用 Supabase session 语义

沿用Supabase Auth与现有signOut(scope local)，不新建身份服务。官方说明JWT含session_id，注销移除auth.sessions记录，但已签发access token可能到期前仍有效；不能只凭getUser或JWT签名有效认定退出后的私有访问被撤销。[官方Sessions](https://supabase.com/docs/guides/auth/sessions)、[现有local signOut](../../apps/web/src/lib/workspace.ts#L105)

在已验证身份后关联真实session_id，预览capability/Cookie仍限于owner+revision，并检查该登录session有效；退出撤销当前session的预览能力，另一个有效A会话不被误下线。通过受限服务器查询/函数获取会话状态，不把auth.sessions开放给普通客户端。

参考OpenHands的workspace专用Cookie/清除端点及其测试，只移植作用域边界；其长寿命API key Cookie与单服务配置白名单不满足Pivloom登录撤销，不能整套照搬。凭据不进入生成应用源码、URL或日志。

补测：全新未登录浏览器、A正常登录、A退出后旧入口/Cookie/HTML/JS/marker的新请求、同浏览器切B、独立B、独立仍有效A、A重登。已下载的客户端内容不可能远程抹掉；正式发布匿名可读不属于私有越权。

生产当前只保留A。新增隔离用临时同构验收环境账号和合成数据，精确清理；不恢复已删除B或改A正式作品。主矩阵见E11/E25/E37。

## 5. 部署 SHA 必须来自实际产物

页面显示“Pivloom Web SHA / API SHA”，并可复制完整 commit；生成应用的 sourceHash 另列，不能把两种标识混为一谈。

- 直接使用已安装Next 16.3.5官方generateBuildId示例，以构建时GIT_HASH输入；若配置deploymentId，遵循它覆盖buildId的官方语义。API/Web都将同一次构建输入写入产物元数据（commit、builtAt、组件），提供版本端点和可复制页面展示。[官方配置](https://nextjs.org/docs/app/api-reference/config/next-config-js/generateBuildId)
- 生产包必须由确定的提交构建，阻止带未提交业务源码的正式发布；页面不手填 SHA，不把服务器当前 checkout 的 HEAD 当作运行进程版本。
- 修正当前打包器“读取已经存在的 dist/.next，然后取此刻 HEAD”的来源不够强的问题；构建前后核对提交，产物元数据随包发布。现有本地归档 JSON 保留历史，不倒改旧 dirty 记录。[打包器](../../infra/release/package.py#L46)
- 验收页面 SHA = API 端点 = 对应发布产物元数据；独立部署允许两个组件 SHA 不同，但本次完整复核应冻结一组明确的 Web/API 提交。服务重启后保持相同值，换包后才变化。

## 6. 新样本与逐轮验收

最小真实生成矩阵是四次用户提交：全新计算器 R1；同项目功能增量 R2；同项目视觉增量 R3；另一全新项目的贪吃蛇 S1。修复尝试不冒充用户增量，失败后反复重试的记录也不得丢掉。

- **计算器 R1**：中文四则计算器；明确连续运算/优先级规则；数字、小数、加减乘除、清空、退格、等号；除零提示后可继续正常计算。键盘若写入需求必须实测，不能只点按钮。
- **功能增量 R2**：增加可查看和重用结果的计算历史；所有 R1 必需行为保留。读业务源码 diff，确认新功能来自真实实现。
- **视觉增量 R3**：指定明确配色、字号/布局及 390px 键盘可用性；历史、运算、错误恢复继续通过。纯视觉不能只以 CSS hash 变化验收，需要实际视口截图与操作。
- **Canvas贪吃蛇 S1**：四向键盘、开始、暂停/继续、吃食变长并计分、碰撞结束、重开；Canvas像素与HUD均可核对，图像实际进入Reviewer。使用真实操作吃食，不改 store/坐标/分数来制造 PASS。

每轮保存统一证据元组：`projectId / runId / baseRevisionId / revisionId / revisionNo / sourceHash / Check / Preview marker / model profile/configVersion / Web SHA / API SHA`。模型真实调用用冻结配置、角色调用用量和脱敏传输佐证，不能只拿顶层 Run 的空 usage 或 model_id 判断。[新样本详细设计](../../research/technical-recheck-evidence-2026-09-23.md#5-建议一次完成的补测流程)

源码差异要可读、覆盖全部源文件；不同 hash 只证明字节不同。Review 通过、独立浏览器操作通过、刷新/重登后状态一致是三个分别记录的结果，不能互相代替。

## 7. 故障验收矩阵

| 场景 | 必须核对的结果 |
|---|---|
| Provider 不返回首字节/中途停流/返回明确错误 | 正确阶段和错误码；停止后不再发新请求；失败记录可重开读取，保留已提交源码 |
| Coordinator、Builder、构建、Reviewer 分别取消 | UI 及时进入 cancel_requested，最终 cancelled；远端终止与资源确认后释放锁；旧 current 不变 |
| 取消与成功提交竞争 | 数据库只有一种合法终态；已完成不反跳取消，取消先提交则迟到 Check 不得提升版本 |
| Run 截止与沙箱到期 | 原因明确，deadline/renewal 行为一致；不伪称服务重启、不无限 pending |
| 终态事务短暂失败 | 恢复后最终落库/对账；无脱离 executor 的永久活动 Run、无全局生成槽永久占用 |
| 销毁首次失败、随后恢复 | cleanup_pending 可见，近期重试后确认；不误删其它版本/owner；清理确认前不重叠占用 |
| 浏览器断网、刷新、重复提交 | 服务端同一 Run 持续执行；SSE 断线回放，无重复模型任务和重复扣额度 |
| 失败后点击重试 | 新 Run 关联旧 Run；源基线清楚、旧失败记录仍可查看；成功后 Preview/Check/current 一致 |
| API 进程被终止后重启 | stale Run 标记与资源清理可证明，项目可重新操作；不声称 Agent 透明续跑 |

故障注入限定隔离环境和明确开关；外部模型/沙箱 fixture 与真实模型 E2E 分开报告。取消与清理验证模型请求已中止/远端任务已终结的可观测边界，不把停止后的本地输出静默当远端必然停止计费。

## 8. 实施顺序、E2E与复制交付

| 批次 | 明确复用与实现内容 | 立即验证 |
|---|---|---|
| A | 固定上游版本；以Pi官方样例统一薄宿主、abort/idle/retry/事件drain；部署SHA | Pi兼容探针、E13/E14/E30/E32/E40/E41 |
| B | Pi ImageContent + agent-browser原生batch/press/wait；移植OpenManus/游戏recipe的反馈次序 | E33真实视觉Provider、E34按键/时序、E42Canvas负例，门槛失败先解决 |
| C | 用户确认的五组/完整子检查、全部旧required保留；官方compaction替代手工截历史 | E39漏项/改义负例、长会话证据回读；原始5/5与子项一致 |
| D | Dyad开放部分回滚/事务模式接已有快照；Supabase session验证与OpenHandsCookie作用域测试 | E35/E36/E38完整文件回滚；E11/E25/E37新会话隔离 |
| E | 冻结Web/API版本，全新计算器、两轮增量、另一个Canvas贪吃蛇，再回滚和重登 | E01–E42及相关I项逐项记录；正常生成与故障fixture分开 |

本轮调研已证明Pi原样离线45测试、SDK5探针、浏览器9动作接口可用；未做生产模型视觉验证，也未把模块移植到生产。具体来源和适配边界在[复用清单](../../research/reuse-manifest-2026-09-23.json)，未来复制需保留MIT/Apache许可、NOTICE和修改说明；Dyad Pro及未公开Manus代码不在复制范围。

每批完成立即跑关联E2E；上游green不自动转换为Pivloom通过。故障先定位再重测受影响模块，最后一次冻结部署整链。独立浏览器有真实操作、截图和源码核对；不能用HTTP或模型自述替代。精确用例已更新在[E2E v2](../E2E.md)，其中历史成绩与本轮NOT_RUN明确区分。

最终交付是可复现的功能与一份简洁复核报告：入口/部署 SHA、原始 Prompts、每轮版本与源码 diff、浏览器结果、原始 Check、回滚前后对照、身份矩阵和故障终态/资源记录。只把当轮实际通过项标为 PASS；旧报名/书单报告作为历史依据，不代替新样本。
