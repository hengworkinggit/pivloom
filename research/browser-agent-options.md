# 浏览器 Agent：替代“只写 Playwright 脚本”的方案

> 候选调研已收敛：正式选择agent-browser 0.38.1，并完成隔离浏览器的画面/点击及Dyad tagger轻量实测。当前依据见 [浏览器技术定稿](browser-decision-v2.md) 和 [完整实施蓝图](implementation-blueprint.md)。

核实日期：2026-09-21。本轮查阅官方仓库、文档、许可与 GitHub 元数据；未安装运行、未进行成功率/延迟基准。以下选型为待验证的工程判断。

## 当前建议

第一候选是 **agent-browser**：用户强调的是像 Codex 一样内置、能看见 Agent 自己打开和操作网页，它当前提供的 live viewport、dashboard、动作事件和浏览器工具最直接对应这个需求。**Midscene** 更适合自然语言视觉检查。先接一种基础浏览器控制方案，确实需要模型视觉断言时再增加 Midscene，避免同时维护多个重叠会话和 Agent 循环。

Playwright 是执行底层；真正缺少的是持续会话、页面观察、模型决策、操作反馈与修复循环。不能以换掉底层库推断验证成功率提高。OpenAI 官方 CUA 示例的 JS 实现也使用 Playwright。

## 候选与边界

| 项目 | Stars 快照 / 许可 | 已核实能力 | 对本项目的判断 |
|---|---|---|---|
| [agent-browser](https://github.com/vercel-labs/agent-browser) | 42,975 / Apache-2.0 | Rust daemon 直接 CDP；可访问性快照和元素引用、截图、console/network；持久 session；WebSocket 浏览器帧流和输入转发；自带 dashboard 的实时画面、动作流、console | 首先验证它能否提供我们需要的内置浏览器体验。由现有编程/修复 Agent 调用工具即可，无需启用它自己的 AI Chat |
| [Midscene](https://github.com/web-infra-dev/midscene) | 14,962 / MIT | 截图驱动的 aiAct、aiAssert、结构化查询；HTML 过程报告；Playwright/Puppeteer/Chrome Bridge | 当任务是“主按钮被遮挡吗”“提交后反馈是否清楚”时更贴合；模型断言仍可能错，报告不是默认产品首页 |
| [Browser Use](https://github.com/browser-use/browser-use) | 115,680 / MIT | 完整浏览器 Agent；页面结构与视觉；本地/云、自选模型 | 独立 QA 子代理的候选，已有自己的运行循环；不要与主 Agent 无限制相互委派 |
| [Browser Use Pi](https://github.com/browser-use/browser-use-pi) | 334 / MIT | TypeScript/Pi 浏览器 Agent；持久 REPL、CDP、截图、AX、动作高亮、录像；预算、followUp、结构化结果 | 很贴近 Pi，但不能借主仓 11 万 stars 声称自身成熟；未核实有现成可自托管 live-view Web 组件，无 GitHub release |
| [Stagehand](https://github.com/browserbase/stagehand) | 24,709 / MIT | 当前 v4 文档有 act/observe/extract 和多框架集成；官方 Pi extension 注册 run/snapshot/screenshot，每 Pi session 一个浏览器 | 已选 Pi 时值得做小实验；Pi extension 明确 experimental、随源码发布，当前 main/docs v4 与 GitHub latest release v3.7.3 存在版本差异，不能混用示例 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 52,414 / Apache-2.0 | 浏览器操作、截图、网络、console、性能信息；MCP 与 CLI；底层 Puppeteer | 偏开发调试反馈完整的工具层；可直接参考 Gemini CLI 的内置 browser_agent 组织方式 |
| [OpenAI CUA sample app](https://github.com/openai/openai-cua-sample-app) | 1,867 / MIT | 持久浏览器/桌面环境、模型自主操作、截图回传、控制台、trace/replay；JS+Playwright 和 Python+PyAutoGUI | 学习与运行参考应用；不是 Codex 桌面内置浏览器的公开原版，不附完整生产沙箱与权限系统 |

## agent-browser 如何接进产品

建议链路：生成/修复 Runner → 调用浏览器工具 → 真实 Chrome 打开该版本预览 → 获取截图、实际操作结果和运行错误 → Runner 修改代码 → 再次检查。浏览器的实时画面和动作事件可以在产品旁边展示，默认给用户“正在试用”“发现问题，正在修复”等简明状态。

主 Agent 已有模型时，使用 CLI/MCP 工具接口即可。仓库内置 AI Chat 是另一个可选入口，要求 Vercel AI Gateway 配置，并不是使用浏览器工具的必要依赖。当前 README 的 dashboard 提供实时画面、动作流、console 与会话创建；WebSocket stream 支持画面和用户输入。嵌入自己的产品仍需会话路由、鉴权、终止/超时与浏览器隔离，不能直接把本地 dashboard 当成现成多租户服务。

用户自己操作的 app iframe 与 Agent 控制的浏览器 session 不会自动成为同一实例。可以把 Agent stream 独立显示为“查看自动试用”，或明确设计用户/Agent 的接管模式。不能把一个普通预览 iframe 宣称为 Agent 正在操作的同一浏览器。

实现这些不强制把 Fragments 的 AI SDK 换成 Pi；但其原有单次 streamObject 生成还不够，需要新增工具调用/检查与有次数上限的反馈修复流程。若后续选 Pi，Stagehand extension 是另一条直接注册工具的路线。

[agent-browser 固定 README：dashboard 与 streaming](https://github.com/vercel-labs/agent-browser/blob/44583ac8385d814ab98cbf40feec97620376b50e/README.md#observability-dashboard)。上述能力核实于仓库 main；实际集成必须固定包含所需特性的 release 或 commit，而非假定旧 npm 版本都具备。

## 两个值得直接参考的集成

**Gemini CLI browser_agent**：官方已将 chrome-devtools-mcp 随 CLI 打包，提供持久/隔离/连接已有 Chrome 的模式；默认可访问性树操作，可配置视觉模型获得截图分析和坐标点击。浏览器 Agent 默认关闭，需启用。它证明“编程主 Agent + 专用浏览器 Agent”的公开参考确实存在，并不意味着其本地窗口已提供可嵌入我们的云端 Web 产品的完整组件。[官方文档](https://geminicli.com/docs/core/subagents/#browser-agent)

**Stagehand Pi extension**：直接给 Pi 注册 run/snapshot/screenshot，截图是模型可读的 image content；确定性 facade 不额外调用 Stagehand LLM，可避免又套一层决策循环。需要 Node 24/pnpm 11 构建，明确为实验集成。本地 Chrome 可用，Browserbase 并非强制。远程 CDP 的 extension 加载有部署要求，不应假定任意远端地址都无配置可用。[官方 Pi 集成](https://docs.stagehand.dev/v4/integrations/pi)、[浏览器配置](https://docs.stagehand.dev/v4/configuration/browser)

## 验证应该如何面向用户

撤回此前将“每个版本都展示可复查验收证据”作为主要创新的建议；目前没有用户研究支持它。保留内部记录便于诊断，用户主要看到已完成的结果、正在修复的具体问题和必要时的重试/恢复入口。

Agent 能点击并回复“完成”不证明任务成功。视觉模型适合发现遮挡、反馈、布局问题；数据库是否实际保存、刷新是否恢复、金额计算等仍应读实际状态或使用确定性检查。不要把这些检查做成用户必须读懂的测试报告。

第一轮只需比较同一组真实页面任务：新增记录并刷新确认、遇到校验错误后纠正、窄屏完成主操作；记录真实失败、总耗时、模型调用成本以及是否能把失败反馈给修复 Runner。通过这个小实验再定型，不依据 stars 宣称效果更强。

补充依据：[Midscene Playwright 集成](https://midscenejs.com/integrate-with-playwright)、[Midscene Chrome Bridge](https://midscenejs.com/bridge-mode)、[Browser Use Pi API](https://github.com/browser-use/browser-use-pi/blob/fa838f3298673950923bdaf12bd3c1b6279cd119/docs/api.md)、[OpenAI sample README](https://github.com/openai/openai-cua-sample-app/blob/f2a3dc523ae406f9b704f9a420a05402a63b4522/README.md)、[Codex Browser 产品边界](https://learn.chatgpt.com/docs/browser)。
