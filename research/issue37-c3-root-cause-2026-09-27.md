# Issue #37 / C3：为什么慢、为什么改了仍过不了

取证日期：2026-09-27（Asia/Shanghai）。本轮是诊断，未修改产品实现、部署、账户配置或 GitHub 状态，未触发新的付费模型运行。

**结论：当前主要障碍是验收执行器和测试契约本身不可靠。继续扩大工具预算、堆提示词、反复完整生成，不能解决它。** 旧模型路径把浏览器交互拆成数百次模型往返；新脚本路径去掉模型后，仍存在大量远程命令、测试状态污染、断言语义漂移，以及一个视觉用例抹掉全部已完成结果的错误边界。

## 1. 证据范围和可信度

- 成功读取[原题](https://deepwisdom.feishu.cn/wiki/EHf8wgbtbibv8JkOkjNcXTD4nlg?from=from_copylink) revision 510、[第一轮答复](https://nx104h5ukl3.feishu.cn/docx/DE5tdPfZhoHzYnxrTxdcsuATnab) revision 52、[第二轮答复](https://nx104h5ukl3.feishu.cn/docx/NOvfdT7vXo5gOExr9qScSmc9nNP) revision 17。
- 读取 GitHub #1–#44 Issue 清单和正文，重点读取 #30/#37/#40/#41/#42/#43/#44 全部评论以及 PR #45；阅读交接、规格、验收记录、既有开源研究。
- 按知识图谱定位架构和符号，再用 codegraph 读取生成、计划、评审、回放、浏览器、预算和结果持久化调用链。不是声称逐行读完了所有前端、依赖和历史工件。
- 通过已有 SSH 控制连接读取生产 PostgreSQL；查询使用只读事务。生产数据优先于交接的叙述。
- 使用真实代码和替代外部传输的 fixture 做秒级机制复现；这些证明错误路径，不等于真实浏览器性能基准，也不代表修复后的 E2E 已通过。
- 本地 HEAD / GitHub main：`81c9334096592dcccded4d786a421c1616fccd19`。线上 API/Web：`0999fafd69433169359b88201e1aab55a237b808`。后二次提交只改文档，但三处 SHA 在字面上不一致。ready 返回 200。

临时取证目录：`/tmp/nano-atoms-diagnosis/`。需求子报告在 `requirements/requirements-findings.md`。飞书原始数据含历史体验凭据，不应公开附出；本文不包含密码、密钥或连接串。

## 2. 先校正产品目标和交接

原题关注可用体验、真实交互、持久化、交付和复杂度取舍。HR 六项技术复核没有要求“每条文本或数值判断都必须图片”，也没有要求每轮等待数十分钟。

[#37](https://github.com/hengworkinggit/pivloom/issues/37) 的 C3 是回滚后的一个小变更：保持 C1 浅色，新增历史记录的全部清除与单条删除，证明增量确实基于回滚后的源码。它不是新增 45 个独立需求。第二轮文档的计算器 required 数为 12/17/21；第三轮累计行为 C0 28 → C1 38 → C2 44，C3 多次重规划出现 39–45 条。

用户本次明确说“10 分钟也不可接受”。因此旧文档“验收段 ≤10 分钟”不再是足够的成功目标，尤其它排除了规划和生成，而且多数测量以失败结束。

| 交接说法 | 本次核实 |
|---|---|
| 固定 280 次预算从未修改 | 不正确。`8230ece` 已加入按行为数扩容，是线上 `0999faf` 的祖先。实际还有整轮共享 384 次上限。 |
| 最近 44 项失败是跑满 10 分钟、signal.reason 不符合预期 | 对最新 `22b35a1d` 不正确。验收 8.63 分钟，真实错误是视觉步骤缺少初始观察，非超时。 |
| 约 43 项就是时间包络，44 项必超时 | 没有证据支持这个硬阈值。行为长短悬殊，44 项也有 6.00 分钟完成检查的记录；失败原因不能由条数推断。 |
| 运行时控件解析回退已接入 | 端口在上层构造，但 `runScriptedPlan` 没传给 `runPrograms`，正常入口调用次数为 0。 |
| 有总 token 预算作为第二道约束 | 当前主调用 `createRunTokenBudget()` 不传 limit，默认 null；有台账，不等于有总 token 硬上限。 |
| 6–9 分钟说明单次增量已达标 | 只是验收片段；端到端更长，且未产出 accepted C3。 |

相关位置：[交接](../docs/specs/handover-2026-09-26.md)、[预算](../apps/api/src/runtime/budgets.ts)、[评审](../apps/api/src/runtime/reviewer.ts)、[执行器](../apps/api/src/generation/executor.ts)、[token 台账](../apps/api/src/runtime/token-budget.ts)。

## 3. 生产实际耗时

口径：端到端为 `runs.created_at → finished_at`；脚本验收为首个 `browser_steps` 事件 → `checks.created_at`；旧模型阶段用 `role_runs.started_at → finished_at`。

| 运行 | 行为数 | 端到端（分钟） | 验收（分钟） | 结果 |
|---|---:|---:|---:|---|
| `177ff00f`，旧模型路径 | 45 | 271.87 | 首审 202.00，复审 63.24 | 首审 43 passed / 2 failed；复审工具超限 |
| `b75f39a9` | 40 | 8.30 | 6.95 | 37 passed / 2 failed / 1 blocked |
| `5a2e1e67` | 44 | 7.95 | 6.00 | 9 passed / 4 failed / 31 blocked |
| `cdcae90e` | 43 | 9.79 | 8.19 | 33 passed / 7 failed / 3 blocked |
| `9c89deef` | 43 | 10.83 | 9.13 | 32 passed / 7 failed / 4 blocked |
| `4d776ebc` | 44 | 11.25 | 9.19 | 全部 44 blocked，证据数组为空 |
| `22b35a1d` | 44 | 10.08 | 8.63 | 全部 44 blocked，证据数组为空 |

`177ff00f` 是交接直接引用的历史样本，其实际时间比“40 分钟”更长；不把这个极端样本当成所有运行的典型值。

该旧运行首审 210 次工具 / 206 次模型调用，工具开始到完成的时间合计仅 3.83 分钟；复审 148 次完成工具、usage 记 149 次工具 / 137 次模型调用，工具耗时合计 3.59 分钟。大部分时间在工具调用之间的模型循环/等待，不在浏览器动作内；现有数据不足以继续分离模型推理、provider 排队、重试和其他运行时开销。

最新 `22b35a1d` 的规划 0.90 分钟，Builder 含构建 0.52 分钟，Reviewer 8.67 分钟。当前样本的瓶颈已经转移到回放检查，不能笼统归因于生成模型太慢。

截至取证，库内与 C3 请求逐字相同的提交有 36 次：33 failed、2 cancelled、1 needs_input，无 succeeded；failed 运行累计墙钟 759.00 分钟。这是历史累计，不是单次延迟或修复后的成功率。计算器当前 accepted 仍为 v2，最新候选已到 v47 且 build passed，未成为 current。

## 4. 已定位的直接缺陷

### 4.1 一个视觉程序失败，抹掉前面全部结果

生产 `22b35a1d` 的时间线：

1. `17:25:20.422Z`：43/44 条可编译，开始脚本回放。
2. 43 条程序执行完成；checkpoint 中有 32 passed、9 failed、2 blocked。
3. `17:33:57.729Z`：`replay_error = STALE_BROWSER_REF: 第 1 步操作前还没有可用的页面观察`。
4. `17:33:58.416Z`：最终 44 条全部 blocked，`evidence_json=[]`。

计划 B25 的步骤是 `resize → reload → capture`，没有 `open`。每次 `runReplayProgram` 的局部 `latest` 从 undefined 开始；视觉阶段对该错误没有逐条隔离。错误逃到 `runReview` 外层，整份结果被通用 blocked 报告替换。

调用链：`runScriptedPlan` :250 跑 A → :267 写 checkpoints → :277 调 `captureVisualPrograms` → :456 调 `runReplayProgram` → `replay.ts:292` 抛错 → `review.ts:216` 再抛 → :249–252 全量覆盖。

本地真实 `runReview` 入口复现约 9 ms：A 的 B01 checkpoint passed，追加一个无 open 的视觉 B25 后，B01/B25 全 blocked，evidence 0，模型调用 0；报错与生产逐字一致。**改 `signal.reason === REVIEW_TIMEOUT` 不会修复这个错误。**

来源：[replay-plan.ts](../apps/api/src/runtime/replay-plan.ts)、[replay.ts](../apps/api/src/runtime/replay.ts)、[review.ts](../apps/api/src/generation/review.ts)，生产 `events.txt`，本地 `/tmp/nano-atoms-runtime-diagnosis.mts`。

### 4.2 测试断言会同时制造假失败和假通过

`evaluateAssertions` 对文本用整页字符串包含判断（`replay.ts:179–183`），不是对“表达式框”“结果区域”“某一行历史”做断言。

- B09 要验证“清空表达式、结果回 0”，实际却断言整个页面没有 `1+2`。生产最终观察确实是顶部 `0`，历史保留 `1+2 = 3`；检查仍判 failed。它在惩罚正常保留历史的行为。
- 同样，断言整页含 `2`，可能被数字按键 2 或旧历史满足，即使真正结果是 999。真实判定函数的 fixture 已复现这种假通过。
- B30 要验证首次加载历史为空，却排在多个写历史的用例后，只有 `open /`，没有建立初始数据状态。

不能把这些结果全交给 Builder“修作品”。那会驱使生成器破坏正确行为来迎合错误测试。

### 4.3 回放用例共享状态，结果依赖执行顺序

`runPrograms` 给每个行为传同一个 browser；`RemoteBrowser.openPage:117–121` 只在同一 session 导航，不创建隔离 context、不清除 localStorage。`precondition` 是文字，不是被执行的 setup。

真实回放函数 + fixture 复现：B30 单独执行 passed；B09 后执行 B30，B30 failed，期间未关闭或重建 session。生产观察中也能看到前序用例写入的多条历史。

“为每轮 reviewer 新建浏览器”不等于“独立测试用例隔离”。持久化测试应在单个场景内保留状态；彼此独立的场景应有各自初态。Playwright 官方以独立 BrowserContext 隔离 localStorage/cookies，并指出共享状态会造成连锁失败：[测试隔离](https://playwright.dev/docs/browser-contexts)。

### 4.4 计划的文字不变，真正执行的标准却能变

`sameObservableBehavior` / `preservesPreviousBehavior` 明确不比较 `steps/assertions/evidence`（`planning.ts:160–180`）。Coordinator 重新生成这些字段，Zod 校验只保证形状。

本地把真实 B32 全部文本断言的 `negated` 翻转，`PlanSchema` 仍有效，两个守卫仍返回 true。这说明保住 `expected` 原文不等于保住实际判断标准。

生产中的 B32：

| 运行 | 原始要求 | 真正生成的计算 | 真正断言 |
|---|---|---|---|
| `22b35a1d` | 依次 1+1 到 21+21，最近 20 条 | 仅 1、2、3、4、5、21，共 6 次 | 要求 21+21 存在、1+1 消失 |
| `4d776ebc` | 同上 | 仅 1 至 11，共 11 次 | 改成 11+11 和 1+1 都存在 |

两份计划均通过 schema。后者甚至改变了应排除第一条的判断方向。不能把这叫确定性验收契约；只是确定性执行了不稳定的测试生成结果。

来源：[planning.ts](../packages/contracts/src/planning.ts)、[coordinator.ts](../apps/api/src/runtime/coordinator.ts)、生产 `plans.jsonl`。

### 4.5 执行 DSL 装不下现有验收要求

单行为 `steps` 最多 64 条（`planning.ts:42/84`）。当前结构只有单键 `press`，未暴露浏览器已有的 keyBatch，也没有有界循环/分段机制。

用真实输入序列做 21 次 `n+n`，即使只用键盘、不插入清空，也至少需要 108 个按键加 open，已经超过 64；加清空等完整动作的复现程序为 130 步，被 schema 直接拒绝。

这解释了为什么模型把 21 次压成 6 次或 11 次。**提高行为数容量或要求模型“完整填写步骤”不能解决单条程序表达能力不足。** 应提供短键盘批次、有界重复或跨段程序，仍执行真实输入，不能把 21 次改成更少。

### 4.6 控件解析回退漏传

`review.ts:161–179` 构造并传入 `resolveControl`；`runScriptedPlan:250–262` 调 `runPrograms` 时遗漏它；视觉捕获路径也没有转交。

给真实入口注入一个一定返回合法 ref 的 resolver，故意让名字匹配失败，本地结果为 `resolverCalls=0`、blocked。单测直接调用底层 `runReplayProgram` 的回退能力，并不能证明生产入口真的接通。

这也解释“已经加入按实际控件解析，线上仍然大量 STALE_BROWSER_REF”的矛盾。应修接线并做入口级验证；随后再统计实际回退次数与模型成本，不能仍记零调用。

### 4.7 硬时间预算没有覆盖整个 A+B 路径

`REPLAY_WALL_CLOCK_BUDGET_MS=120000` 只定义了数值，没有给 A 层安装总计时器。`runPrograms` 识别外部 signal 的 REVIEW_TIMEOUT，但产生该原因的计时器在另一条 `runReviewer` 模型路径中。

B 层拿 `480000 - A已耗时` 当剩余时间（`replay-plan.ts:289`）。于是 A 能继续跑八九分钟，到 B 时只得到 `budget`；“常量相加为十分钟”的测试不能证明真实调用链受十分钟限制。

本地注入时钟，使 A 执行后显示已耗时 601000 ms，A 仍返回 passed。这是机制复现，不是一次真的等了十分钟的计时实验。

应由 A/B/C 共用一个总 deadline，贯穿远程命令、证据保存和模型请求；单项故障、时间耗尽、用户取消、版本绑定失效要分别处理。取消与源码/版本失效不能沿用可接受结果。

### 4.8 总预算、optional 和 blocked 的处理让运行进一步放大或停住

- 每次 Reviewer 的本地计数重新开始，单轮上限已是 `max(280, min(8×N, 600))`；但 executor 给它的 `remainingTools` 来自整轮 384 次总额，规划、Builder、首次评审、修复和复审共享。因此不是“首审花掉同一个 280 的大部分”，而是不同层的预算不匹配。
- 旧 `177ff00f` 数据和验收记录显示 43 个 required 全过，两项 optional failed。代码中组内和整体 verdict 都看全部 items，`required` 只参与组内 requiredCount 统计及额外完整性约束，所以 optional failed 仍把整个运行送进修复。它与 [#41](https://github.com/hengworkinggit/pivloom/issues/41)“optional 不阻断 #37”的说法冲突。必须明确产品语义，不能临时忽略检查来关单。
- 当前只要有 blocked，整体优先 blocked；自动修复围绕 failed 结果触发。一个无法执行的测试可以阻断对已发现作品错误的修复，因此“已有 7 failed 为什么没有修好”可能是平台路由问题。
- 脚本 usage 的 `elapsedMs=0`，token 数据为空，modelCalls 只计视觉判定。新路径的可观测性没有完整跟上。

来源：[executor.ts](../apps/api/src/generation/executor.ts)、[reviewer.ts](../apps/api/src/runtime/reviewer.ts)、[generation.ts](../apps/api/src/data/generation.ts)、[replay-plan.ts](../apps/api/src/runtime/replay-plan.ts)、[历史记录](../docs/test-runs/2026-09-25-a-rc-frozen-mainline.md)。

## 5. 去掉模型仍慢：回放没有真正做到就地批量执行

本地调用真实 `RemoteBrowser` + `OpenSandboxWorkspace`，只替代远程传输，得到以下命令数：

| 操作 | 远程命令次数 |
|---|---:|
| 第一次 open | 5 |
| 一个 click | 6 |
| screenshot | 4，另有一次图片读取 |
| logs | 3 |

单击链：检查 URL → click → 检查 URL → snapshot → 读取 body 文本 → 检查 URL。

每条命令又走 `adaptSandbox.run`：启动 background command → 拉日志 → 查状态 → 结束时再次拉日志，至少四个 SDK 请求；仍在运行则每 180 ms 轮询。此处是按当前控制流计算的请求下界，不是抓包测量。

生产 `9c89deef` 的计划有 392 步，其中 265 click、27 press。仅这些基础动作，全部执行时就对应 1752 条远程命令，尚未计 open、截图、日志、保存证据等。这不是实际完成数，因为失败用例会提前停止；它说明当前计划的工作量级。

故应优化的是**一次提交受控的多步场景，在沙箱内用常驻浏览器执行**，将 scope、状态准备、动作和关键断言放到同一执行环境。保留来源限制和逐步失败记录，但把检查移到浏览器附近，避免每一键都从 API 往返多次。已有 keyBatch 可作为局部起点，不能误以为现在所有 replay steps 已经批量。

来源：[browser.ts:145/268/465](../apps/api/src/runtime/browser.ts)、[workspace.ts:125](../apps/api/src/runtime/workspace.ts)，可重跑 `/tmp/nano-atoms-diagnosis/browser-cost.mts`。

## 6. 为什么借鉴成熟项目后仍陷在这里

不是还缺一个大型 agent 框架。已有研究提到了测试隔离、局部失败、结构化证据、批量动作，但拼接后的端到端链路没有保持这些性质：

| 文档目标 | 实际路径 |
|---|---|
| 一条失败不废整份计划 | A 层局部 catch 有了，后续视觉层无相同边界 |
| 无效定位只重解该步 | resolver 上层有定义，中间层漏传 |
| 不改旧验收标准 | prose 被冻结，真正执行的 assertions 被排除于守卫之外 |
| 脚本化应 1–2 分钟 | 仍是单键/单动作多次远程 CLI，没有就地批量执行 |
| 增量只验受影响范围 | 当前 compilePlan/runPrograms 仍遍历整个计划；容量模块只是 shadow 观察 |
| ≤10 分钟强制准入 | 只约束部分模型路径，A 无统一 deadline，成功口径又不含规划和生成 |

Playwright 官方支持按元素/容器定位和具备等待语义的断言；这才适合“结果区域等于 2”“该历史行被删除”，不能用全页包含文本代替：[Locators](https://playwright.dev/docs/locators)、[Assertions](https://playwright.dev/docs/test-assertions)。这些文档支持方法，不承诺本项目改完具体能快到多少秒。

既有研究里的另一个产品“health check 1–2 分钟”或视觉审查“约十分钟”，并不等价于本项目从提交到可用应用的时延。也不能把无原始链接的行业故事当作架构正确性的证明。

## 7. 建议的修复顺序和完成证据

**第一步：先让检查结果可信，固定使用一个已保存候选。**

1. 修视觉逐项错误边界，保存已完成 A/B 结果；用本文同样的入口级复现证明“一项 bad plan 不清掉另一项 passed”。保留取消和版本失效的拒绝语义。
2. 接通 resolver，补入口级验证；无 open 的程序在执行前报告 plan/setup 错误，不等到最后才发现。
3. 以实际计划重现并修正 scope、初态和步骤表达能力；独立场景隔离，持久化场景内部保留状态。B09/B30/B32 必须单跑、连跑一致。
4. 真正封存可执行验收合同。旧行为的 expected、判定字段、取值对象和 setup 要一致；允许定位适配，不等于允许正负断言随意翻转。编译失败是测试问题，不自动甩给 Builder。
5. 明确 required/optional 的通过语义，以及 blocked 应触发测试修复、恢复检查还是阻止发布。不能在关单时临时改变。

**第二步：再消除串行远程开销，测实际收益。**

1. 以相同 source/revision 和同一批断言对比现路径与沙箱内多步执行，测总命令数、浏览器执行时间、保存证据时间。先验证 3–5 个代表场景，再跑整套；无需每次重生成计算器。
2. 控制输入、精确结果、列表计数等走确定性断言；纯视觉项目集中取图、批量判定。数值是否正确不依赖模型逐键思考。
3. 重用已验证的旧行为程序，增量规划只新增/修改本次合法变化，减少大份 steps 重生成、长输出和语义漂移。
4. 用实际步骤数、远程调用和观察载荷评估成本，而不是“43 条可做、44 条拒绝”。必要的容量控制应覆盖总 run 和修复，不只放大 reviewer 上限。
5. 将统一 deadline 和真实 usage 接入上述整条调用链。运行失败仍保留可解释的分项结果，不把“按时失败”计为产品成功。

**第三步：用用户体验指标验收，再完成 #37。**

- 至少分别记录：首次可交互候选 Preview 时间、增量代码生效时间、required 验证完成时间、成功交付率。本文不承诺未经测量的“30 秒修好”或“必能两分钟通过”。
- 建议产品讨论以“分钟以内看到可交互增量、完整确认控制在几分钟内”为方向；具体门槛需基准数据和模型能力约束。用户已明确十分钟不足以接受。
- 如果先开放候选预览，应标明验证状态；不能提前写 accepted，也不能冒用旧证据。完整发布复核仍保留。此项是产品建议，本轮未修改状态语义。
- 先修引擎和错误测试，再确认生成应用的真实失败；[#41](https://github.com/hengworkinggit/pivloom/issues/41) 等历史作品缺陷不能凭本文全部宣布不存在。
- 最终冻结代码版本，执行 #37 的 C0→C1→C2→回滚 C1→C3、蛇 390px、全新登录恢复、两件作品长期发布链接与 Preview 回收核验。只重跑修复影响到的链路，完成后再更新 issue 和对齐三个 SHA。

## 8. 可复核命令与本轮边界

机制复现（运行时依赖仓库已安装的 tsx）：

```sh
node --import tsx /tmp/nano-atoms-runtime-diagnosis.mts
./node_modules/.bin/tsx /tmp/nano-atoms-diagnosis/browser-cost.mts
node --import tsx /tmp/nano-atoms-diagnosis/design-probe.mts
```

第一个应显示三项已确认问题：`visual-error-erases-passed-A-layer` 的 evidence 0、`runtime-resolver-not-forwarded` 的 resolverCalls 0、`A-layer-clock-budget-not-enforced` 的 injectedElapsedMs 601000 仍 passed。它们是“确实复现了错误”，不是已修复测试全绿。

第三个以 exit 1 报出五项已复现的契约失败：B09 误判、错误结果假通过、断言极性翻转被放行、B30 顺序依赖、B32 忠实步骤超限。脚本与原始计划位于临时目录；长期保留这些回归时应使用脱敏的最小 fixture，勿提交整份账户数据。

生产核心查询，可在只读事务执行：

```sql
SELECT role, attempt, state, started_at, finished_at,
       round(extract(epoch FROM(finished_at-started_at))/60, 2) AS minutes,
       usage_json
FROM nano.role_runs
WHERE run_id = '22b35a1d-01a0-4d51-bb64-6351feca48ef'
ORDER BY started_at;

SELECT created_at, payload_json
FROM nano.run_events
WHERE run_id = '22b35a1d-01a0-4d51-bb64-6351feca48ef'
  AND payload_json->>'toolName' = 'replay_error';

SELECT verdict, jsonb_array_length(items_json) AS items,
       jsonb_array_length(evidence_json) AS evidence
FROM nano.checks
WHERE run_id = '22b35a1d-01a0-4d51-bb64-6351feca48ef';
```

已有相关测试 4 个文件、56 项通过，仍漏掉上述真实入口错误；没有以此宣称完整发布门禁通过。未启动新一轮 30–40 分钟验收，未尝试恢复模型配额，未部署，未关闭 #37。在线版本核验与生产数据是本次实读，先前 C0/C1/C2/S0/登录/发布的历史 PASS 尚未在今天重新执行。

相关既有测试命令：

```sh
npx vitest run --root apps/api \
  tests/runtime/replay.test.ts \
  tests/runtime/replay-plan.test.ts \
  tests/runtime/reviewer-wall-clock.test.ts \
  tests/generation/replay-review.integration.test.ts
```

**诊断已完成，修复与当前冻结版本的正式验收仍待实施。**
