# 交接：评审分层改造（截至 main `80c749b`）

目的：把状态写死，任何人在任何时刻接手都能继续，不必重新勘察或猜测已完成到哪一步。

## 1. 已完成并验证（全部已在 `main`，已部署）

| 项 | 提交 | 验证证据 |
|---|---|---|
| P0 证据上限 256→4096 | `d9b56cb` | 修掉"42 条行为 × 多条观察 > 256 项 → ZodError → 笼统 GENERATION_FAILED"（曾一夜无法诊断） |
| P1 失败原因结构化 | `9fe37f3` + `014fccd` | 迁移 025/026；真实接口验证 `HTTP 200` 且字段存在。**第一版 025 漏了 `owner_id`/RLS/授权导致运行详情 500，372 个测试全绿也没抓到，是用真实账号拉真实失败运行才撞出** |
| A 计划可执行化 | `8b2cd14` | `steps`/`assertions`/`evidence` 可选加入；增量守卫只比 `id/required/precondition/action/expected`（加步骤不算语义变化，改期望仍拒绝）；schema↔prompt↔白名单三处一致性已核对；`z.toJSONSchema` 实测 5 KB 且含新字段 |
| B 脚本化回放 | `10220ae` | `replay.ts` + `replay-plan.ts` + 集成挂载；30 个自测；**零模型请求由"fetch 一被调用就 throw"的桩证明**；证据经**真实 `parseReviewEvidence`** round-trip；续期契约用**真实的** `createMeaningfulProgressGate()` 断言 |
| D 墙钟预算 | `603fd66` | 单调时钟；总上限 600s＝回放预留 120s＋模型判定 480s；快失败阈值 120s；**既有 113 个评审器测试一行未改**；反证：stash 掉改动后 3 个新行为测试恰好失败 |
| E 容量模型 | `209d4c0` | `capacity.ts` 影子模式；**5/14/41/45 实测包络表**；发现并修掉**第三层独立常量**（数据库 CHECK `006_review.sql:24`），迁移 027 已应用 |
| F 视觉探针 | `ab16fec` | 判据从"任一次通过"改为"两次一致"；**真实 API 复验 3/3 一致 `failed`** |
| 容量预检接线 | `80c749b` | 影子模式挂在 `review.ts` 的评审前，只记录不改变行为 |

**合并后 main 全量：436 通过 / 1 失败**（唯一失败是既有的 `tests/generation/network-proxy.test.ts` 环境性用例，与会话全程一致）。
**部署验证**：`80c749b` 构建、部署成功，**GitHub = API = Web 三处 SHA 对齐**，API ready 200。

## 2. 未完成

| 项 | 状态 | 位置 |
|---|---|---|
| **C 视觉批量判定** | 实施中（子代理运行中，尚无提交） | 工作树 `/Users/heng/Desktop/pivloom-wt/visual`，分支 `feat/visual-judgement`（基线 `209d4c0`） |
| **实测墙钟计时** | **未产出**（这是完成判据） | — |
| C3 + #37 正式验收 | 未开始（按用户要求，等改造完成） | — |

## 3. 必须知道的事实（否则会重犯错误）

1. **DeepSeek 官方 `deepseek-flash` 实际无法做视觉验收**。我一度报告它"三项能力 verified"，**那是错的**——探针原判据"任一次正确即通过"下，一个完全看不见图的模型单次靠猜命中率 1/16，三次采样约 18% 被误判通过；那次 `verified` 是猜中的。判据修正后连续三次真实测试全部 `failed`。
   **后果**：`supportsImages` 由 `capabilities.vision === "verified"` 决定（`executor.ts:176`），vision 为 failed 时模型拿不到图片，而发布门禁要求通过项具备已投递图片证据 → **正式验收前必须切回一个 vision 已验证的模型**（火山方舟，周配额 2026-09-27 16:00 UTC 重置）。
   **这也是 C 层必须 fail-closed 的具体理由**：看不见图的模型只能产出 `blocked`，绝不能产出 `passed`。

2. **A 层是否真被触发，是最大未验证假设**。若协调者产不出带 `steps` 的计划，A 层编译不出程序，**一点都不会变快**。只能由一次真实运行回答，不能推理。

3. **C 未落地前，真实计划会整单退回模型路径**：只要有一条行为不可编译（含视觉行为），B 的设计就是整单退回 → 30 分钟。真实应用计划必有外观类行为，所以 **C 是 10 分钟底线的必需项，不是优化**。

4. **E 的包络表结论**（估算＋逐字节序列化验证，**不是计时**）：41 条行为评审工具需 331 > 328、运行级账本需 407 > 384；45 条为 363 > 360、439 > 384。**超出额恰是代码公式漏掉的 3 次固定调用**（bootstrap 2 ＋ submit 1）。旧的 256 条证据上限在 45 条时需 315 条 → **必然溢出**，与 C3 事故吻合。41 条时 Builder 最多只能用 41 次、45 条只剩 9 次。

5. **测试纪律**（本轮所有工作流都遵守了，继续遵守）：**不得为变绿批量修改既有期望**。D 的证据是"既有 113 个测试一行未改 ＋ stash 后新测试恰好失败"。E 的证据是"fail-without-change 实测：改回 `512*1024` 后 2/5 失败"。

## 4. C 层设计要点（详见 `docs/specs/replay-recon-2026-09-26.md` §11）

取 `evidence === "visual"` 的行为 + **A 层已捕获的截图**，**一次结构化请求、不发工具、不让模型操作浏览器**，要求按行为返回 verdict；与 A 的 verdict 合并后**照常走 `assertReviewerResult` 与 `finishReview`**。

三条红线：**模型只判定不驱动**；**判定必须引用实际所见内容**（数值/位置/颜色/文本），无引用即 `blocked`；**既不可编译又非视觉的行为仍走完整 `runReviewer`**，五组检查一字不改。

合并前必查：`budgets.ts` 与 `review.ts` 是多方修改点，**逐块判定，不靠"应该没事"**。

## 5. 下一步（按序）

1. C 提交后：独立验证（类型检查 + 全量套件 + 我自己跑一遍它的测试，不只读报告）→ 逐块判定合并 → 合入 main → 重新部署对齐 SHA。
2. 触发**一次真实运行**，同时回答两个问题：**协调者会不会产出可执行步骤**、**A+B 真实墙钟是多少**。度量口径：从 `nano.run_events` 按阶段取 `min/max(created_at)`（本次会话已用此法测出过 30 分钟）。关注事件：`replay_fallback`（退回比例）、`toolName='browser_steps'` 的 `tool.completed`（A 层程序数）、以及 `review_wall_clock`（预算停止）。
3. **≤10 分钟不达标就继续改**，不达标不得报完成；达标后再执行 C3 + #37 全矩阵，三处 SHA 对齐后关单。

## 6. 运行环境要点

- SSH 隧道：`sshpass -e ssh -o ControlPath=/tmp/pivloom-ssh-%r@%h:%p -f -N -L 15432:127.0.0.1:54322 -L 15433:127.0.0.1:54321 root@69.5.7.187`（`SSHPASS` 见会话；**隧道断了登录会失败**，曾导致整夜验证没提交）。
- 迁移：`node --env-file=.cache/prod/tunnel.env --import tsx apps/api/scripts/supabase/manage.ts migrate --environment-id pivloom-dev-e6d33625ef2b`（已应用 001–027）。
- 构建部署在 `/tmp/pivloom-build`（独立检出，避免与工作树冲突）。
- 诊断优先**单条 SSH 命令在服务器就地执行**，不要长期维持隧道。

## 7. C 层接线：下一批的精确设计（含一个必须绕开的契约约束）

**已完成**：`apps/api/src/runtime/visual-judgement.ts` + 5 个测试（提交 `84e89a6`，分支 `feat/visual-judgement`，工作树 `/Users/heng/Desktop/pivloom-wt/visual`）。它只做判定：输入行为（含已捕获图片）、注入的 `request`、`deadlineMs` 与可注入 `now`，返回每条行为的 verdict；**不持有 provider 客户端**；fail-closed（可解析＋有条目＋citation 非空且非 `expected` 复述＋有图，才可能 `passed`；超预算不发请求且答案迟到也算超预算）。

**接线时必须绕开的一个约束**：B 的测试钉住了 `compilePlan` 的契约——`evidence:"visual"` 的行为进 `uncompilable(reason='visual-evidence')`，**其 steps 从未被执行、因此没有任何截图**。`runScriptedPlan`（`replay-plan.ts:174-179`）目前在 `uncompilable.length > 0` 时整单退回。**不要改这个契约**（改它会破坏 B 测试所守的东西，而退回比例是可观测指标）。正确做法是：

1. **单独**把视觉行为的 steps 编译成程序（`compilePlan` 已给出 `steps` 形状，可复用 `replayStep` 归一化），**不放进** `uncompilable` 的处理路径；
2. 用 `runReplayProgram`（`replay.ts:188`）驱动这些程序并执行 `capture`，把 base64 留在内存（`StoredArtifact` 不含 base64，见 `storage/artifacts.ts`）；
3. 调 `judgeVisualBehaviours(...)`，`deadlineMs` 取 `REVIEW_WALL_CLOCK_BUDGET_MS` 的剩余份额；
4. 把视觉项与脚本项**合并进同一份 items**：内核 `blocked` 的项**不得被上调**为 passed；只有脚本部分通过时才采信模型判定；
5. 组装同一个 `ReviewerResult`，经 `markReviewerResultVerified` + `assertReviewerResult`，**照常过 `finishReview` 的 6 条硬要求**；
6. **仅当** `uncompilable` 里**没有非视觉原因**时才走判定；否则原样整单退回 `runReviewer`（五组不动）。

**必须补的两条集成用例**：
- **有能力的桩模型**（引用真实录到的内容）→ 视觉行为 `passed`，且整单**通过 `finishReview`**。**这一条与"看不见就 blocked"同等重要**，否则这层会退化成"永远 blocked"、加速为零却看起来安全；
- **判定超时** → 该批 `blocked`，且总耗时不越过 `REVIEW_WALL_CLOCK_BUDGET_MS`（480s）与 `VERIFICATION_WALL_CLOCK_LIMIT_MS`（600s），用注入时钟钉住。

**合并注意**：`review.ts` 同时有我加的影子模式容量预检（`preflightCapacity`）与 B 的挂载逻辑，改动位置不同，**逐块核对，不要整文件覆盖**。

**现实预期**：当前默认模型 `deepseek-flash` 读不出图（视觉探针实测 `failed`），所以**真实运行里视觉行为会 blocked、整单不通过**——这是诚实结论而非缺陷。要让视觉计划真正通过，必须把默认配置切回一个 vision 已验证的模型（火山方舟，周配额 2026-09-27 16:00 UTC 重置）。
