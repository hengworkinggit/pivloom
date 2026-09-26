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

### 7.1 第二块已完成（取图），以及下一块必须先处理的陷阱

**已完成**：`84e89a6`（判定模块）＋ `3a0abbc`（取图函数 `captureVisualPrograms`，分支 `feat/visual-judgement`，工作树 `pivloom-wt/visual`）。取图函数**只为 `evidence:'visual'` 且带 steps 的行为**驱动内核并真正执行 `capture`，base64 留在内存（`StoredArtifact` 不含像素），**不接 modelConfig、不 import provider 客户端**；无 steps 的视觉行为**跳过而不抛错**。验证：类型检查干净、全量 **444 通过**（唯一失败是既有 network-proxy 环境性用例）。返回项另带 `evidence` 与 `artifacts`，供下一块合并时解析真正落库的证据/工件 id。

**下一块必须先处理的两个陷阱**（实测确认，不是推测）：

1. **`replay-plan.ts:152` 的早退会吃掉全视觉计划**：`if (compiled.programs.length === 0) return { kind:'fallback' … }`——若计划**全部**是视觉行为，`programs` 为空，会在任何视觉逻辑之前直接整单退回。**只改 174 行那个 `uncompilable.length > 0` 分支不够**，必须同时处理这里。
2. **`uncompilable` 的原因顺序**：`missing-steps` / `missing-assertions` 先于 visual 判定，因此理由为 `visual-evidence` 的行为**必定**带 steps 与 assertions，合并时可直接断言这一点（不必再判空）。

**仍未做**：把取图与判定接进 `runScriptedPlan`（仅当 `uncompilable` 全为视觉原因时）、在 `review.ts` 构造注入的 `request`、以及两条集成用例（有能力的桩模型 → passed 且过 `finishReview`；超时 → blocked 且不越 480s/600s）。**在这一块完成前，真实应用计划仍会整单退回模型路径，10 分钟底线尚未在真实计划上达成。**

## 8. 改造已全部合入部署；真实测量被两个外部条件挡住

**已完成并部署**：main `9d086f9`，三处 SHA 对齐，API ready 200。合并后全量 **451 通过**（唯一失败是既有的 network-proxy 环境性用例）。A/B/C/D/E/F 六项全部在 main 上。

**但真实运行现在起不来**，实测提交返回：

```
422 MODEL_VISION_NOT_VERIFIED
```

**根因不是代码缺陷，是既有的前置门**（`apps/api/src/models/service.ts:120-122`）：租用凭据时若 `capabilities.vision !== "verified"` 直接拒绝该运行。于是：

1. 默认配置被切到 DeepSeek 官方 `deepseek-flash`；
2. 而它**读不出图已被证实**（判据修正后真实测试 3/3 `failed`，此前那次 `verified` 是瞎猜命中）；
3. 平台**本来就不允许**视觉未验证的模型跑任务 → **任何真实运行都起不来**。

**这暴露了我此前的一个理解错误**：我把该门当成"开关"，**它同时是运行的前置条件**。也说明"把默认配置切到 DeepSeek"这个动作本身是错的。

### 要拿到两个真实数字，需要一个 vision 已验证的模型

| 路径 | 状态 |
|---|---|
| 火山方舟（此前承担 C3 评审，视觉应已验证） | 周配额 **2026-09-27 16:00 UTC** 重置（距当时约 36 小时） |
| DeepSeek flash / v4-pro | 实测读不出图，**不能**用于视觉验收 |
| 其它提供方 | 需要当前手上没有的凭据 |

**因此测量被外部资源挡住，近期不可能产出。** 不得用估算或模拟替代。

### 值得产品决策的一处张力（我没有擅自改）

该前置门**对所有运行生效**，包括**完全没有视觉行为、本可由 A 层零模型跑完的计划**。也就是说：**只要模型视觉未验证，连不需要看图的确定性验证也跑不了**。这与"A 层不需要模型"的设计存在张力。放宽它属于**安全相关的产品决策**（该门存在的理由正是防止瞎模型跑出假通过），**我不单方面改**，在此记录并留给决策。

### 仍在的代码遗留（可做）

1. **判定预算用满额而非剩余份额**（`apps/api/src/runtime/replay-plan.ts:214` 的 `deadlineMs: REVIEW_WALL_CLOCK_BUDGET_MS`），函数内无 elapsed 测量 → 脚本段耗时后判定仍获全新 480s，两者相加可越过 600s 验收上限。执行者明确说明它写的预算用例**覆盖不到**这一点。
2. 次要：判定确实发了一次请求，组装结果仍用 `zeroUsage()`，用量台账少记一次。

### 两个真实数字（完成判据，未变）

1. **真实沙箱上 A+B 的实测墙钟**（≤10 分钟才算达标）；
2. **协调者是否确实产出可执行步骤**（不产出则 A 层编译不出程序、加速为零）。

## 9. 一个我必须如实记录的验证缺口：门禁契约测试从未真正跑过

目标里写明 `apps/api/tests/generation/review.integration.test.ts`（9 个，发布门禁契约测试）**必须保持全绿**。实际情况：

- 默认跳过（`describe.skipIf(PIVLOOM_REVIEW_INTEGRATION !== "1")`）；
- 我尝试用 `PIVLOOM_REVIEW_INTEGRATION=1` 跑，**它拒绝运行**：

```
Error: Review fixtures require an isolated e2e database
   if (!databaseName.startsWith("pivloom_e2e_test_")) throw Error(...)
```

**这个拒绝是正确的安全设计**（不会拿开发库当测试库），但后果是：**这 9 个测试在本会话中从未真正执行过**，我此前说的"保持全绿"**实际上只是"保持未被破坏／处于跳过状态"**。这是措辞上的夸大，我在此更正。

**要真正验证它们**，需要一个隔离的 `pivloom_e2e_test_*` 数据库的准备脚本或流程；本检出中未找到（早前交接信息提到的 `tests/testing/prepare-ci-database.mjs` 在此工作树不存在）。**在这一步补上之前，发布门禁的契约验证属于"未运行"，不是"通过"。**

同样地，A/C 层产出的证据**是否真能通过真实的 `finishReview`**（DB 门 + artifact 存储 + RLS），目前只由桩测试**逐条断言那些条件**来覆盖，**不是真的走了一遍 `finishReview`**——执行者已如实说明过这一点，我确认属实。

### 9.1 尝试补齐这一缺口：失败，且失败原因不可见

我尝试建立隔离库以真正运行那 9 个门禁契约测试：

1. `CREATE DATABASE pivloom_e2e_test_review` —— **成功**；
2. 用改写后的环境文件（把 `DATABASE_URL` 与 `MIGRATION_DATABASE_URL` 都指向该库）运行 `manage.ts migrate` —— **失败**，且只得到一句刻意通用的 `维护操作失败；未输出连接或凭据详情。`；
3. 因此测试仍**未能运行**；已把该库 `DROP` 掉，不在环境里留垃圾。

**结论**：补齐这一缺口需要一套**有文档的隔离 e2e 库准备流程**（早前交接信息提到的脚本在本工作树不存在），**不是临时敲几条命令能补上的**。我不把它记为"通过"，也不假装它被绕过。

## 10. 配额重置后的执行手册（开箱即用，无需再勘察）

**触发条件**：`2026-09-27 16:00 UTC` 之后（火山方舟周配额重置）。

**当前 A 账号的配置状态（实测）**：

| profile | 版本 | 模型 | vision | 是否默认 |
|---|---|---|---|---|
| `36aa8e40` | v4 | `deepseek-flash`（DeepSeek 官方） | **failed** | **默认** ← 必须换掉 |
| `ea2e0acf` | v2 | `kimi-k2.7-code`（火山方舟） | **verified** | 否 |

**即：vision 已验证的配置本来就在，只是被顶掉了默认位**——不需要新建凭据。

### 步骤 1：把默认配置换回 vision 已验证的那条

用应用自己的接口（与用户在工作台里点"设为默认"等价，不要直接改库）：

```
# 以 A 账号登录后
PATCH /api/v1/model-profiles/ea2e0acf-...  { "isDefault": true }
```

脚本化做法见 `.cache/rc-helpers/`（此前用 `createClient` 登录 + `fetch` 调 PATCH 的方式已成功过一次；注意 `SUPABASE_URL` 走隧道 `127.0.0.1:15433`，**隧道断则登录失败**——曾因此让整夜验证没提交）。

### 步骤 2：先跑一次能力测试确认它仍然 verified

```
POST /api/v1/model-profiles/ea2e0acf-.../test
```

**注意**：探针已被我改成"需要两次答案一致"（`ab16fec`）。若它现在报 `vision: failed`，**不要**再用"多试几次"绕过——那正是我修掉的错误判据（单次命中靠猜）。此时应改用另一个 vision 已验证的配置，或按 §8 记录的产品决策处理。

### 步骤 3：提交真实运行并取两个数字

```
node .cache/rc-helpers/submit-retry.mjs 13dcc301-e8a4-4e14-bbe2-a8757b4d76d7 C3 e5c126e0-838b-4d94-adc0-c5bff8b4c333
```

**数字①：A+B 实测墙钟**（完成判据）。口径：按阶段取事件时间跨度（本会话已用此法测出过 30 分钟与 0 分钟两种情形）：

```sql
SELECT date_trunc('minute', min(created_at)) AS start, max(created_at) AS finish,
       round(extract(epoch FROM (max(created_at) - min(created_at)))/60, 1) AS minutes
FROM nano.run_events WHERE run_id='<run>';
```

**数字②：协调者是否确实产出可执行步骤**（全设计最大的未验证假设）：

```sql
SELECT jsonb_array_length(plan_json->'behaviors') AS behaviors,
       (SELECT count(*) FROM jsonb_array_elements(plan_json->'behaviors') b WHERE b ? 'steps') AS with_steps
FROM nano.runs WHERE id='<run>';
```

**退回比例与 A 层是否真的跑了**（决定加速是否真实）：

```sql
SELECT type, payload_json->>'toolName' AS tool, payload_json->>'message' AS message
FROM nano.run_events WHERE run_id='<run>'
  AND (payload_json->>'toolName' IN ('replay_fallback','browser_steps','review_wall_clock')
       OR payload_json->>'message' LIKE '%脚本回放%')
ORDER BY created_at;
```

**判定**：
- `with_steps = 0` → **A 层是死代码**，协调者没有产出可执行步骤，加速为零——**这是必须优先解决的设计问题，不是调参问题**；
- `replay_fallback` 出现且原因含 `missing-steps` → 同上（写了散文但没写步骤）；
- 出现 `review_wall_clock` → 预算停止（说明 10 分钟上限被触发，运行未超限但也没完成，需看是哪一层吃掉了预算）；
- **A+B 实测 ≤10 分钟才达标**；超过就继续改，**不得用估算替代**。

### 步骤 4：达标后才做 C3 + #37 验收

按目标原文执行冻结主线的 C0→C1→C2→回滚 C1→C3 与 390px 贪吃蛇 S0，最终确认三处 SHA 一致后关单。

### 仍未解决的验证缺口（不属外部阻塞，需要工程投入）

**9 个门禁契约测试从未真正运行**（§9）：需要一个**有文档的隔离 e2e 库准备流程**。我试过 `CREATE DATABASE pivloom_e2e_test_review` + 迁移，迁移以刻意通用的错误失败（§9.1），未找到根因。**在这一步补齐前，发布门禁的契约验证是"未运行"，不是"通过"。**
