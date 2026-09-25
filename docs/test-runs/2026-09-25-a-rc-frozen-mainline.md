# #37 冻结版真实主线：执行记录（2026-09-25，进行中）

## 一、冻结环境（提交 F）

| 项 | 值 |
| --- | --- |
| GitHub HEAD / 部署提交 F | `2ade595ef661654f56471da65a66b082b5d79d17` |
| 公网 Web | `https://pivloom-69-5-7-187.sslip.io`（`/version` = F） |
| 公网 API | `/api/v1/version` = F |
| 永久发布域 | `https://app-69-5-7-187.sslip.io`（`PUBLISHED_APP_BASE_URL`） |
| 模型配置 | profile `ea2e0acf-4277-4670-8280-1e6635e7b363`，模型 `kimi-k2.7-code`，OpenAI 兼容，`configVersion=2`，默认 |
| 沙箱 | OpenSandbox 镜像 `pivloom-g0:20260922`，`SANDBOX_MAX_ACTIVE=2` |
| 浏览器 | agent-browser 0.36.0（HeadlessChrome 154.0.0.0），独立命名会话 |
| 测试时间 | 2026-09-24T23:17Z 起 |

复用对象：Pi SDK 三角色（Coordinator/Builder/Reviewer）、既有 OpenSandbox 与预览网关、既有 A 页面与队列（迁移 020–024）、agent-browser；未引入第二套 Agent／浏览器／队列框架。

## 二、C0（计算器基础版）——**PASS**

项目 `13dcc301-e8a4-4e14-bbe2-a8757b4d76d7`，从 A 新建页创建，创建时 `current_revision_id` 为空且项目内 revision 数为 **0**（空业务工程，无预制模板/无 seed）。

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| 原始 Prompt 落库 | PASS | Run `94bb904f-6992-48d4-8f93-1f8acc5f73ba`，`request_text` 138 字，`request_hash` `04b88f61…` |
| 冻结 profile/model/configVersion | PASS | `model_profile_id=ea2e0acf…`、`model_config_version=2`，`base_revision_id` 与 `expected_current_revision_id` 均为空（首轮无基线） |
| 真实 Coordinator/Builder 调用 | PASS | `role_runs`：coordinator `succeeded`（1999 in / 9112 out tokens）、builder `succeeded`（17649 in / 12566 out）、reviewer `succeeded`（87217 in） |
| 写入文件 + 构建 | PASS | revision v1 `build_status=passed`，源码 38556 字节，`source_hash` `f68de02ca7fe2300…` |
| 产品五组完整检查 | PASS | `verdict=passed`，**5 组 / 28 项全部通过**，31 个产物（截图等），摘要「已检查 28 项行为：28 项通过。」 |
| 同一 revision/hash 的 Preview | PASS | 预览绑定到 v1 的 revision 与 source hash |

## 二之二、C1（功能增量：历史记录 + 复制结果）——**PASS**

Run `c10ecdcd`，`base_revision_id` 与 `expected_current_revision_id` 都冻结在 C0 的 revision `440a36bb`（v1），Prompt 161 字。

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| 版本递增与基线正确 | PASS | 产出 **v2**（revision `cc4a7ee9`），`next_revision_no` 2→3；base/expected 同指 v1 |
| 真实源码变更 | PASS | v2 `source_hash` `1346ccafafc2…` ≠ v1 `f68de02ca7fe…` |
| 旧功能保留 + 新功能验收 | PASS | 检查 **38 项全部通过**（C0 为 28 项），新增 10 项覆盖历史记录面板与复制结果；摘要「已检查 38 项行为：38 项通过。」 |
| 构建与提升 | PASS | v2 `build_status=passed`、`status=accepted`，`current_revision_id` 提升为 v2；v1 保留在历史中 |
| 真实模型调用 | PASS | coordinator / builder / reviewer 三角色 succeeded，Run `completed` |

## 二之三、C2（视觉增量）——**PASS（已提升）**

修好证据容量后（提交 `42a9037`：把内联的 480 KB 魔数改成具名且有依据的 `REVIEW_EVIDENCE_LIMIT_BYTES`），定点复测 Run `5a0e2b6e` **完成并通过**：

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| 产品完整检查 | **PASS** | `verdict=passed`，**44 项全部通过**（「已检查 44 项行为：44 项通过。」），五组齐全 |
| 版本递增与提升 | PASS | 产出 **v7**（`9e636513e0a6…`），`status=accepted`，`current_revision_id` 提升为 v7 |
| 真实源码变更 | PASS | v7 的 `source_hash` `9e636513e0a6…` ≠ C1 的 `1346ccafafc2…` |
| 零重复生成 | PASS | v3–v7 五个版本 `source_hash` **完全相同**，每次复测都复用已保存候选；协调者与 Builder 的模型调用为 0 |
| 旧功能保留 | PASS | 44 项里包含 C0/C1 的运算优先级、括号、小数、键盘、错误恢复与历史记录面板等既有行为 |

教训记录：这一条卡了四轮，前三次失败都只显示「浏览器或检查过程未完成」。**根因是评审证据容量，而不是作品行为**——真正的成本不在修复本身（一处具名常量），而在于没有任何诊断能指出它。补上诊断后一次就定位了。

## 二之四、C2 的历史状态（失败轮次，保留备查）

Run `dcbafb9e`，`base`/`expected` 冻结在 C1 的 revision `cc4a7ee9`（v2），Prompt 141 字。生成与构建成功（v3、`source_hash` `9e636513e0a6…`、`build_status=passed`），但**产品检查两次都未完成**：

| 轮次 | 结果 | 观测 |
| --- | --- | --- |
| 首次 `dcbafb9e` | `failed / CHECK_BLOCKED` | 五组全部 `blocked`、**0 项通过**；摘要「浏览器或检查过程未完成，当前候选尚未通过检查。」 |
| 定点复测 `e0d848b3` | `failed / CHECK_BLOCKED` | 同上，44 项全 `blocked`、0 通过 |

复测同样是**零重生成的定点复测**：事件「复用先前封存的计划与源码；协调者和 Builder 模型调用均为 0」，协调者与 Builder 的 token 用量为 0，v3 与 v4 的 `source_hash` 完全相同（`9e636513e0a6…`）。

`current_revision_id` **仍为 v2**——C2 没有被提升，v3/v4 保持候选状态。

### 已排除与尚未排除的原因

- **不是工具预算耗尽**：`REVIEW_TOOL_LIMIT = 280`（`apps/api/src/runtime/budgets.ts:44`），而两次评审实际只产生了 43 与 62 条 `tool.output`（对照：通过的 C1 是 93 条），且事件流里没有任何 `TOOL_BUDGET_EXCEEDED`、也没有 `role.failed` 事件携带显式错误。
- **不是重复生成**：两次产出同一源码 hash（见上）。
- **不是全局故障**：同一时段 C0（28 项）与 C1（38 项）都完整跑完并通过。

**最可能的原因**：C2 的可验证行为最多（**44 项**，C1 为 38 项）。评审器在只记录了部分行为的情况下结束了回合，于是返回通用兜底摘要——而**定点复测是从头重跑评审器（新浏览器会话），并不会从已保存的检查断点续跑**，所以行为集一大就反复无法完成。类型定义里其实已有检查断点的概念（`ReviewCheckpoint` 带 `provisional: true` 与 `completedBehaviorIds`），但复测路径没有使用它。

这条如果成立，是一个真实的能力缺口：**大行为集永远无法通过复查**，因为每次重试都从零开始。

### 继续定位（2026-09-25，本轮）

找到了通用文案的产生位置：`apps/api/src/generation/review.ts` 的 `catch` 分支。只有当错误码**既不在重抛列表**（`AGENT_OUTPUT_INVALID` / `TOKEN_BUDGET_EXCEEDED` / `TOOL_BUDGET_EXCEEDED` / `ROLE_NOT_ACTIVE` / `MODEL_FAILED` / `MODEL_REQUEST_TIMEOUT`）**也不在** `blockedReasons` 映射表里时，才会用那句通用兜底文案，并把全部行为标为 `blocked`。所以 C2 是一次**未分类异常**，而不是「评审器自行结束回合」——我上一条的猜测同样不准确，此处再更正。

**尝试过并已回退的改法**：把未分类的错误码写进摘要文案（`…未完成（CODE）…`）。这会立刻让下一次复测可诊断，但 `apps/api/tests/generation/review.test.ts` 里有一条**刻意写下的**断言否决它：

```
test('unknown diagnostic codes use the generic blocked message without reflecting raw data', …)
  expect(receipt.result.summary).toBe('浏览器或检查过程未完成，当前候选尚未通过检查。');
  expect(JSON.stringify(receipt)).not.toMatch(/RAW_SECRET|fixture-key|UNKNOWN_/);
```

夹具正是用一个形如 `UNKNOWN_RAW_SECRET_fixture-key` 的未知码来验证「未知码可能携带原始敏感数据，因此不得进入任何对外可见的结果」。这条不变量是对的，我的改法违背了它，因此**已完整回退**（`git checkout -- apps/api/src/generation/review.ts`，回退后测试恢复为仅剩已知的环境失败）。

**正确的修法**（留给下一轮）：把未分类的错误码记录在**服务端诊断通道**，而不是用户可见摘要。注意**日志里也不能直接打印原始码**——同一条测试的前提正是「未知码本身可能携带原始数据」（夹具的码就是 `UNKNOWN_RAW_SECRET_fixture-key`），所以诊断应当是**脱敏指纹**（例如码的 SHA-256 前缀 + 长度）或纯内部字段，而不是原文。

### 本轮又排除与收窄的（2026-09-25）

- **不是容量争用**：该时间窗内 `nano.sandboxes` 只有两条记录，分别是两次尝试各自的 `candidate-preview`，任一时刻只有 1 个沙箱存活（上限 2），评审器的浏览器没有被预览挤掉。
- **catch 分支会丢弃全部已有进度**：`result.items` 由 `input.handoff.plan.behaviors` 全量重建为 `blocked`，因此 C2 显示的「0/44 通过」并不代表评审器什么都没做成——它实际产生了 43 与 62 条 `tool.output`。**进度在异常时被整体丢弃**，这也是类型系统里 `ReviewCheckpoint`（`provisional: true`）想要解决的问题，但复测路径没有用它。
- **时间特征指向某个墙钟/空闲上限**：两次尝试都在**约 16–17 分钟**后失败，期间预览沙箱一直存活；对照 C1（38 项）整轮约 19 分钟却通过，而 C2 是 44 项、评审耗时最长。相关常量：`RUN_IDLE_TIMEOUT_MS = 360_000`（6 分钟空闲）、`SANDBOX_LEASE_SEGMENT_MS = 420_000`（7 分钟租约分段）、`REVIEW_TOOL_LIMIT = 280`（**已确定不是它**，实际只用 43/62 次）。

### 根因已锁定（2026-09-25，加诊断后一次读出）

按上一条的计划加了**脱敏指纹**诊断（提交 `a3ece36`：只记 `sha256(code)` 前 12 位与长度，不记原文，因此不违反 `review.test.ts` 钉住的不泄露原始数据不变量），部署后重跑 C2 定点复测，服务端日志给出：

```
[review] unclassified failure code=b09004710d57 length=13 reviewerStarted=true
```

把仓库里所有错误码字面量做同样的哈希比对，**唯一命中**：

| 码 | 长度 | sha256 前 12 位 |
| --- | --- | --- |
| `CHECK_BLOCKED` | 13 | `b09004710d57` ✓ |

而 `apps/api/src/runtime/reviewer.ts` 里抛 `CHECK_BLOCKED` 的四处**都不带 diagnosticCode**（266「浏览器观察来自错误会话或来源」、272「检查记录达到大小上限」、615「只能刷新本次候选预览」、797「检查浏览器关闭尚未确认」），因此它在 `review.ts` 里以裸码落入通用文案。

### 已实测确认（2026-09-25）

给那四个裸抛点补上 diagnosticCode 并部署（提交 `4fb41c4`）后重跑 C2 定点复测，检查摘要第一次说出了具体原因：

> **「本次检查的证据记录达到容量上限，已停止检查；这是检查侧的限制，不是作品行为不通过。」**

即 `REVIEW_EVIDENCE_TOO_LARGE`。**第 272 行的 480 KB 证据上限就是 C2 的根因**，此前它被渲染成通用文案，四轮排查都无法判断。

注：我曾试图用 `nano.run_events` 的载荷总量来验证体积假设，但那是**无效代理**——C2 第三次只有 114 条事件/45 kB 却仍失败，而 C0 有 219 条/126 kB 却通过。原因是评审器内部的 `evidence` 数组（每次观察的完整树与文本）**并不等于**持久化的 UI 事件。真正确认靠的是补上诊断码后的一次实测。

与现场最吻合的是**第 272 行**：

```
if(Buffer.byteLength(JSON.stringify([...evidence,event])) > 480*1024) throw fail(new RuntimeError('CHECK_BLOCKED','检查记录达到大小上限'));
```

即**评审证据日志的 480 KB 上限**。这一条解释了全部观测：

- C2 是行为最多的一轮（**44 项**；C0 为 28、C1 为 38），每个行为都要视觉证据，因此只有它撞上限；
- 失败发生在做了大量工作之后（43/62 条工具调用），不是一开始；
- 两次结果完全一致且都约 16–17 分钟——确定性上限，不是随机故障；
- 异常路径把 `plan.behaviors` 全量重建为 `blocked`，所以显示 0/44，掩盖了真实进度。

### 修法进度

2. ~~**让 `CHECK_BLOCKED` 说真话**~~：**已完成并实测确认**（提交 `4fb41c4`）。四个抛出点各自带上 diagnosticCode，`blockedReasons` 用用户能懂的话解释每一种；`review.test.ts` 仍 14/14 通过，故意敌对的未知码用例仍走通用文案，不泄露原始数据的不变量未被破坏。
1. **证据日志的容量（下一轮，约束已查清）**：480 KB 对「行为多 + 每项要视觉证据」的检查不够用。每次观察最多写入 12000 字符的可访问性树 + 12000 字符页面文本，因此上限只允许约 **20 次观察**，而 44 项行为的检查需要远多于此。

**我尝试的清空办法被测试否决了（已完整回退）**：我先把旧条目的树与文本清空、只保留最新一条，理由是「只读回 id」。结果打破了 `apps/api/tests/runtime/reviewer.test.ts` 里三条**有意设计的**断言：

- `earlier browser observations remain in Pi context until native compaction and saved evidence stays complete`
- `native Pi compaction keeps a long review running and old observations remain readable by ID`
- `Reviewer can retrieve an older complete observation without redoing its action`

也就是说**较早的观察是被刻意保留可读的**（在 Pi 上下文里直到原生压缩，并且可以按 ID 取回而不必重做动作）。清空它们会让评审器无法回看早先证据，是真实的能力回退。已用 `git revert` 完整回退，测试恢复为仅剩已知的环境失败。

**因此正确的修法必须同时满足两条**：容量有界，**且**旧观察仍可按 ID 取回完整内容。可行方向是把观察载荷移出这个有界数组、改存到按 ID 可检索的旁路存储（保留引用），而不是丢弃；或者作为阶段性办法调大上限，但要如实说明那只是把墙推到下一次更大的检查。

这一条改完后只需重跑 C2 的定点复测（复用已保存候选、零重生成）与受影响的检查路径，不需要重跑 C0/C1。

## 三、S0（Canvas 贪吃蛇）——**FAIL / BLOCKED**

项目 `85f84510-df6d-4419-bc13-4a38505c9fe4`，同样从空工程创建（创建时 revision 数 0），Run `8776b77a-ad2c-4380-88e0-10b581b474f0`，Prompt 151 字，`request_hash` `9c2f4ba9…`，同一冻结模型配置。

生成与构建本身成功（v1、`build_status=passed`、源码 `57f09ad12aed…`），但**产品检查未通过**：

| 轮次 | 结果 | 阻碍 |
| --- | --- | --- |
| 首次 Run `8776b77a` | `failed / CHECK_BLOCKED` | 14 项中 13 项通过，仅 **B12** blocked：「The stored high score is already 10 and cannot be reset through the UI; achieving a score greater than 10 in an automated session is not practical.」四组通过（核心游戏流程 3/3、输入与控制 3/3、结束与边界情况 3/3、界面布局与操作说明 2/2） |
| 定点复测 Run `d5fee601` | `failed / CHECK_BLOCKED` | 14 项中 9 项通过，**B02/B03/B08/B11/B12** blocked。评审器自述根因：「由于远程浏览器往返延迟，游戏在重置后约 1.5 秒内即撞墙结束，无法及时操控蛇头到达食物位置，因此未能实际观察到吃食物效果。」 |

复测是**真正的定点复测、零重复生成**：事件 `tool.output` 明确记录「复用先前封存的计划与源码；协调者和 Builder 模型调用均为 0。」协调者与 Builder 的 token 用量为空，且 v1 与 v2 的 `source_hash` **完全相同**（`57f09ad12aed…`）。

### 根因判断：验证手法受延迟限制，不是产品缺陷

贪吃蛇约 **143ms 走一格**（实测：t=0 `maxX=12` → t=1000ms `maxX=19`），从棋盘中心到墙只有约 1.3 秒。评审器通过远程浏览器逐次「读画布 → 发按键」，往返延迟使它来不及把蛇头引到食物就撞墙——这正是它第二次运行连吃食物都没完成的原因。

我自己的验证一开始也以同样方式失败（多次撞墙、分数 0）。**改为把控制循环放进页面内执行**（一次调用内完成读画布与发按键，不做逐格往返）后立刻成功。这证明产品行为正常，阻碍来自验证通道。

### 本票要求的 Canvas 行为——我独立复现的结果

| 行为 | 结果 | 观测 |
| --- | --- | --- |
| 开始 | PASS | 覆盖层「重新开始」启动游戏，蛇从中心以 4 格长度向右移动 |
| 四向控制 | PASS | 按 ↑ 后蛇身由横向（w=4,h=2）变为纵向（w=2,h=4） |
| 不能立即反向 | PASS | 朝上时按 ↓，蛇头继续向上（`minY` 8→6），未反向 |
| 空格暂停／继续 | PASS | 暂停后位置冻结（`maxX` 14→14），再按空格恢复移动（15→18） |
| 吃食增长计分 | PASS | 吃到食物后分数 0→10，蛇身采样数 8→10（+1 格） |
| 撞墙结束 | PASS（两次） | 先在右墙、后在顶墙结束，覆盖层显示「游戏结束 本局分数：10」 |
| 重开 | PASS | 覆盖层「重新开始」可再次开局 |
| 同 origin 最高分刷新保留 | PASS | 结束时 `最高分` 更新为 10，`localStorage['snake-best-score']="10"`，整页重载后仍为 10 |
| 移动端方向按钮可操作 | PASS | 点击 ▼ 后蛇向下移动（`maxY` 17→20） |
| 390×844 布局 | PASS | `scrollWidth = 390 = innerWidth`；棋盘 350×350（右边界 370）；四个方向键各 72×72、右边界 151/231/311、均在棋盘下方；操作说明可见 |
| 自碰结束 | NOT_RUN（独立确认） | 我的按键时序未能构造出自碰；产品检查的「结束与边界情况」组 3/3 通过，由评审器在其浏览器内覆盖 |

原始截图与脚本：`artifacts/a-rc-2026-09-25/snake-s0-score10-gameover-1440.png`、`snake-s0-390x844.png` 与同目录的 Canvas 驱动脚本。

## 四、尚未执行（本票剩余）

- 计算器 C0→功能 C1→视觉 C2 → **回滚到 C1** → 基于 C1 的 C3（四次真实业务提交）。
- 两件作品的永久发布与匿名访问、回收临时预览后永久地址仍可用。
- 原会话重登与全新无存储会话登录同一 A 的核对；B 账号隔离（A07 已覆盖账号隔离，本票需复核本轮新资源）。
- 冻结提交的最终四处 SHA 一致性（本记录所在的文档/脚本提交晚于 F，产品代码未变；最终需与部署对齐）。

## 五、需要决策的一件事

S0 的产品检查连续两轮 `blocked`，阻碍都在**评审器驱动实时 Canvas 游戏的通道**上，而不是产品行为。要让 S0 取得可发布的已验收版本，有两条路：

1. 让评审器把控制循环放进页面内执行（类似我的做法）——这是对验证能力的定点修复，之后实时交互类作品都能被真实验收；
2. 保持现状，把 S0 记为 FAIL/BLOCKED 并在票据上写明阻碍。

我倾向第 1 条，因为它修的是真实能力缺口（评审器目前无法验收任何实时交互作品），而不是为了让某一条断言变绿；但它会改动 Reviewer 的策略，需要更新冻结提交并只重测受影响路径。这一点我先说明，不擅自扩大改动范围。

## 六、更正（2026-09-25 复核后）

上一条的判断不完整，此处更正：**评审器并不缺少批量交互能力**。核对 `apps/api/src/runtime/reviewer.ts` 后确认：

- 工具面里已经有 `browser_key_batch`：「Native short keyboard batch for timer-driven Canvas games: 1–8 real key taps, each wait 0–1000ms, total wait at most 4000ms」（reviewer.ts:152、538-556）；
- 提示词里有一整段专门针对贪吃蛇的策略（reviewer.ts:395）：明确说明 `browser_steps` 的逐键远程往返会超过 150ms 的游戏 tick、因此不适用于引导移动中的蛇；并规定了正确做法——「Once Start focus is known, use one native browser_key_batch for Tab if needed, Enter to activate the focused Start button, then Space to pause immediately, with no model turn or page observation between keys」；还要求每次吃到食物后暂停、看清新食物位置再规划下一段短路径。

所以阻碍不是「没有能力」，而是**开始路径的原子性**：批量能力只发按键，启动游戏要么靠 `browser_click`（独占一轮模型往返，蛇在下一轮之前就已撞墙——评审器自述的「约 1.5 秒内即撞墙结束」正是这个症状），要么靠 Tab+Enter 落在「开始」按钮上。评审器两次都没能走通这条原子路径，于是退化成单独点击开始，随后无法挽回。

这把修复方向从「新增能力」改成了两件更小的事之一：
1. 让「开始」在键盘上可靠可达（确认/修正焦点顺序，使 Tab+Enter+Space 的三步批量真的能一次完成）；
2. 或者让游戏本身在首次方向键/空格时才开始计时（开始前保持暂停），这样一次批量就能「开始并立即暂停」。

第 2 条同时是更好的用户体验（玩家不会还没准备好就被时钟杀死），但它属于产品行为改动，需要新的生成，因此要按规则评估是否在 S0 的失败重测范围内。
