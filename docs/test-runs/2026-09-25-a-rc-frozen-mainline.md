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
