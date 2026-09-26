# 通用应用的验收"分寸"：外部同类产品的做法（调研，2026-09-26）

## 为什么做这份调研

我们的评审改造卡在一个具体问题上：**A 层回放把"压缩后的页面摘要不全"当成了"控件清单不可信"，于是拒绝一切点击**，导致整次增量在第 2 条行为处报废。我们的第一反应是"这是计算器特有的问题"，随后意识到不是——**这是通用产品如何把握验收严格性的问题**。

于是去查两类参照：**同类工具/产品实际怎么做**（一手文档与 issue/PR），以及**学术基准怎么定义通过**。

## 一、最决定性的一条：同类工具都不"封禁整页"

**总结论：没有任何一个基于 a11y/ref 的工具会给"整份观察"打不完整标记并禁止全部操作。** 一律是"**单次动作即时失败 + 明示重新观察后重试**"。

| 工具 | 官方行为（原文） | 出处 |
|---|---|---|
| Playwright MCP | ref 生命周期 "Valid until the page changes"；失效报 `Ref <ref> not found in the current page snapshot. Try capturing new snapshot.`——**只废该次调用** | https://playwright.dev/mcp/snapshots |
| Playwright MCP（大页面） | **不自动截断**；缓解手段是 `browser_find`（只回匹配节点、缺口以 `...` 标记）、`depth`、`--snapshot-mode=none` | https://github.com/microsoft/playwright-mcp/issues/1329 |
| Chrome DevTools MCP | "Always use the latest snapshot"；"If an element isn't found, take a fresh snapshot"；旧 uid 报 "stale snapshot"，**仅该次失败** | https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/skills/chrome-devtools/SKILL.md |
| browser-use | **唯一"截断且明说"**：`max_clickable_elements_length` 默认 40000，超出即追加 `" (truncated to 40000 characters)"`；索引失效只废单动作 `Element not clickable with index N - most likely the page changed` | https://github.com/browser-use/browser-use/blob/main/browser_use/agent/prompts.py |
| browser-use（批量动作） | 执行前比对元素 DOM hash，变化则 abort 剩余动作，并区分 "since LLM call" / "after action N" | https://github.com/browser-use/browser-use/pull/2876 |
| Vercel agent-browser | ref "become stale the moment the page changes"；失败即要求重新 `snapshot -i` | https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/SKILL.md |
| OpenAI computer use | 纯截图无 ref："Give the model a current screenshot when the UI state is unknown. After a short group of actions, return another screenshot…" | https://developers.openai.com/api/docs/guides/tools-computer-use |

**反向证据（证明"宁可失败也不要猜"）**：Vercel agent-browser 的 ref 原本是**位置编号**，DOM 变动后会**静默点错元素并返回 ✓ Done**；修复方式是**把 ref 绑定到节点身份而非位置**。https://github.com/vercel-labs/agent-browser/pull/1444

**推论**：该"失败"的是**那一个动作**，不是整页；截断要**显式告知模型**（"你看不到 N 之后的部分"），而不是让模型怀疑整份清单。

## 二、自愈/AI 定位产品：严格性的作用域是"单个控件"

| 产品 | 不确定时倾向 | 公开阈值/机制 |
|---|---|---|
| Testim | **宁可猜**：主定位失败依次走备选，ML 给候选打分 | locator score 跌破 **70%** 触发自动改进；置信度波动 **>20%** 报"页面变化告警"；UI 有 High/Medium/Low |
| Healenium | **宁可猜**：NoSuchElement 后 LSC 算法生成 healed 列表，取最高分 | `score-cap` 默认 **0.6**、`recovery-tries=1`；有独立 report 页含分数与人工反馈 |
| mabl | **宁可报不确定**：原文 "If the best match is low confidence, the test step fails instead of auto-healing to an element that is a poor match" | 自愈记 auto-heal insight |
| Applitools | **拒绝二元阈值**，官方称像素阈值"不可靠且任意"，改用 match level | — |
| Percy | 用**可调灵敏度**压误报 | 默认忽略 **20%** 图像差异；位移容忍上限（纵向 ≤100px、横向 <页宽 5%） |
| Selenium relative locators | 无评分、无自愈，找不到即抛异常 | — |

出处：Testim/Tricentis 官方文档与 test-results 页；Healenium docs 与 README；mabl help "How auto-heal works"；Applitools match-levels；Percy Intelli-Ignore；Selenium locators。

**共性**：两种哲学都存在（宁可猜 / 宁可报不确定），**但都作用在"单个控件"上，都把阈值写出来，都把降级当作一等可记录事件**（Testim 有修订历史与徽标；mabl 有 insight；Healenium 有 report 页）。

## 三、学术基准：单一成功率不足以刻画能力

| 基准 | 补充指标 | 不确定/部分分 |
|---|---|---|
| WebArena | 仍报 SR，但补"同模板一致性"（GPT-4 仅 4/61 模板达 100%） | 二值；判官给 "partially correct" 也不计分；同动作重复 >3 次或连续 3 次非法动作即终止记失败 |
| VisualWebArena | 自认二元奖励不足（"we do not consider non-binary rewards…a valuable direction"） | fuzzy_match 仅 correct 得 1 |
| **τ-bench** | 提出 **pass^k**（k 次全成功的概率）："not just…high average success (pass^1), but…robustness and consistency" | 二值（终局状态 + 必要信息） |
| OSWorld | 指出模型跨任务方差远大于人类（人类 <5%） | **唯一明确部分分**："1 or a positive decimal under 1" |
| AgentBench | 8 环境各自指标 + 重标定加权总分；统计 Completed/IF/IA/TLE/CLE | "There are only two final status…wrong or correct" |

**"任务在该环境做不了"一律做成显式类别，反对事后剔除**：WebArena 专设 Unachievable（答案标 `N/A`，要求给理由）；VisualWebArena 46 个（5.1%）；OSWorld 30 个（8.1%）infeasible 并设专门 FAIL 动作，判对给非零分；WebVoyager 是唯一显式排除（登录/CAPTCHA 站点）。

出处：arXiv 2307.13854 / 2401.13649 / 2406.12045 / 2404.07972 / 2308.03688 / 2401.13919；另参 2407.01502（主张精度单指标不够，须成本 + 误差棒 + holdout）。

## 四、如何向用户表达"无法判定"

**三态是 CI 标配**：GitHub Checks 的 conclusion 枚举含 `neutral`/`skipped`/`timed_out`/`action_required`（官方明确 neutral 与 skipped 在依赖检查中按成功处理）；GitLab 有 `skipped`/`manual`/`allow_failure`。GitLab 官方设计文档直接论证了**只有二态时的两种坏结果**：要么误报失败卡住流程，要么把"没执行"偷偷当通过。

**"跳过必须带原因"不是硬性规范**：JUnit XSD 的 `<skipped message>` 是**可选**属性；pytest 的 `reason` 是必填位置参数（约定更强）；GitHub Checks 用 `output.summary` + `annotations` 承载原因。**但成熟产品都主动给原因与下一步**。

**可直接照抄的实例**：
- **SonarQube** 有第三态 **"Not computed"**：写明成因（只跑过一次分析 / 未设 new code definition）+ 一个 **"Set New Code Definition" 按钮**；
- **Dependabot**：带主语的完整句 + 建议——"Dependabot **cannot update** X to a non-vulnerable version"；
- **Copilot**："AI might still make mistakes… **verify that they match your expectations**"；
- **Perplexity**："没有标注**不代表**该站点质量低，只是**尚未评级**"。

**最佳句式五要素**：① 结论放第一句（"无法判定"不埋在日志里）；② 第二句人话原因；③ 第三句下一步或可点按钮；④ 不出现内部枚举名；⑤ 把"未判定"说成中性而非负面。

## 五、五条"分寸"原则（可直接作为我们设计判据）

1. **严格性的作用域是"单个控件/单个动作"，不是整页**。任何"整页不可信 ⇒ 拒绝一切"的设计都要有强依据，而我们没找到先例。
2. **阈值必须显式、可调、写进文档**（Testim 70%、Healenium 0.6、Percy 20% 是先例）。
3. **降级/自愈/无法判定是一等可观测事件**：必须带原因、可审计、并展示给用户（Testim 修订历史、mabl insight、SonarQube "Not computed" + 按钮）。
4. **度量一致性而非单次成功率**（pass^k / 同模板一致率）；单次运行的数字不足以说明能力。
5. **"在本环境不可执行"是正式类别，必须给理由**（N/A、infeasible + FAIL 动作），且**不得事后剔除**。

## 六、我们目前踩了哪几条（对照结论）

| 原则 | 我们的现状 |
|---|---|
| 1. 作用域 | ❌ **踩**：摘要不全 ⇒ 否决**整页**所有控件操作 |
| 2. 显式阈值 | ❌ **踩**：12,000 字符 / 100 控件等常量散落各处且未文档化，改一次要连带改测试 |
| 3. 降级可观测 | ❌ **踩**：本会话中"回放为何失败"曾**完全不被记录**（已修）；"哪些行为不可编译"也未作为一等展示 |
| 4. 一致性度量 | ❌ **缺**：只测单次运行的墙钟 |
| 5. 不可执行是正式类别 | ⚠️ **部分**：有 `replay_fallback` 事件与不可编译计数，但未作为对用户的一等结论呈现 |

## 七、据此该改的四件事

1. **"观察不完整"从否决信号降级为降级信号**（照常解析控件）；
2. **控件解析失败只废该动作**，并返回**可执行提示**（"重新观察后重试"）；
3. **截断显式写入给模型的载荷**（学 browser-use 的 `(truncated to N chars)`）；
4. **ref 绑定节点身份而非位置**（Vercel #1444 的教训：位置编号会静默点错元素）。

**注意**：第 1 条与仓库中两条既有测试的语义冲突（它们有意钉住"观察不完整就中止控件步骤"）。按本项目约束，**这类判定标准的改动需要所有者批准**，不得由 agent 单方面推翻——本调研的作用正是把"这是行业异类"的证据摆出来，让决定有依据。

## 附：调研方法与局限

- 工具：agent-reach（Exa 搜索 + GitHub `gh` + `web_fetch` 直读官方文档与 issue/PR）。本机 `r.jina.ai` 对部分站点超时，改用内置抓取；`web_search` 因缺 `DEEPSEEK_API_KEY` 不可用。
- 引用优先官方文档、issue、PR 与 arXiv 原文；**未找到官方依据的项均已标注**（如 Anthropic computer use 文档被 JS 壳拦截；Snyk 未见"数据不足"的独立门禁状态；Healenium 评分公式未公布）。

## 八、确定性回放 vs 模型兜底：五个同类工具怎么做（第二波调研）

| 工具 | 机制 | 被命中失败时 | 是否汇报"回退率" |
|---|---|---|---|
| **Stagehand**（Browserbase） | 服务端缓存 `act/observe/extract`；cache key = 指令 + **页面快照指纹** + 选项（**故意不含模型配置**）；命中即零 token 确定性执行 | 自动跑 LLM 并写新条目："Caching is best-effort… falls back to normal inference" | ❌ **无命中率仪表**；只有逐次 `metadata.cache.status=HIT/MISS/DISABLED`、`missReason`、省下 token |
| **Midscene.js**（字节） | 缓存 AI 规划步骤（prompt 为 key）+ 元素 XPath；**默认关闭** | 不命中即回退 AI；缓存计划运行失败则清空旧 flow 且**不回写** | ❌ 无；HTML report 里标 cache 与耗时 |
| **browser-use** | 结构化 "Interactive elements" 列表 + 可选截图；开源库**无决策缓存** | 定位走 **5 级降级**：EXACT → STABLE → XPATH → AX_NAME → ATTRIBUTE，逐级降级并打日志 | ❌ 未找到 |
| **Skyvern** | `run_with="code"` 确定性重放录制动作；**per-block 缓存** | 页面变化自动回退 agent 并**重生成缓存**；官方称 "coverage builds up over time" | ❌ 无 |
| **Shortest** | action caching **默认开启**（`--no-cache` 关闭） | 重放前按归一化组件串比对，不匹配即抛 `CacheError` → 回退完整 AI；状态标 `passedFromCache` / `executedFromCache` | ❌ 无 |
| **AutoPlaywright** | 每步实时调 LLM，**无缓存/无回放** | — | — |

出处：docs.stagehand.dev v4 caching 与 act；browserbase.com blog "Stagehand caching"；midscenejs.com/caching 与 consume-report-file；docs.browser-use.com all-parameters 与 Cloud scripts、`browser_use/dom/views.py`；skyvern.com code-caching；github.com/antiwork/shortest（runner）。

### 八.1 三条新增原则

**原则 6：确定性回放 + 模型兜底是共识，且兜底以"逐条状态"呈现，不以"比例仪表"呈现。**
五个工具**没有一个**以"确定性覆盖率/回退率"命名指标；最接近的都是**逐条字段**（Stagehand 的 `cache.status`/`missReason`、Shortest 的 `passedFromCache`/`executedFromCache`、Midscene 报告里的 cache 标记）。这与学术侧"要一致性指标"并不矛盾：**逐条状态是可聚合的原始数据，比例是它的派生视图**——差别在于业内把原始数据暴露出来，让我们自己去聚合。

**原则 7（第一方原文，直接支持 fail-closed）：宁可漏命中，不可错命中。**
Stagehand 官方权衡原话：**"a wrong cached click is worse than a slow click"**，并明确 **"optimize for accuracy over hit rates"**；命中重放时**关闭自愈**。这为我们的"没有证据绝不通过"提供了同类产品的背书——**但注意它仍是"单次点击"层面的取舍，不是"整页否决"**。

**原则 8：定位失败应当走"降级阶梯"，而不是"唯一匹配否则拒绝"。**
browser-use 用 EXACT → STABLE → XPATH → AX_NAME → ATTRIBUTE 五级，逐级尝试并**记录走了哪一级**。我们的实现要求"role+name 恰好唯一匹配，否则不可编译/抛错"，缺少中间层级。

### 八.2 对我们的直接含义

- 我们的 `replay_fallback` 事件方向是对的（逐条状态），但**应当成为可聚合的一等数据**，并据此算出"确定性覆盖率"，而不是只报一次运行的墙钟；
- 我们的 fail-closed 立场**有同类背书，不必动摇**；要改的仍是**作用域**（单动作 vs 整页）与**降级路径**（阶梯 vs 二元）；
- browser-use 官方承认 **agent 自报的 `is_successful` 需要独立验证**——这是"确定性层 + 独立判定"存在的直接理由，也是我们 A 层价值的同类佐证。

## 九、Playwright × Testing Library：定位与"多匹配"的官方立场（第三波调研）

**这一节纠正了本调研早前的一处暗示，并给出了"通用应用"的正面解法。**

### 九.1 `name` 匹配语义（原文）

> "By default, matching is case-insensitive and searches for a substring, use `exact` to control this behavior."
> `exact`："case-sensitive and whole-string. Default to false. Ignored when the value is a regular expression. Note that exact match still trims whitespace."

https://playwright.dev/docs/api/class-locator#locator-get-by-role

**含义**：**我们实现里的"名称必须逐字相同"比业界默认严得多**。业界默认是"**不区分大小写 + 子串**"，需要精确时才显式开 `exact`。我们把这个开关**焊死在最严的一端**。

### 九.2 Strict mode：唯一性要求是对的——**我们这部分没错**

匹配 >1 时，任何"隐含单一目标"的操作**抛异常**（`count()` 这类多元素操作不抛）。官方消歧手段：`locator.filter()`（`hasText`/`has`/`hasNot`/`visible`）、locator 链式缩小作用域、`first()/last()/nth()`。

**官方明确不推荐 first/last/nth**：

> "These methods are not recommended because when your page changes, Playwright may click on an element you did not intend. Instead, follow best practices above to create a locator that uniquely identifies the target element."

https://playwright.dev/docs/locators#strictness

**因此**：
- 我们要求"恰好唯一匹配"——**与 Playwright strict mode 一致，不是错的设计**（本调研早前把它一并归入"过严"是不准确的，此处更正）；
- 真正不同的是**作用域**：Playwright 是**该动作**失败（TimeoutError），我们是**整页**否决；
- 官方反对的正是"随便挑一个"（first/nth），**这为"宁可失败也不要猜"提供了第一方背书**（与原则 7 呼应）。

### 九.3 "同一角色同名多行列表"（每行一个「删除」）——官方标准解法

**先缩小作用域，再定位控件**：

```js
page.getByRole('row').filter({ hasText: 'Product 2' })
    .getByRole('button', { name: 'Add to cart' })
```

https://playwright.dev/docs/locators#filtering-locators

**这一条直接回答了我们卡住的那个设计问题**：当应用里有多个同名按钮（历史记录每行一个「删除」），业界的做法**不是**要求应用把名字改成全局唯一，而是**让定位表达式携带作用域**（哪一行/哪一条）后再匹配控件。

**由此，本会话中我替产品做的那个决定是反的**：协调者问"「删除」指哪个按钮"，我答"就叫「删除」、不要带条目文本"——**那是让应用迁就验收机制**。正确方向是**让步骤能表达作用域**（例如"历史记录第 N 条里的删除按钮"），应用想怎么写名字就怎么写。

### 九.4 定位器优先级

- **Playwright 没有**显式的 role > label > placeholder > text > testid 排序；只给两处信号：① 优先 user-facing 属性与显式契约，`getByRole` 第一（"the closest way to how users and assistive technology perceive the page"，遵循 W3C ARIA）；② testid 最后（"not user facing"），仅在 role/文本不可用时使用，但又承认它 "most resilient"。
- **Testing Library 有**明确排序：`getByRole` > `getByLabelText` > `getByPlaceholderText` > `getByText` > `getByDisplayValue` > `getByAltText`/`getByTitle` > `getByTestId`；testid 仅用于"无法用 role/文本匹配，或文本是动态的"。

https://playwright.dev/docs/locators#locate-by-role 、https://playwright.dev/docs/locators#locate-by-test-id 、https://testing-library.com/docs/queries/about/#priority

### 九.5 自动等待与重试

动作前做 actionability 检查（**须恰好解析到一个**、visible、stable、receives events、enabled）；**超时即抛 TimeoutError，不自动重试**。自动重试的是 web-first 断言（`expect(...)`，默认 5s 后 fail）；`expect(...).toPass()` 默认 timeout 为 **0**（须显式传上限）；测试级 `retries` 默认不重试。

https://playwright.dev/docs/actionability 、https://playwright.dev/docs/test-assertions#auto-retrying-assertions 、https://playwright.dev/docs/test-retries

**含义**：**"失败就失败、由外层决定是否重试"是业界默认**，而不是无限自愈。我们的"只重跑受影响路径"与之同向。

### 九.6 a11y 树快照的能力与限制

`locator.ariaSnapshot()`（v1.49）输出 a11y 树的 YAML；`expect(...).toMatchAriaSnapshot()` 比较**大小写敏感、顺序敏感**，默认 `/children: contain` 子集匹配，可设 `equal`/`deep-equal`，支持正则与部分匹配。已知限制：`ariaSnapshotJSON` **不是稳定契约**（free-form JSON）、`mode:"ai"` 时不等待匹配元素、无匹配即抛错、涉及 iframe；**大树用 `depth` 限制深度**。

https://playwright.dev/docs/aria-snapshots 、https://playwright.dev/docs/api/class-locator#locator-aria-snapshot

**关于"大树/分页时怎么办"：未找到官方依据**（官方文档未说明）。

### 九.7 本节新增的两条原则

**原则 9：定位表达式应当能表达"作用域"，而不是要求应用把名字改成全局唯一。**
行业标准是"先定位容器（行/条目），再在其中定位控件"；这既解决同名多个的问题，也避免为了验收而修改产品行为。

**原则 10：名称匹配的宽严应当是显式开关，默认应贴近业界（不区分大小写 + 子串）。**
我们把"逐字精确"焊死为唯一选项，比 Playwright 默认严得多；`exact` 式的显式开关更合适。
