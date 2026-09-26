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
