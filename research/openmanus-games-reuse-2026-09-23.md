# OpenManus / Manus 与小游戏浏览器反馈复用核查

调研时间：2026-09-23。范围：官方仓库、官方产品文档、固定提交源码及上游测试；不修改 Pivloom 业务代码，不调用生产模型，不把源码检查写成端到端实测。

## 结论

1. **不需要把 Pivloom 从 Pi 换成 OpenManus。** OpenManus 是通用工具调用 Agent，可借鉴其“工具返回截图 → 真正的图像消息 → 下一轮模型”的数据流。它没有提供经本次核查证明的、可直接覆盖 Pivloom 要求的“小游戏生成、独立浏览器验收、两轮增量、账号隔离、项目版本回滚”完整实现。
2. **Manus 的确公开提供 Create games 入口，但不是可下载的 Agent 源码。** 官方 Code Control 文档说的是用户所生成应用的源码可导出，不能据此认定 Manus 自己的 Agent、沙箱调度和验收器开源。[官网](https://manus.im/)、[Code Control](https://manus.im/docs/website-builder/code-control)
3. **最合适的最小移植组合**：保留 Pi + OpenSandbox + 当前 agent-browser；借鉴 OpenManus 的图片反馈协议，以及 OpenAI 历史 `develop-web-game` recipe 的短输入、观测、截图核验、修复循环。不是另起一个 Python Agent 系统，也不是为了方便验证把 Canvas 贪吃蛇缩成 DOM 方格。
4. `develop-web-game` 是有明确目录许可证的可复制历史代码，但已从官方 main 删除；不得称为目前持续维护的现成游戏验收服务。其脚本只采集运行证据，不自行判定“玩法正确”。

## 来源、版本与许可

| 对象 | 本次固定证据 | 活跃度辅助数据 | 许可和使用边界 |
|---|---|---|---|
| [FoundationAgents/OpenManus](https://github.com/FoundationAgents/OpenManus) | `3309bf4e416fb1c74b008f3e86494439a31bad53`；main 提交日期 2026-08-16 | 58,388 stars；仓库 pushed_at 2026-08-22 | 根目录 [MIT](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/LICENSE)，保留版权和许可；本次 tree 中仅找到该 LICENSE。不能把仓库 MIT 当作其所有外部依赖的许可。 |
| [mannaandpoem/OpenManus](https://github.com/mannaandpoem/OpenManus) | GitHub API 当前返回独立仓库，并非重定向到 FoundationAgents | 671 stars；pushed_at 2025-06-21；API license 为 null | 不选它作为直接复制来源；避免沿用旧教程仓库地址。 |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`，main 日期 2026-09-15；pyproject 版本 `0.13.10` | 116,034 stars；pushed_at 2026-09-18 | 根 [MIT](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/LICENSE)；依赖 `browser-harness==0.1.13`。本次没有继续审计该传递依赖，故不提出整套引入。 |
| [openai/skills 历史 develop-web-game](https://github.com/openai/skills/tree/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game) | 删除前提交 `30444aed500c00c85294d12074f6e3ee794f808a` | 技能 2026-04-23 从 main 删除；仓库当前 27,572 stars 不能证明此技能仍维护 | 技能目录独立 [Apache-2.0](https://github.com/openai/skills/blob/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game/LICENSE.txt)；直接移植时保留许可、上游来源并标记改动。不能只看 GitHub 仓库 license=null 就否定这个目录的许可。 |

Stars 与 pushed_at 是当次 GitHub API 快照，只用于识别项目，不作为功能或可靠性的证据。main SHA 的提交时间和仓库 pushed_at 不同，分别列出。

## OpenManus 真实调用链

### 默认执行模式

`Manus.create` → `initialize_mcp_servers` → `ToolCallAgent.think` → `LLM.ask_tool` → `ToolCallAgent.act` → `execute_tool` → `ToolCollection.execute` → 工具结果进入 memory → 下一轮 `think`。

- 默认本地工具是 `PythonExecute`、`StrReplaceEditor`、`AskHuman`、`Terminate`；`Manus.max_steps=20`，不是 Pivloom 的长任务持久化实现。[manus.py L41-L80](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/manus.py#L41)
- 编辑器有 create/view/str_replace/insert/undo_edit；通过 `FileOperator` 选择本地或 sandbox。这里的 undo 是单文件编辑历史，不是平台项目、源码、Preview、对话一起切换的版本回滚。[str_replace_editor.py L19-L157](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/tool/str_replace_editor.py#L19)
- `PythonExecute` 创建本机子进程执行 Python，超时 terminate。其 `safe_globals` 仍含 Python builtins，不能把名称中的 safety 当作多租户代码隔离方案。Pivloom 应继续把生成代码留在 OpenSandbox。[python_execute.py L39-L75](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/tool/python_execute.py#L39)
- BaseAgent 的 loop、重复响应检测与 cleanup 是进程内机制；没有从这些文件得到持久化任务恢复、幂等重试或数据库终态一致性的证据。不能因它能写网页就拿来代替现有生命周期修复。[base.py L116-L186](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/base.py#L116)

### 浏览器实现已经变更，不能照旧教程抄

当前默认 `Manus` 启动 `uvx browser-use --cli-mcp`，接收 `browser_exec`、`browser_screenshot` 及服务器提供的 skill instructions。`BrowserAgent` 也走该 MCP 服务。上游调用没有固定 browser-use 版本，Pivloom 如果未来选此路线必须自己 pin，不能照搬浮动 `uvx` 启动命令。[默认接入](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/manus.py#L18)、[BrowserAgent](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/browser.py#L83)

当前 Browser Use MCP 的机制是：

- 一个持久 Python namespace 和执行锁，跨工具调用复用浏览器会话；工具描述暴露导航、点击、输入、JavaScript、CDP 和等待 helpers。
- `browser_screenshot` 读取截图并返回真正的 MCP `ImageContent(image/png)`，不是一个图片路径字符串。
- `browser_exec` 是通用 Python 执行入口，不是预定义的游戏验收器；异常会打印到工具文本中。这不能自动等同平台结构化检查失败。

证据：[cli_mcp.py L32-L158](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/mcp/cli_mcp.py#L32)、[依赖声明](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/pyproject.toml#L50)。

另一个 `SandboxManus` 路径仍使用 Daytona 的 `SandboxBrowserTool`，含 send_keys、wait、click_coordinates、drag_drop 等动作；它要调用 sandbox 内部 `localhost:8003/api/automation`。这套 Python/Daytona 接口不能原样插入 OpenSandbox。[SandboxManus](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/sandbox_agent.py#L5)、[动作 schema 与执行](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/tool/sandbox/sb_browser_tool.py#L36)

## 截图必须真正进入模型；OpenManus 也有不能照抄的边界

可复用的协议证据：

1. `MCPClientTool.execute` 从 MCP 返回的 content 中分别取 TextContent 和第一个 ImageContent，保存到 ToolResult。[mcp.py L21-L44](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/tool/mcp.py#L21)
2. `ToolCallAgent.act` 先完成正常 tool reply，再把图片加入独立 user 图像消息，避免图片和工具调用协议相互混乱。[toolcall.py L131-L172](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/agent/toolcall.py#L131)
3. 有 upstream tests 验证原生工具名、skill instructions、图片转发以及 tool message 后的图像消息顺序。[test_browser_use_mcp.py L66-L149](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/tests/tools/test_browser_use_mcp.py#L66)

不能原样复制：

- `LLM.ask_tool` 只用硬编码 `MULTIMODAL_MODELS` 判定支持图像；不在名单中的模型，`format_messages` 会删除图片。名单只有 gpt-4-vision-preview、gpt-4o、gpt-4o-mini 和三个旧 Claude 名称，不能支持“换任意模型就自动看图”的主张。[名单](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/llm.py#L35)、[删除图像分支](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/llm.py#L304)、[调用点](https://github.com/FoundationAgents/OpenManus/blob/3309bf4e416fb1c74b008f3e86494439a31bad53/app/llm.py#L680)
- MCP 图片只取第一张，且数据模型没有保留输入 MIME，LLM formatter 固定构造 `image/jpeg` URL；应在 Pi adapter 保留真实 `mimeType` 和相应图片顺序，不复制这个简化。
- 上述测试使用 FakeSession/ImageTool，证明协议转发，不证明真实 LLM 能识别棋盘，不证明真实 Chromium 按键成功，也不证明小游戏玩法通过。此次检查没有运行这些测试，结论来自读取测试断言。

Pivloom 应复用 Pi 自身的图像 content 类型和模型能力声明，并加一次真实图像输入兼容性验收。用户已有的 `glm-5.3-flash` endpoint 不能仅凭模型名假定看图；不支持时，必须显示“视觉未验证/需视觉 Reviewer”，不能以 DOM 文本或截图文件存在替代视觉通过。对具备图像输入的 Reviewer，还应保留实际带图请求和返回的脱敏证据。

## 可以固定版本移植的小游戏 recipe

OpenAI 官方历史技能 `develop-web-game` 对 Canvas 游戏的建议与本次缺口吻合：小步修改，短动作 burst，暂停观察，截图与状态核对，然后修改。它明确要求进入实际 gameplay，而不只截主菜单。[固定版本 SKILL.md](https://github.com/openai/skills/blob/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game/SKILL.md)

配套 357 行 JavaScript 客户端可定位为以下复用块：

| 上游块 | 可移植内容 | 本次边界 |
|---|---|---|
| [L58-L67](https://github.com/openai/skills/blob/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game/scripts/web_game_playwright_client.js#L58) | 四方向、Enter、Space 等按键命名 | 接到现有 agent-browser 原生按键接口；不是替换为 Playwright 产品浏览器 |
| [L227-L260](https://github.com/openai/skills/blob/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game/scripts/web_game_playwright_client.js#L227) | keydown → 短时推进 → keyup，以及鼠标动作序列 | 短操作序列应一次执行，不能每帧等待模型决策；错误/取消时释放按键 |
| [L127-L205](https://github.com/openai/skills/blob/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game/scripts/web_game_playwright_client.js#L127) | Canvas 截图、空白透明检查、截图回退 | Pivloom 同时要留整页图，Canvas 外的得分、按钮和错误不能被裁掉 |
| [L207-L225、L273-L279](https://github.com/openai/skills/blob/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game/scripts/web_game_playwright_client.js#L207) | console.error/pageerror 采集和去重 | 映射到真实 Check 失败，不是只写日志 |
| [L322-L347](https://github.com/openai/skills/blob/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game/scripts/web_game_playwright_client.js#L322) | 每次 burst 后保存截图、可选文本状态、错误记录 | 采集成功与玩法通过是两个不同结论 |

该目录有 Apache-2.0，但在 [删除提交 11c6438](https://github.com/openai/skills/commit/11c643813b4645ca9f25d49ca180697732e0141a) 中于 2026-04-23 移出 main。可 pin 历史来源移植并自己维护，不能用搜索引擎仍缓存的 main 页面声称它现在仍可直接安装。

尤其不能复制为验收结论的三处：

1. 客户端看到 console errors 后写 JSON、break，随后正常 `browser.close()`；**退出码 0 并不证明没有错误**。
2. `makeVirtualTimeShim` 默认的 `advanceTime` 实际基于真实 `requestAnimationFrame` 等待，并未冻结所有计时器；只有游戏自身实现确定性时间推进才可能达到该语义。不要把注入了一个同名函数叫作确定性游戏测试。[L77-L125](https://github.com/openai/skills/blob/30444aed500c00c85294d12074f6e3ee794f808a/skills/.curated/develop-web-game/scripts/web_game_playwright_client.js#L77)
3. `render_game_to_text` 是被测应用自报的状态。它可以帮助定位，却不能取代真实输入、Canvas 截图和可见结果，更不能向它写入成功状态冒充操作结果。

本轮优先移植动作与观测方法，不强制所有生成作品提供测试专用 hook。不把此技能整包安装成新框架；不要求用户放弃 Canvas。

## Pivloom 最小落地范围

| 能力 | 直接采用/移植 | 保留的平台职责 |
|---|---|---|
| 模型和 Agent loop | Pi；不复制 OpenManus 的 Python loop、token上限和多模态白名单 | Run/Revision 持久化、取消、超时、重试、资源清理继续由平台实现并实测 |
| 写代码和运行 | 继续现有 Pi 工具 + OpenSandbox | workspace、构建、版本归属、租户隔离 |
| 浏览器操作 | 现有 agent-browser `0.38.1` 的原生 batch/press/wait/截图；移植短动作流程 | 每个 Run 独立会话，取消和失败清理，限定对应 Preview |
| 图像反馈 | OpenManus 的工具结果图像传递模式；使用 Pi 的实际图像 content | model input capability 与真实 endpoint 兼容性；保留 MIME、对应动作、revision |
| 游戏玩法判断 | Canvas 画面 + 真实按键 + 短时间序列；状态文本仅辅助 | requirement/check 对应关系、原始证据和独立判定，不能以“模型说完成”代替 |
| 长时间实时运动 | 小段原生浏览器操作合并执行；有正常暂停操作时，操作后暂停观察 | 如 Space 是用户要求的游戏暂停，必须先实测暂停/恢复，不注入隐藏冻结状态 |

采用 Space 暂停是测试策略，不是硬性要求每种游戏都用 Space。没有暂停功能的游戏应以批量输入及时截取阶段结果，不让模型延迟变成几十秒无人操作，也不私改游戏规则来拿通过结果。

## 应加入技术复核 E2E 的具体内容

以下是待执行验收要求，不是已通过结论；可合并入主方案的测试矩阵。

1. **真实非模板生成**：空项目分别下发计算器和 Canvas 贪吃蛇 Prompt。保留真实 provider/model 调用记录、流式事件、保存源码及版本；证明两个产物功能与代码不同，不能只是换标题/颜色。通用 Vite 工程骨架可以复用，游戏业务逻辑不能预置成固定答案。
2. **图像协议与真实能力**：浏览器操作后的 PNG 对应当前 Revision；Reviewer 实际收到图像数据及正确 MIME，而不只是 object URL/hash。通过真实图像问答确认 endpoint 能看图；纯文本模型不能获得视觉 pass。
3. **Canvas 游戏交互**：进入游戏、至少两个方向转向、按 Prompt 要求吃到食物并增长/加分、撞墙或撞自身后的结束、重新开始；有暂停时验证暂停期间画面不推进、恢复后继续。必须保存 gameplay 阶段画面和动作顺序；页面源码和开始菜单不能单独当通过证据。
4. **按键和时序回归**：四方向/Space/Enter 接口都能送达正确会话；一次动作序列中的按下、等待、释放顺序可核对；取消/异常后无残留按键和浏览器进程。不要把所有方向键当作必然适用于每一个 Prompt，按实际产品要求选用。
5. **负例不误报**：运行时抛错、Canvas 空白、输入无响应、只有菜单能显示时，相关 Check 必须失败或明确未验证；工具退出 0、截图存在、模型文字自称成功都不能单独提升为 pass。
6. **两轮增量**：同一项目一轮玩法功能、一轮视觉/字段修改；逐轮核对源码差异与真实 Preview，重新执行此前需求。Canvas 视觉修改必须用图像验证，不能仅检查 CSS 字符串；5/5 的五个检查组必须覆盖全部历史有效要求，而非删掉旧检查凑数。
7. **回滚和隔离仍独立验收**：这些候选没有替 Pivloom 解决租户项目、对话、源码、版本、Preview 一致性；主测试矩阵仍必须做新会话、退出重登、第二账号拒绝读取及旧版本切换后四类状态一致。

## 调研方法与证据限制

- 按 `agent-reach` 的 GitHub/gh 后端查询 repository metadata、tree、commits 和 contents；主网页用官方 Manus 文档。没有以 Reddit、教程或演示视频证明实现能力。
- 临时源码置于 `/tmp/pivloom-research-openmanus`、`/tmp/pivloom-research-browser-use`、`/tmp/pivloom-research-webgame-skill`。用 codebase-memory-mcp 建图、trace/search，再用 codegraph 定点读取。
- OpenManus 图索引把 `tests/tools`、`examples` 排除在默认索引外；本次另用 Git tree 核对完整目录、用 codegraph 读 `test_browser_use_mcp.py`。`tests/` 共四个 sandbox 测试文件和一个 browser MCP 协议测试文件；example 是日本旅行网页样本。**本次固定提交范围内未找到游戏玩法端到端测试，不把它说成经过成熟小游戏验收的专用 Agent。**
- OpenAI 历史技能只有 recipe/采集脚本，未看到它自身的独立自动断言套件。此报告没有运行上游 Agent、没有新生成游戏，故复用建议必须由下一阶段 Pivloom 真模型与真浏览器测试完成证明。
- `agent-reach check-update`：当前 v1.5.0，返回已是最新版本。
