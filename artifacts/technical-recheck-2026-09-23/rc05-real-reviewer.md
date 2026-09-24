# RC-05 · 真实 Provider 的 Canvas 正反例闭环

关联 [#20](https://github.com/hengworkinggit/pivloom/issues/20)、[#21](https://github.com/hengworkinggit/pivloom/issues/21)。复核时公开 Web/API `/version` 均为 `4733d3a2c860418f6c71a95535c800887d055be2`；测试源码从同一提交的独立 worktree 运行。Pi `0.86.1`、OpenSandbox 内 `agent-browser 0.38.1`；Provider 使用平台已验证模型配置，只读解密于内存，密钥和请求头未落盘。隔离的 Run/Revision/浏览器 Session 是随机 ID，没有生产项目、Run、数据库或 Storage 写入。

**远端正例通过，远端空白画布负例正确失败。** 两者都使用产品 `RemoteBrowser`、真实 OpenSandbox、原生按键 batch、真实 PNG ToolResult 和真实 Provider 最终判定。每例前几轮工具选择由测试脚本固定，用来保证输入与截图顺序；最后的 `record_behavior` 和 verdict 由真实模型作出，未由脚本预设。每例两张 PNG 均出现在成功发送的模型请求中，Check 引用当前 Revision、SourceHash、浏览器 Session、动作 observation 与动作后 screenshot。

[独立绑定审计](rc05-binding-audit.json)逐例核对：batch 每步成功、动作事件 ID 被 Check 引用、动作后第二张截图工件 ID 被引用、落盘 PNG SHA-256 与原始 Check 工件相同、真实 Provider 请求携带两图、无 pageerror、浏览器确认关闭。远端两例及本地五个补证案例均满足这些机械条件；判定内容仍以各自真实模型结果为准。

| 受控案例 | 动作与观测 | Provider 判定 | 原始证据 |
| --- | --- | --- | --- |
| 正例：方向键和暂停（OpenSandbox） | `ArrowUp→Right→Down→Left→Space` 五步均 success；画面从绿色 R 变为灰色 L，HUD 为 `DIR:LEFT STATUS:PAUSED TRAIL:START>UP>RIGHT>DOWN>LEFT>PAUSE` | `passed`，1 次真实 Provider 请求携带 2 图，pageerror 0 | [前图](rc05-remote-negative/positive-1.png)、[后图](rc05-remote-negative/positive-2.png)、[原始结果](rc05-remote-negative/result-positive-first.json) |
| 负例：空白 Canvas（OpenSandbox） | 点击开始，再按右、下、空格；三步 success，HUD 显示状态/步数变化，但 Canvas 没有蛇或食物 | `failed`，2 次真实 Provider 请求携带 2 图，pageerror 0 | [前图](rc05-remote-negative/blank-1.png)、[后图](rc05-remote-negative/blank-2.png)、[原始结果](rc05-remote-negative/result.json) |
| 负例：只有菜单（本地 Chrome） | 点击开始和三次按键均成功，但仍为 menu | `failed`，2 图入真实 Provider | [后图](rc05-local-negative/menu-2.png)、[原始结果](rc05-local-negative/menu.json) |
| 负例：键盘输入断线（本地 Chrome） | 浏览器按键三步 success，应用最近按键始终“无”、步数 0 | `failed`，2 图入真实 Provider | [后图](rc05-local-negative/disconnected-2.png)、[原始结果](rc05-local-negative/disconnected.json) |
| 负例：假计分/蛇不增长（本地 Chrome） | 按右、下后分数 0→2，但长度仍为 3，Canvas 蛇不变 | `failed`，2 图入真实 Provider | [后图](rc05-local-negative/fake-score-2.png)、[原始结果](rc05-local-negative/fake-score.json) |
| 负例：碰撞失效（本地 Chrome） | 连续八次右键后穿过右墙，HUD 仍为 playing | `failed`，2 图入真实 Provider | [后图](rc05-local-negative/no-collision-2.png)、[原始结果](rc05-local-negative/no-collision.json) |

本地四项仍走产品 `RemoteBrowser` 和 Pi Reviewer，唯一替换的是 `WorkspacePort` 的命令/PNG 读写桥接到本机固定版本 Chrome，而不是 OpenSandbox。四项截图与按键来自真实浏览器；所有 pageerror 为空。它们补强模型对画面与 HUD 的判断，但不能冒充已部署沙箱里的四项 E42 结果。空白画布还有[本地同路径复测](rc05-local-negative/blank.json)，同样为 `failed`。真实生成贪吃蛇完整 E42 仍归 #27。

首轮单沙箱连续跑“正例→空白→假计分”时，正例通过，后两例在新浏览器 Session 第一次 `browser_open` 时 `CHECK_BLOCKED`，未走到 Provider（见[首轮结果](rc05-remote-negative/result-positive-first.json)）。因此这两次不能算负例判定。随后在另一条空闲沙箱中把空白例放到**唯一首例**，动作、截图、Provider 判定全部完成并得到 `failed`。目前只能确认故障与连续新会话路径相关，尚未定位是浏览器进程、沙箱资源还是适配器命令；应单独诊断，不能记为 Canvas 功能失败或略过后续远端负例。

两条临时 OpenSandbox 均执行 `destroy` 且 `confirmed=true`，又分别用全新 SDK client `connect/getInfo` 独立得到 HTTP 404。完成后只读核对生产 `active_or_unclean=0`、`retained_sandboxes=0`；本地临时 HTTP 服务及全部夹具浏览器 Session 已关闭。[远端复现脚本](../../apps/api/tests/fixtures/canvas-negative/remote-reviewer-probe.mts)和[本地补证脚本](../../apps/api/tests/fixtures/canvas-negative/local-reviewer-probe.mts)均不含密钥。
