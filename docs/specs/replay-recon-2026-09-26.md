# 勘察：评审器脚本化回放落点（只读勘察结论，代码依据）

对象：`/Users/heng/Desktop/nano-Atoms`，HEAD `216dda7`。
目的：把单次增量验收从 30+ 分钟压到 **≤10 分钟**（用户硬底线）。本文只记录**代码事实**与落点，不含未验证推测。

## 1. 循环位置

唯一驱动循环：`runReviewer` — `apps/api/src/runtime/reviewer.ts:207`。

| 位置 | 内容 |
|---|---|
| `reviewer.ts:142-168` | 19 个工具的参数 schema（`browser_*`、`observation_read`、`record_behavior`、`submit_review` 等） |
| `reviewer.ts:424-714` | `tools` 的 `execute` — **模型 tool call 的唯一执行点** |
| `reviewer.ts:716` | `createAgentSession({…})` — Pi SDK 接管模型循环 |
| `reviewer.ts:719` | `session.agent.streamFunction` — 每次模型请求的挂钩 |
| `reviewer.ts:779` | `shouldStopAfterTurn` — 有 decision 或 `toolCount>=maxTools` 才停 |
| `reviewer.ts:805` / `:809` | 首轮请求（把整个 plan 作为 JSON 交给模型）/ 唯一一次纠正轮 |

## 2. 往返成本来源（每行为 2–3 次模型请求）

生产路径未传 `requireVisionEvidence`（`apps/api/src/generation/review.ts:111-112`），因此图片门控生效 → **每行为 3 轮**：动作 → 截图 → 记录。41 行为 ≈ 124 轮 + open + 纠正轮。

测试里写死的锚点：`reviewer.test.ts:1230` 断言 21 个行为 = `calls:64`（1+21×3）；`reviewer.test.ts:118` 用 `browser_steps` 批量后 2 个行为仅 `calls:3`。

**每一轮被迫产生的原因**：

1. **每步必须引用上一轮返回的 `latestObservationId`**（`reviewer.ts:675-676` 的 `STALE_BROWSER_REF` 校验）；ref 是不透明序号 `e\d+`，模型必须读到上一轮观察文本才能决定下一击点。
2. **截图必须"下一轮才作数"**（`reviewer.ts:730-738` 统计图片字节是否出现在后续请求体中），所以"截图"与"据此判定"不能同轮。
3. **`record_behavior` 需独立一轮**（动作证据必须指向本行为的真实观察）。
4. **`submit_review` 必须单独一轮且覆盖全部行为**（`reviewer.ts:450-456` + `reportProblem`）。

**脚本能接手的部分**：role+name→ref 解析（`reviewer.ts:529-531` 已是纯查表）、步骤顺序（`:518-552` 已是 for 循环）、截图时机、期望断言求值、stale-ref 重试。

## 3. 计划不可执行（P3 的前置改造）

`packages/contracts/src/planning.ts:19-23`：

```ts
export const BehaviorTargetSchema = z.strictObject({
  id: z.string().regex(/^B(?:0[1-9]|[1-9]\d)$/),
  title: nonempty(120), precondition: nonempty(500), action: nonempty(500), expected: nonempty(500), required: z.boolean(),
});
```

**没有任何 steps/selectors/assertions 字段**。而协调者 system prompt（`apps/api/src/runtime/coordinator.ts:175-178`）明确要求 "Write acceptance steps using those capabilities"、"Keep the plan executable by one independent Reviewer"——**要求了可执行步骤，但 schema 里没有承载它的字段**。

已存在的可执行步骤形状（评审器运行时工具参数，`reviewer.ts:132-140`）：`{ observationId, ref:/^e\d+$/, behaviorId }` + `reviewStep` discriminated union（`click/fill/select/press/wait`，带 `behaviorIds` 与 `capture`）。**这是应当提升进 plan schema 的最小形状。**

同步必须修改处（否则增量会坏）：
1. `planning.ts:105-113` 的 `sameObservableBehavior` 目前只比 `id/required/precondition/action/expected`；新增字段若不处理，旧行为会被判为语义变化 → `preservesPreviousBehavior` 拒绝增量计划。
2. `planning.ts:66` 的 64 KiB 计划上限、`HandoffSchema` 的 160 KiB 上限需为 steps 留空间。
3. `coordinator.ts:46` 的 `schemaFields` 白名单需加新字段名。

## 4. 浏览器原语（已是纯 async，无模型）

`ReviewBrowser` 接口：`reviewer.ts:85-95`；实现 `RemoteBrowser`：`apps/api/src/runtime/browser.ts:69`。
`open`/`observe`/`resize`/`act`/`keyBatch`/`logs`/`screenshot`/`close` 全部与模型无关；`browser.test.ts`（31 个测试）直接调用它们断言 CLI 参数。

已有的一次通过式执行内核：`reviewer.ts:518-552`（`browser_steps` 的 for 循环，每步 `:529` 重新解析 role+name→ref，不唯一即抛 `STALE_BROWSER_REF`）。

**结论：回放器不需要新写执行引擎，是把这段提出来复用。**

## 5. 证据门控

- 图片门控：`reviewer.ts:374-383`（`IMAGE_EVIDENCE_REQUIRED`）；`imageDelivered` 在 `:239` 声明、`:738` 填充。
- 渲染证据谓词：`packages/contracts/src/review.ts:28-46` `allowsRenderOnlyEvidence`（读散文 `action` 的正则启发式），使用点 `reviewer.ts:372` 与 `data/generation.ts:965`。
- **`requiresVisualEvidence` 在本检出中不存在**（全仓零命中）；B 层谓词需新写或从分支 `feat/44-text-evidence` 合入。
- 发布门禁：`data/generation.ts:916 finishReview`，`:960-970` 校验动作/渲染证据与目标一致性，`:993`/`:998-1000` 才把 revision 置 `accepted` 并推进 `current_revision_id`。**A/B 层必须产出同形状证据才能通过。**

## 6. 限额清单与两个真实缺陷

`apps/api/src/runtime/budgets.ts`：`RUN_IDLE_TIMEOUT_MS=360_000`（滚动无进展）、`MODEL_REQUEST_TIMEOUT_MS=210_000`、`RUN_TOOL_LIMIT=384`、`REVIEW_TOOL_LIMIT=280`、`REVIEW_TOOL_CALLS_PER_BEHAVIOR=8`、`REVIEW_TOOL_LIMIT_CEILING=600`、`REVIEW_EVIDENCE_LIMIT_BYTES=2 MiB`、`DAILY_ACCEPTED_LIMIT=20`。

`browser.ts:414` 每次浏览器动作 15 秒上限；`reviewer.ts:233-235` 41 行为→`maxTools=328`；`data/generation.ts:257` `REVIEW_EVIDENCE_LIMIT=4096` 条。

**缺陷 A：验收没有任何总墙钟上限。** `reviewer.ts:25-28` 注释即官方声明：*"Reviewer progress has no cumulative wall-clock ceiling; the owning Run watchdog handles inactivity."* `RUN_TIMEOUT` 只来自 `progress-watchdog.ts:52-70` 的滚动 inactivity，工具一成功就续期 → 只要模型在动就能跑到 40 分钟。**`REVIEW_TIMEOUT` 在 `reviewer.ts:253-254` 已被识别，生产代码中从未设置**（仅 4 处测试引用）——**这是 10 分钟上限的现成挂点**。

**缺陷 B：证据上限两处不一致。** 评审器内部允许 2 MiB（`reviewer.ts:284`），持久化只允许 512 KiB（`data/generation.ts:924` `boundedJson({ evidence }, 512 * 1024)`）。脚本化回放一次通过产生更多观察，**可能在评审器内合格、到落库被 `EVENT_TOO_LARGE` 拒绝**。

**风险 C（实现前必须解决）**：A 层不产生模型事件，`progress-watchdog.ts:20-27` 的 `meaningfullyCompletedTools` 可能不续期 → A 层运行期间会被 `RUN_TIMEOUT` 误杀。

## 7. 测试影响面

`apps/api/tests/runtime/reviewer.test.ts`（1547 行，68 个 test）主导风格是**用 `setup(turn)` 脚本化模型每一轮并断言精确模型请求数**（harness 在 `:28-52`）：

- 64/68 调用 `runReviewer`；53/68 断言 `stats()`；**37/68 把 `calls:N` 写死**；63/68 使用逐轮脚本。
- 不依赖循环的仅 4 个（`:12`、`:18`、`:946`、`:1233`）。
- 机制变更会直接打碎那 37 个；`:1200-1231`（21 行为 / `calls:64`）最具代表性。

其他：`browser.test.ts` 31 个（**可原样复用，不需改**）；`review.integration.test.ts` 9 个默认跳过（`PIVLOOM_REVIEW_INTEGRATION=1` 才跑）——**是发布门禁契约测试，必须保持全绿**；`apps/web/src/lib/review-api.test.ts` 3 个关心 wire schema。

## 8. 落点建议（已被采纳的方向）

| 模块 | 作用 |
|---|---|
| `apps/api/src/runtime/replay.ts` | 从 `reviewer.ts:518-552` 抽出执行内核，无模型 |
| `apps/api/src/runtime/replay-plan.ts` | `compilePlan`（可编译/退回分流）、`runPrograms`、断言求值器 |
| `apps/api/src/runtime/budgets.ts` | 新增墙钟上限常量（A/B 分层） |
| `packages/contracts/src/planning.ts` | `BehaviorTargetSchema` 增 `steps`/`assertions`/`evidence`；同步 `sameObservableBehavior` 与体积上限 |
| `apps/api/src/runtime/coordinator.ts` | prompt 与 `schemaFields` 改为要求结构化 steps |

挂载点：`apps/api/src/generation/review.ts` 的 `runReview`（`:96`），在 `:111 await runReviewer({…})` 之前插入 A 层，产出与 `ReviewerResult` 同形状的结果，再走既有的 `finishReview`。

**必须保留给 C 层（发布门禁）不动**：`runReviewer` 全路径、`finishReview`、`assertReviewerResult`/`assertVerifiedReviewReceipt`、`allowsRenderOnlyEvidence` 与图片门控、`RemoteBrowser` 作为唯一浏览器 seam。

## 9. 尚需产品确认

10 分钟墙钟卡在"A+B 层（验证）"还是"整个 run（生成约 10 分钟 + 验证）"——代码里无定义，spec §3.2 只写"验收阶段设墙上限"。**当前按 A+B 层 ≤10 分钟理解，并另行报告整个 run 的实测耗时。**

## 10. 第 9 条风险（watchdog 续期）已查清：可解，且有精确做法

**续期条件（`apps/api/src/data/generation.ts:699-726` `appendEvent`）**：只有 `progress: true` 的事件才续期，且必须同时满足

1. 事件**可信**：`type === "tool.completed" && payload.success === true`（或 `model_stream` 且 success，或 bounded provider retry）；
2. **有真实且匹配的 `roleRunId`**：服务端查出对应 `role_runs` 行并跑 `assertRole`；
3. 通过后才执行 `UPDATE nano.runs SET deadline_at = greatest(deadline_at, now() + RUN_IDLE_TIMEOUT_MS)`（6 分钟，`budgets.ts:15`）。

**门（`apps/api/src/runtime/../progress-watchdog.ts:20-27`）**：`event.type === 'tool.end' && event.success === true && meaningfullyCompletedTools.has(event.toolName)`；白名单**已包含 `browser_steps`**。

**结论：A 层不会被误杀，但必须主动续期。** 做法：A 层按**程序分段**发出可信进展事件——`tool.completed`、`success: true`、`roleRunId` 为当次评审的 reviewer 角色运行、`toolName: "browser_steps"`。这不是伪造进展：A 层执行的正是与 `browser_steps` 同类的一步程序。

**两个必须注意的约束**：

- 间隔必须**小于 `RUN_IDLE_TIMEOUT_MS`（6 分钟）**；A+B 合计上限 10 分钟 > 6 分钟，所以不能只在开始时发一次。
- `roleRunId` 必须是**该 attempt 的活动 reviewer 角色运行**，否则 `assertRole` 抛 `STALE_ROLE`，续期失败变成错误。

## 11. B 层（视觉批量判定）设计，按 B 已暴露的接口写定

B 工作流（分支 `feat/scripted-replay`）已确定 A 层接口，C 层据此实现，**不需要再造一套**：

- `compilePlan(plan) → { programs, uncompilable }`（`apps/api/src/runtime/replay-plan.ts:36`）
- `ReplayFallbackReason = 'missing-steps' | 'missing-assertions' | 'visual-evidence'`（`:20`）
- `requiresVisualJudgement(behavior) → behavior.evidence === 'visual'`（`:63`）——**C 层的分流依据就是它**
- `runPrograms(...) → ReplayProgramsResult`（`:95`）、`runScriptedPlan(...) → ScriptedPlanOutcome`（`:139`）

**C 层职责（仅此三项，不扩张）**：

1. **输入**：A 层跑完后，取 `requiresVisualJudgement` 为真的行为，连同 A 层已捕获的对应截图产物（capture 步骤产生的 artifact）与该行为的 `expected`。**不重新打开浏览器、不驱动任何步骤。**
2. **与模型的一次交互**：**不发工具、不让模型操作浏览器**——一次结构化请求，把"期望结果 + 对应图片"交给模型，要求按行为返回 `passed` / `failed` / `blocked` 与一句理由。批量进行（多个视觉行为合并到尽量少的请求里），并且**总请求数受 D 项剩余墙钟预算约束**。
3. **产出**：与 A 层 verdict 合并成同一份 items，**照常经过 `assertReviewerResult` 与 `finishReview`**。因此必须满足第 10 节那份门禁清单：`item.expected` 与计划严格相等、observation 真实落库、artifact 键精确为 `${ownerId}/${projectId}/${snapshotId}/checks/${artifactId}.png`、非 blocked 项须有真实动作证据或满足渲染证据。

**三条红线**：

- **模型只判定，不驱动**——这是 10 分钟底线得以成立的原因；一旦让模型开始点浏览器，往返成本立刻回到 30 分钟量级。
- **视觉判定不得被降级为"看起来没问题就通过"**：模型必须给出理由，且理由要引用它实际看到的内容（例如具体颜色/位置/数值），否则该行为按 `blocked` 处理，不得算通过。
- **既不可编译、又非视觉的行为，仍走完整 `runReviewer`（C 层发布门禁）**，且五组检查一字不改。B 层是加速路径，不是替代品。

**合并顺序**：C 与 B 改同一批文件（`review.ts`、`replay-plan.ts`），因此 **C 必须在 B 落地后于同一个工作树 `pivloom-wt/replay` 上进行**，避免又一次文件与分支争用。
