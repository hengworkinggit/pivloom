> 这是专项调研笔记。部分选型建议基于该子问题独立提出；最终跨项目组合与本次实施范围以[综合决策报告](atoms-product-and-architecture.md)为准。

# 高 star 产品底座补充：bolt.diy 与 Dyad

检索时间：2026-09-21。结论：两者优先作为“成熟产品交互与明确模块”的参考。当前方案既然要 Pi + 云沙箱，不宜同时整体 fork 它们再替换 agent 和运行环境。bolt.diy 最适合借 Web 工作台的信息组织；Dyad 最适合借版本回退、组件点选和项目/聊天分离。以下 star 只是热度快照，未运行产品，也未把热度当稳定性证据。

## 快照与适配性

| 项目 | Star 实时值 | 固定 main | 活跃度证据 | 形态 | 建议 |
|---|---:|---|---|---|---|
| [bolt.diy](https://github.com/stackblitz-labs/bolt.diy) | 19,895 | `2e254ac19a696394030601bc602f54945b12bfc4` | main 最近提交 2026-02-07；latest release v1.0.0 为 2025-05-12 | 浏览器里的 NodeJS app builder，另有 Electron 包装 | 借工作台/预览/文件差异；只在保留 WebContainers 路线时考虑小改完整 fork |
| [Dyad](https://github.com/dyad-sh/dyad) | 21,597 | `2fc642bc84513a87b99361a9b399634fffa3cdb4` | main 最近提交 2026-09-18；stable v1.15.0 为 2026-09-11，beta v1.16.0 为 09-16 | 本地 Electron app builder，主进程执行代码和文件操作 | 借版本/组件定位；不把本地桌面主进程直接搬成多人云后台 |

仓库地址未发生重定向。活跃度数据来自 GitHub repo/commit/release API，最近提交日期不证明项目停更或质量高低。bolt.diy 的 release 与 main 时间差尤其需要在真正选作基座时做启动和 E2E 验证。

研究方法：agent-reach GitHub/gh；读取官方 README、架构文档、许可证、目录。两仓库完整浅克隆均因 github.com:443 连接失败；未能构建完整 codebase graph，所以只做文档级结构与目录存在性核验，不声称已深审函数行为。通用 Jina Reader 超时后用网页读取工具访问官方文档。没有改工作区代码、没有外发题面。

## bolt.diy：产品面最齐，但运行路线必须选定

[官方 README](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/README.md) 明列：多模型聊天、生成和编辑代码、内置终端、页面预览、diff、文件锁、revert、snapshot reload、ZIP 导出、Git、Supabase，以及 Netlify/Vercel/GitHub Pages 部署。它是完整产品壳，不只是 agent SDK。README 同时把 Backend Agent Architecture 放在计划/进行中，不能直接等同于已交付的成熟后端 agent 平台。

按文件树核实的模块入口（路径指向固定 commit；未逐函数审计）：

| 参考功能 | 入口 | 怎么借 |
|---|---|---|
| 聊天旁边的工作台 | [Workbench.client.tsx](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/components/workbench/Workbench.client.tsx) | 借代码/预览切换、活动状态、面板组织，避免非技术用户面对全套 IDE |
| 预览、地址、端口 | [Preview.tsx](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/components/workbench/Preview.tsx)、[previews store](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/stores/previews.ts) | 参考预览状态流；我们数据来源换成 sandbox preview URL |
| 文件改动说明 | [DiffView.tsx](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/components/workbench/DiffView.tsx)、[FileTree.tsx](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/components/workbench/FileTree.tsx) | 变更卡默认展示用户能理解的结果，源码 diff 放二级 |
| 产物执行桥 | [action-runner.ts](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/runtime/action-runner.ts)、[message-parser.ts](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/runtime/message-parser.ts) | 借“生成→执行→状态反馈”分层，使用 Pi 时应适配结构化工具事件，不复制两套 parser/agent loop |
| 持久化 | [persistence 目录](https://github.com/stackblitz-labs/bolt.diy/tree/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/persistence) | 核实存在 db/chats/useChatHistory/lockedFiles 等入口；不要未经验证当成服务端跨设备存储 |
| WebContainer 入口 | [webcontainer](https://github.com/stackblitz-labs/bolt.diy/tree/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/webcontainer) | 仅在选择浏览器本地运行时借；若云沙箱为主，别保留并行的第二运行系统 |

许可证是 [MIT](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/LICENSE)，但运行依赖 WebContainers 有独立商业边界：其 [官方 Commercial Usage](https://webcontainers.io/enterprise) 明确商业营利场景的 production 使用需要许可，prototype/POC 不需要商业许可。不能把 MIT fork 理解成未来 SaaS 零运行许可成本。

WebContainers 是浏览器内运行环境，并非通用 Linux 云 VM：

- 需要 SharedArrayBuffer 和 cross-origin isolation，部署必须设置 COOP/COEP。凭证、外部图片和 iframe 集成不能不测试。[官方 headers](https://webcontainers.io/guides/configuring-headers)
- 原生 Node addons 默认不能运行，除非用 JS/Wasm 替代；同时开启许多工程可能撞浏览器内存上限。[官方 troubleshooting](https://webcontainers.io/guides/troubleshooting)
- 浏览器支持文档推荐桌面 Chromium，Safari/Firefox 与移动端存在差异；这份页面标注更新于 2023 年，不能用它断言 2026 某一具体浏览器版本“不支持”，交付前应做目标环境实测。[官方 browser support](https://developer.stackblitz.com/platform/webcontainers/browser-support)
- 推断：关闭用户标签页后还要继续构建/修复、跨设备恢复、统一后端自动验收时，服务器任务与云沙箱模型更直接。浏览器本地执行可降服务器成本，但不会自动带来可靠后台任务能力。

短时整体 fork 的合理条件：原样启动在 30–45 分钟内通过，保留其框架/WebContainers/原有生成流程，只增加一个明确差异点。若同时换 Pi、换云沙箱、换持久化，它就不再是节省时间的 fork，而是三层迁移；此时借局部模式、做自己的小闭环更合理。

## Dyad：更值得借“让用户敢改”的体验

官方 [architecture](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/docs/architecture.md) 确认 Electron：React renderer 负责界面，Node main 负责文件和系统资源，IPC 连接。搬成在线多人服务要替换 IPC、local filesystem、进程管理与本地 token store，并加入云用户/项目隔离，因此不是现成的 Web SaaS starter。

能力参考：

- **项目与聊天分开**：同一个 app 可以有多个 chat，共享代码版本。用户可以换一个干净上下文继续改同一应用。[Chatting](https://www.dyad.sh/docs/guides/chatting)
- **紧邻聊天的真实预览**：可刷新、重启 Node server、改路径、外部窗口打开；系统消息展示 npm 安装等过程。[Previewing](https://www.dyad.sh/docs/guides/previewing)
- **每次编辑自动版本化，恢复也是新增版本**：先浏览旧版本预览，再 restore；Git 是内部实现，用户不必懂 Git。这比“聊天记录能重放”更贴合非技术用户。[Versioning](https://www.dyad.sh/docs/guides/versioning)
- **数据后端按需连接**：对 auth/database/server functions 需求引导接 Supabase，不把静态 mock 当已交付后端。[Supabase](https://www.dyad.sh/docs/integrations/supabase)
- **从本地项目到在线部署**：官方指南是先连接并同步 GitHub，再由 Vercel 导入部署；不能宣传成 Dyad 自带托管云。[Publishing](https://www.dyad.sh/docs/getting-started/publishing-your-app)

需要识别文档新旧：`docs/architecture.md` 仍讲 XML 伪工具与单轮生成为主，而更新的 [agent_architecture.md](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/docs/agent_architecture.md) 明确已转正式 tool calling，agent loop 在 `src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts`，工具定义也在该 Pro 子树。不能仅凭旧文档批评其没有真正 agent，也不能把新的 agent 核心当 Apache 代码复制。

## Dyad 分目录许可与直接可借的小模块

- 仓库 [根 LICENSE](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/LICENSE) 和 README 明确：`src/pro` 之外 Apache-2.0；`src/pro` 内为 [FSL-1.1-ALv2](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/src/pro/LICENSE)。FSL 限制向别人提供同类竞争性商业产品/服务，并对每个版本设两年后转换 Apache-2.0 的未来许可。我们应直接避开复制当前 Pro 核心。
- 最适合直接评估复用的是 [`@dyad-sh/react-vite-component-tagger`](https://github.com/dyad-sh/dyad/tree/2fc642bc84513a87b99361a9b399634fffa3cdb4/packages/%40dyad-sh/react-vite-component-tagger)：独立 [Apache-2.0 LICENSE](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/packages/%40dyad-sh/react-vite-component-tagger/LICENSE)。官方 README 说给组件加 `data-dyad-id`（path:line:column）和 `data-dyad-name`，可用来实现预览点选组件→带定位的修改请求。它不是完整可视化编辑器；仍需 iframe 点击桥、选中状态、请求范围约束、修改后的验证。
- [`nextjs-webpack-component-tagger`](https://github.com/dyad-sh/dyad/tree/2fc642bc84513a87b99361a9b399634fffa3cdb4/packages/%40dyad-sh/nextjs-webpack-component-tagger) 也有独立 Apache-2.0 LICENSE。当前 Demo 若选 Vite，不同时引入 Next 版本。
- 版本模块可按存在性定位到 [`src/ipc/handlers/version_handlers.ts`](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/src/ipc/handlers/version_handlers.ts)，预览到 [`PreviewPanel.tsx`](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/src/components/preview_panel/PreviewPanel.tsx)。借用前检查传递 import 是否进入 Pro；本次没有做完整依赖闭包许可审计。

## 面向当前 Demo 的组合建议

采用一套执行架构，每个参考只负责明确问题：

| 我们的功能 | 参考产品/模块 | 本次实现尺度 |
|---|---|---|
| agent loop / tool events / session | Pi coding-agent SDK | 嵌入、remote Ops，不 fork |
| 聊天＋可交互预览＋变更卡 | bolt.diy 工作台 | 借交互组织；按我们自己的 Run/Version 状态渲染 |
| 安全可理解的回退 | Dyad Versioning | 成功版本关联文件快照；恢复创建新版本 |
| 点哪里改哪里 | Dyad Apache component tagger | 作为一个可演示扩展能力，限定 React/Vite |
| build/test/preview 跨会话执行 | 云沙箱适配层 | 一个模板、一套依赖、一个预览端口 |
| 项目/会话/版本/验收证据 | 我们的产品数据库 | 少量实体，不先做通用 workflow 平台 |

差异化可以是“点选组件、用自然语言改、自动验收、可回退”的短闭环；进阶再做需求卡→验收项→浏览器证据。不要用 6–8 小时同时追齐 Supabase、GitHub、多个部署商、模型市场与多代理大厅。借多个项目的长处，不等于把几个完整产品拼进一个仓库。

Agent Reach 版本检查已完成：v1.5.0 为当前最新，没有升级提醒。
