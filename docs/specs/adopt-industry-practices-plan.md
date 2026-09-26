# 复刻业界最佳实践：逐条执行清单

依据：`docs/specs/verification-calibration-research-2026-09-26.md`（十二节调研，均附官方出处）。
所有者指示：**不再自创设计，直接采用业界最佳实现与最佳实践**。

每条都写明：**抄谁 / 抄什么 / 落到哪 / 影响哪些测试 / 状态**。
状态标记：`进行中` / `待办` / `已完成`。

---

## 批次一：回放内核对齐（进行中）

### 1.1 取消"截断 ⇒ 否决整页"
- **抄谁**：Playwright MCP——ref 失效只报 `Ref <ref> not found in the current page snapshot. Try capturing new snapshot.`，**只废该次调用**
- **抄什么**：截断不再阻止控件解析；只有真正无法唯一解析的那一个动作失败
- **落到哪**：`apps/api/src/runtime/replay.ts`（约 :247 的 `truncated` 前置抛错）、`apps/api/src/runtime/reviewer.ts`（约 :604 的 `latestRefsComplete` 前置抛错）
- **测试影响**：`an incomplete observation stops a control step instead of resolving refs from a partial tree`（钉旧规则，需按新语义改写）；`large observations declare truncation and expose only bounded valid refs visible in their tree`
- **保持**：`a stale control during the scripted pass is reported as STALE_BROWSER_REF, not a blocked candidate`——真正解析不到仍必须报 `STALE_BROWSER_REF`，不得降级成 blocked
- **状态**：进行中

### 1.2 失败后先重新观察一次再判定
- **抄谁**：Chrome DevTools MCP——"Always use the latest snapshot"；"If an element isn't found, take a fresh snapshot – the element may have been removed or the page changed."
- **抄什么**：解析失败 → 重新观察 → 重试一次；仍失败才报错。**重试次数显式且有上限**
- **落到哪**：同 1.1
- **状态**：进行中

### 1.3 名称匹配按 Playwright 默认
- **抄谁**：Playwright `getByRole`——"By default, matching is case-insensitive and searches for a substring, use `exact` to control this behavior."
- **抄什么**：默认**大小写不敏感 + 子串**（trim 空白）；需要精确时显式开 `exact`；**唯一性要求保留**（strict mode）
- **落到哪**：`resolveControl`（`apps/api/src/runtime/replay.ts`、`reviewer.ts`）
- **状态**：进行中

### 1.4 截断显式告知
- **抄谁**：browser-use——超出上限时在提示里追加 `" (truncated to 40000 characters)"`
- **抄什么**：截断写成给上层/模型的**明确标记**，而不是布尔否决
- **落到哪**：`apps/api/src/runtime/browser.ts`、`replay.ts`
- **状态**：进行中

### 1.5 refs 表与树文本解耦
- **抄谁**：Vercel agent-browser PR #1444——ref 绑**位置编号**会在 DOM 变化后**静默点错元素并返回成功**；必须绑**节点身份**
- **抄什么**：`!treeRefs.has(key)` 不再单独把整份观察判为不可信（refs 是浏览器权威控件清单，树文本只是证据文本）；**refs 超上限、元数据被截断这两支保留**为不可信信号
- **落到哪**：`apps/api/src/runtime/browser.ts`
- **测试影响**：`a longer ref or non-ref attribute cannot grant membership to an absent ref`
- **状态**：进行中

---

## 批次二：报告与度量（待办）

### 2.1 作用域定位（解决"同名多个控件"的通用解法）
- **抄谁**：Playwright——先定位容器再定位控件：
  `page.getByRole('row').filter({ hasText: 'Product 2' }).getByRole('button', { name: 'Add to cart' })`
- **抄什么**：步骤能表达**作用域**（容器 + 文本），从而**不要求应用把名字改成全局唯一**
- **落到哪**：`packages/contracts/src/planning.ts`（步骤 schema 增可选 scope）、`replay.ts` 解析逻辑、协调者 prompt
- **为什么重要**：本会话我为了让验收通过，让应用把可访问名称改成全局唯一——**方向反了**。通用应用必须支持作用域。
- **状态**：待办

### 2.2 逐条状态（可聚合出"确定性覆盖率"）
- **抄谁**：Stagehand——逐次 `metadata.cache.status=HIT/MISS/DISABLED`、`missReason`、省下 token；Shortest——`passedFromCache` / `executedFromCache`
- **抄什么**：命中/未命中/原因作为**逐条字段**暴露（我们已有 `replay_fallback` 事件，需补"未命中原因"并使其可聚合）
- **落到哪**：`replay_fallback` 事件载荷、`capacity.ts` 相邻处或新模块
- **注意**：五家同类工具**都没有**"回退率"命名指标；先做**可观测与可聚合**，不先给承诺
- **状态**：待办

### 2.3 三态措辞 + 工具限制告知
- **抄谁**：Autify——"既不 [Passed] 也不 [Failed]，而是 [Review Needed]"，配 `Save as Passed` / `Save as Failed`，FAQ 明写 **"'Review Needed' does not necessarily mean failure."**；Lovable/Bolt——把工具自身限制写成产品事实（Bolt 的 **"Needs your action"**、Lovable 的 Limitations 清单与"更可能是浏览器交互限制，而不是应用坏了"）
- **抄什么**：`blocked` 的用户可见措辞 = **结论 + 原因 + 下一步**，并明确**这是工具的限制还是应用的问题**
- **落到哪**：`packages/contracts`（用户可见文案）、工作台界面
- **状态**：待办

### 2.4 质量指标（mabl 式）
- **抄谁**：mabl（八家中唯一公开自愈相关质量指标者）——flake rate、breakage rate、pass rate、stability、reliability、0–100 composite quality score
- **抄什么**：除"单次墙钟"外，报**可聚合的质量指标**：确定性覆盖率、不可编译率、blocked 率、跨重复运行的一致性（τ-bench 的 pass^k 思路）
- **落到哪**：新模块 + 工作台展示
- **状态**：待办

### 2.5 隔离复核（不确定的东西不拖垮整次）
- **抄谁**：Momentic——quarantine 隔离、单次运行最多 3 次恢复、**重解只对本次运行生效、不改测试**；Octomind——**"Zero Silent Commits"**，修复须人工 approve 才落库；QA Wolf——`Investigating` / `Do Not Investigate` 逃生口
- **抄什么**：不确定的用例**单独拎出并可复核**；模型的重解**不回写计划**
- **落到哪**：`replay-plan.ts`（已有单条兜底，需补"隔离"与"本次运行内生效"语义）
- **状态**：待办

### 2.6 放行权留在确定性/人一侧
- **抄谁**：Tempo——**"check stays red until someone approves"**，像素检查**模型无法放行**；Octomind——须人工 approve；Emergent——健康检查失败即 **"your app won't go live"**
- **抄什么**：模型可参与诊断与修复，**不得独自决定"通过"**
- **落到哪**：现有设计已符合（守卫不改、fail-closed）；**补一条测试固化**"模型判定不得放行脚本已判失败"，即在 1.1 的改动中**保持**本会话修掉的 fail-open 修复不被回退
- **状态**：待办

---

## 批次三：测量（待办）

- **A+B 实测墙钟**（≤10 分钟达标判据）
- **协调者是否产出可执行步骤**（已实测 YES：41/41 带 steps、39–40/41 可编译）
- **确定性覆盖率**（新指标，来自 2.2）
- **C3 + #37 全矩阵**（发布前验收）

---

## 明确不做的事

- **不为让流程跑通而弱化断言或判定标准**；批次一改的是**严格性的作用域**（单动作 vs 整页），不是放宽判定；
- **不用估算替代实测**；每项以"本地测试全绿 + 真实运行实测"为完成判据；
- **不批量改测试期望**；每个受影响测试逐个判定"固化了旧机制"还是"真实保证被破坏"。

---

## 附：确定性覆盖率——指标口径与首次实测（2026-09-26）

按 mabl（八家同类产品中唯一公开质量指标者）的做法，我们从今天起保留这条可复现指标。
**口径必须写明，否则数字会误导**——这就是一个反面例子：全历史口径得 13.6%，而当前口径得约 98%，
两者都"真实"，但只有后者说明当前能力。

### 口径

- **只统计"计划支持可执行步骤"之后的运行**（旧运行的计划生成于 schema 支持 `steps` 之前，纳入会稀释）；
- **分子**：计划中带 `steps` 的行为数；**分母**：计划中的行为总数；
- 必须同时报**样本量**（运行数、行为总数），不得只报百分比。

### 可复现查询

```sql
-- 确定性覆盖率（近 N 次有计划的运行）
SELECT to_char(created_at,'MM-DD HH24:MI') AS at,
       jsonb_array_length(plan_json->'behaviors') AS behaviors,
       (SELECT count(*) FROM jsonb_array_elements(plan_json->'behaviors') b WHERE b ? 'steps') AS with_steps,
       state, coalesce(error_code,'') AS err
FROM nano.runs WHERE plan_json IS NOT NULL ORDER BY created_at DESC LIMIT 8;
```

```sql
-- 回放层的健康度（开始 / 退回 / 失败）
SELECT count(*) FILTER (WHERE payload_json->>'message' LIKE '脚本回放开始%') AS replays,
       count(*) FILTER (WHERE payload_json->>'toolName' = 'replay_fallback') AS fallbacks,
       count(*) FILTER (WHERE payload_json->>'toolName' = 'replay_error')    AS failures
FROM nano.run_events;
```

### 首次实测（2026-09-26）

| 指标 | 值 | 口径 |
|---|---|---|
| **确定性覆盖率** | **≈ 97.9%（237/242）** | 近 6 次运行（05:24–06:11），计划支持 steps 之后 |
| 对照：历史全量 | 13.6%（238/1750） | 含 100 次旧运行，**不得作为当前能力指标** |
| 对照：更早期两次 | **0/41、0/41** | 04:13、02:19，计划被 4096 输出上限截断的时代 |
| 回放开始 / 退回 / 失败 | 6 / 1 / 4 | 失败全部为同一 bug（`STALE_BROWSER_REF`，批次一正在修） |

**解读**：**计划侧已基本解决**（真实应用上 ~98% 行为带可执行步骤）；**卡点集中在回放**（6 次中 4 次中止于同一处）。

---

## 最后一块：退回落盘的粒度（整盘 → 逐条）

### 实测证据（2026-09-26，运行 `cd72fee6`）

```
12:00:24  脚本回放退回模型路径：35 项已编译，4 项不可编译
          （B32:missing-steps, B25:missing-assertions, B28:visual-evidence, B36:visual-evidence）
此后：模型路径动作数 = 130
```

- **35 条**行为已被确定性层跑完并产出真实判定（墙钟约 5 分钟）；
- 因剩下 **4 条**不可编译，**整次检查退回模型路径**，用模型一条条点（130 次动作），**走回约 30 分钟的慢路**；
- **这正是 ≤10 分钟无法达标的最后一处原因。**

### 业界从不这样做

| 产品 | 官方做法 |
|---|---|
| Stagehand | 缓存**逐次**命中→确定性；**未命中只对那一次调用**跑推理（"falls back to normal inference"） |
| Momentic | 命中→毫秒重放；**失配只重解那一步**（"只对本次运行生效"）；无法解决者 **quarantine 隔离** |
| Skyvern | **per-block 缓存**：只有变化的块回退 agent，其余照跑 |

**没有任何一家会因为 4/39 不可编译，就把 39 条全部重做一遍。**

### 应当改成（逐条落盘）

1. **`compiled` 非空时，永不整盘退回。** 已跑完的行为保留其真实判定；
2. **`visual-evidence` 类**：交给已有的视觉判定层（C 层，`visualJudge` / `judgeVisualBehaviours`）从像素判定并**合并**——这本就是 C 层的职责，不该触发整盘退回；
3. **`missing-steps` / `missing-assertions` 类**：该行为记 **`blocked`** 并在判定理由里写明原因（我们的 fail-closed 规则：**blocked ≠ passed**），**不整盘退回**；
4. **只有 `compiled` 为空（即全部不可编译）时**，才退回整次模型路径——那才是真正"没有确定性可用"的情形。

### 落地位置（已精确定位到行）

**`apps/api/src/runtime/replay-plan.ts:232`** —— 这就是实测中"35 项已编译、4 项不可编译 → 整盘退回"的确切来源：

```ts
return { kind: 'fallback', compiled: compiled.programs.map((program) => program.behaviorId), uncompilable: compiled.uncompilable };
```

同一文件 `:203-206` 已有正确的先例可循：当**全部**不可编译项都是 `visual-evidence` 且存在视觉判定端口时，它会**不退回**、直接走视觉判定（`judgeVisual`）。要做的就是把这种"能落盘就落盘"的判断从"全部是视觉项"扩展到"**只要有已编译程序**"：已编译行为的判定保留、视觉项交给视觉判定、其余不可编译项记 `blocked` 并写明原因；`compiled.programs.length === 0`（`:205-206`）时才整盘退回。

### 落地时唯一需要先读清楚的细节（顺序问题）

`:229-232` 那段退回的**原始理由写在注释里**："模型路径对整个计划负责，所以部分编译的计划不能提交部分结果"——**该理由在"模型路径是唯一路径"的时代成立，在分层设计下不成立**（业界做法相反：能落盘就落盘，落不了的逐条隔离）。

改法是：删掉这个提前退回，改为**为每个不可编译项填入一条 `blocked` 判定**（理由写明 `missing-steps` / `missing-assertions` / `visual-evidence`），然后让后面的组装流程照常进行。

**但必须先读清楚组装路径中视觉判定的写入顺序**：`visual-evidence` 的判定项是在这段退回**之后**才被塞进 `run.items` 的（来自 `captures` / `verdicts`）。因此填 `blocked` 时必须避免与视觉项互相覆盖——两种可行做法：

1. **只为本就非视觉的不可编译项填 `blocked`**（`visual-evidence` 交给后面的视觉判定），这是最小改动；
2. 或为所有不可编译项填，但**确保视觉判定随后覆盖**（需确认覆盖语义，风险更高）。

**推荐第 1 种**：改动最小，且不会触碰视觉判定既有行为。落地时相应新增测试：**"混合不可编译（既有视觉项也有缺步骤项）时，已编译行为保留真实判定、缺步骤项记 blocked 并写明原因、且不整次退回模型路径"**。

### 落地位置与影响（其余）

- **位置**：`apps/api/src/generation/review.ts` 中处理 `scripted.kind === 'fallback'` 的分支（当前无条件退回 `modelPath()`）；以及 `replay-plan.ts` 中 `uncompilable` 的产出与 `runPrograms` 结果的合并处。
- **不改**：判定标准、守卫、fail-closed 规则、五组完整性要求。
- **完成后应当出现的可观测结果**：不再出现"35 项已编译 → 模型路径 130 次动作"；取而代之是"35 项确定性判定 + 4 项带原因 blocked/视觉判定"，**且墙钟保持在数分钟内**。
- **验收**：一次真实运行，给出 **A+B 实测墙钟**；若仍有 blocked 项，则是"该行为确实无法确定性验证"的**诚实结论**，而不是整次滑回慢路。

### 为什么这是"通用性"的关键

通用应用里**一定有**部分行为无法确定性编译。**如果一条不可编译就整盘退回，那么确定性层在通用应用上等于不存在**——这既是性能问题，也是产品是否可用的分水岭。

---

## 首次达到 ≤10 分钟的实测（2026-09-26，运行 `d6beba62`）

| 指标 | 实测值 |
|---|---|
| **整次 A+B 墙钟** | **9.1 分钟**（05:24:40 起算口径：`finished_at - created_at`） |
| 回放完成行为数 | **36**（计划 39–40 条） |
| **整盘退回模型路径** | **0 次** |
| **模型驱动浏览器动作** | **0 次** |
| 终态 | `failed/persist`，`error_code=CHECK_BLOCKED`，检查 `blocked=1` |
| 平台其余条件 | `vision=verified`、缺省配置 deepseek-flash、隧道正常 |

**结论分两句，不能混**：

1. **"单次增量验收墙钟 ≤10 分钟"这一条，首次有了真实测量支撑（9.1 分钟）。** 而且是**真的在做确定性验收**（36 条回放、零模型浏览器动作），不是崩在中途的假快。
2. **它不是一次"通过"**：终态 `blocked`。原因是**计划侧**仍有少数行为没有 `steps`/`assertions`（另有 2 条外观行为需像素判定），而 `blocked ≠ passed`（fail-closed）。**不再有"模型路径把它救回通过"这条路——这是刻意的。**

### 距"通过"还差什么

**只差计划质量**：让协调者对**每一条**行为都产出 `steps` 与 `assertions`（实测中每次约 2–4 条缺失）。这是提示词/计划侧的收尾，**与本会话改动过的机制无关**——机制侧已经跑通并达标。

验证方法（可复现）：按本文件"确定性覆盖率"一节的 SQL 查询每次运行的情绪，关注三件事——`带 steps` 是否等于行为总数、`review_fallback` 是否为 0、墙钟是否仍 ≤10 分钟。

### 与业界对照（自评）

| 原则 | 本次实测 |
|---|---|
| 严格性作用在单个动作 | ✅ 单个控件解析失败只废该条（36 条不受影响） |
| 能落盘就落盘，不整盘退回 | ✅ `replay_fallback` = 0 |
| 降级可观测 | ✅ blocked 判定带 reason token；失败带错误码 |
| 失败只重跑受影响路径 | ✅ 36 条已完成行为全部保留 |
| fail-closed | ✅ `blocked ≠ passed`，未放松 |
| **多信号定位 / 作用域** | ❌ **尚未做**（复刻清单批次二 2.1）——这是"通用应用"下一个要补的 |

## 第二次实测：判定首次出现区分度（2026-09-26，运行 `c064aa39`）

| 指标 | 实测值 |
|---|---|
| **整次 A+B 墙钟** | **8.7 分钟**（连续第二次 ≤10） |
| 计划带 steps | **40/40**（补上"每条行为必须有 steps/assertions"后） |
| 检查子项 | **passed 35 / failed 3 / blocked 2** |
| 整盘退回 / 模型浏览器动作 | 0 / 0 |

### 具体发现（这才是验收该产出的东西）

| 判定 | 行为 | 实际理由 |
|---|---|---|
| blocked | **B40** | `STALE_BROWSER_REF`：`role=button name="删除"` **匹配 20 个**——**同名多控件问题**，现已被**按条隔离**，其余行为不受影响 |
| blocked | **B41** | 断言成立，但步骤中**没有真实交互动作**（仅渲染证据），故不判通过（fail-closed） |
| failed | **B15** | ✓ 文本"零"出现；**✗ 控制台错误 0 条**（要求无报错，实际有） |
| failed | **B30** | ✗ 文本"暂无记录"未出现 |
| failed | **B38** | ✗ 文本"1+*2"出现（不该出现） |

**对照起点**：此前每次运行都是"40 条全 blocked、无区分度"。**现在一次验收能在 8.7 分钟内给出 35 通过 / 3 失败 / 2 无法判定的具体清单**——这正是分层设计的目标形态。

### 距"通过"的精确剩余工作

1. **B40 → 需要"作用域定位"**（复刻清单批次二 2.1，Playwright `filter` 的解法）：步骤要能表达"哪一条里的删除按钮"，而不是要求应用改名。**这是通用性的核心，已识别、未实现。**
2. **B41 → 计划侧**：该行为的步骤需要包含真实交互，或明确声明为渲染型证据。
3. **B15 / B30 / B38 → 应用侧或计划措辞**：这三条是**应用本身不满足验收**（控制台报错、空态文案、非法表达式残留），属于正常的产品修复工作。
4. 修完上述后跑一次**通过路径**验收 → 再做 **C3 + #37 全矩阵** → 三处 SHA 对齐后关单。

---

## 2.1 作用域定位的前置问题（已勘察，必须先回答）

**实测证据**：运行 `c064aa39` 的 B40 —— `STALE_BROWSER_REF: role=button name="删除" 匹配 20 个`。这正是"每行一个同名控件"的通用问题，Playwright 的官方解法是**先缩小作用域再定位控件**（`getByRole('row').filter({hasText:'...'}).getByRole('button', …)`）。

**但照抄它在我们的实现里行不通，原因是数据结构不同**：

- **Playwright 有真实 DOM 树**，所以 `filter({hasText})` 能在子树里找。
- **我们只有扁平表**：`apps/api/src/runtime/browser.ts:17` 的 `refs: Record<string, { role?: string; name?: string }>`——**每个 ref 只有 role 与 name，没有任何父子/祖先关系**。

因此"作用域"要先解决**数据从哪来**，三条候选路径（需先确认浏览器协议能提供什么）：

1. **让浏览器适配器为每个 ref 暴露祖先链**（最接近 Playwright 语义；取决于底层协议是否给出层级——**未确认**）；
2. **从树文本推导包含关系**（`browser.ts:161` 的 `tree` 有缩进/括号结构）：可行但脆弱，且树会被压缩（`:161` 的上限），压缩后推导可能不可靠；
3. **退一步的消歧谓词**：不引入层级，而是让步骤能表达"在匹配到的第 N 个"或"名字包含某段文本的那个"。**但注意 Playwright 官方明确不推荐 nth 类做法**（页面一变会点错元素，见本文件批次一 1.3 的出处），所以这条要与"宁可失败也不要猜"权衡。

**结论**：2.1 不是"照抄一行 API"，而是**先确认观察数据能否承载作用域**。**在回答这个问题之前不动手**——否则很可能做出一个在压缩树上偶发失灵的"作用域"，那比现在诚实报 blocked 更糟。
