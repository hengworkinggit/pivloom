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
