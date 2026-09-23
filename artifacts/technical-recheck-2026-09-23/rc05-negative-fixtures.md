# RC-05 · Canvas 负例隔离复核

关联 [#21](https://github.com/hengworkinggit/pivloom/issues/21)。本次只使用独立 worktree、本地 HTTP 夹具、Chromium 和真实 Pi Reviewer 循环；未连接生产数据库、测试账号或 OpenSandbox，未调用真实 Provider、未部署。基线提交 `7c9244acba2131f08dab43932bbec427da1a294e`，Node `24.19.0`，`agent-browser 0.38.1`。临时本地浏览器会话与 HTTP 服务在探针结束时关闭。

## 已证实的运行时误判

[两个红回归测试](../../apps/api/tests/runtime/reviewer.test.ts)把计划行为明确设为“发送 ArrowRight 并观察 Canvas 上的蛇改变方向”，使用本地真实浏览器生成的[空白 Canvas 首屏](rc05-negative-fixtures/blank-page-initial.png)和[只有菜单首屏](rc05-negative-fixtures/menu-page-initial.png)作为 Pi 工具图像。隔离 Provider 只模拟工具选择和错误的 `passed` 结论；Pi session、图片 ToolResult 传输、Reviewer 证据校验实际运行，`requireVisionEvidence=true`。

两例均仅执行 `browser_open → browser_screenshot → record_behavior(passed)`。后续 Pi 请求确实包含各自 PNG，Revision/SourceHash、截图工件与观察 ID 均绑定；没有点击、按键或 key batch。**实际结果仍为 `passed`，测试期望拒绝而红（2 failed / 72 skipped）**。这不是模型是否能读懂画面的争议：Reviewer 的协议层允许通用 `renderedEvidence` 代替交互动作。定位为 `apps/api/src/runtime/reviewer.ts` 的 `itemProblem` 内 renderedEvidence/actionEvidence 判定。现有“静态渲染”单测实际沿用了“填写并添加”交互计划，却断言仅首屏截图可通过，测试前提也需一并修正。

原始失败信息：`expected 'passed' not to be 'passed'`；两例的图像进入 Provider 请求断言、零动作断言均通过，失败只发生在最后的通过判定。原有三个键盘协议测试（成功 batch、失败输入被 blocked、不完整序列重试不得清除失败）仍为 3/3 通过，说明传输失败保护与这次的“没有动作也可过”是不同问题。

## 本地真实浏览器负例画面

[夹具源码](../../apps/api/tests/fixtures/canvas-negative/index.html)由临时 localhost 服务提供。[探针脚本](../../apps/api/tests/fixtures/canvas-negative/probe.mjs)固定 `agent-browser 0.38.1`，实际点击“开始”，随后以原生 JSON stdin `batch --bail` 发送方向键/空格和 100ms wait，再保存 Canvas 与整页 PNG、HUD、逐项执行结果、console/pageerror；[原始脱敏记录](rc05-negative-fixtures/manifest.json)可复查。

| 负例 | 浏览器动作和画面结果 | 为什么不能通过 |
| --- | --- | --- |
| 空白 Canvas | 右、下、空格均返回 success，Canvas 前后哈希相同；HUD 步数变 2、状态 paused；[画面](rc05-negative-fixtures/blank-page-after.png) | 只有文本变化，棋盘始终全白。 |
| 只有菜单 | 点击开始及右、下、空格后仍是 menu，Canvas 前后相同；[画面](rc05-negative-fixtures/menu-page-after.png) | `press` 成功不等于游戏已启动。 |
| 键盘断线 | 点击开始后右、下、空格命令均 success，但 HUD 最近按键仍为“无”、步数 0，Canvas 不变；[画面](rc05-negative-fixtures/disconnected-page-after.png) | 浏览器发出按键但应用没有响应。 |
| 假计分、不增长 | 右、下后 HUD 分数由 0 到 2，长度保持 3，Canvas 前后相同；[画面](rc05-negative-fixtures/fake-score-page-after.png) | 计分文本不能证明蛇吃食或增长。 |
| 碰撞无效 | 连续 8 次向右穿过右墙仍是 playing、步数 8，画面在左边重新出现蛇；[画面](rc05-negative-fixtures/no-collision-page-after.png) | 应结束而未结束。 |

五组本地浏览器动作命令均返回 success，pageerror 均为空；这恰好说明退出码、无异常和 HUD 不能替代视觉/行为验收。本地浏览器结果**尚未经过产品 Reviewer 或真实 Provider**，不记为 E34/E42 通过。两张首屏 PNG 的 Pi 负例证明协议漏洞，但 Provider 是模拟的，不记为真实 Provider 模型判读结果。完整真实小游戏 E42 仍归 #27。

建议主线先拒绝交互行为的纯渲染证据，并把“静态行为”测试改为真正无需动作的计划；合入红用例复测。之后让已部署 Reviewer 在独立空闲沙箱上面对这五种夹具，以真实视觉模型分别输出 failed/blocked，并保留动作后截图、分项 Check、源版本绑定和清理确认。
