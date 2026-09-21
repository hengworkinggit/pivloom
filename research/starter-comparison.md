> 这是专项调研笔记。部分选型建议基于该子问题独立提出；最终跨项目组合与本次实施范围以[综合决策报告](atoms-product-and-architecture.md)为准。

# 高 star 应用生成 starter 对比（2026-09-21）

## 明确取舍

**针对这次 6–8 小时 Demo，推荐 e2b-dev/fragments 为主底座，保留它的 AI SDK + E2B 链路，补项目/消息/版本持久化、真实验收和预览恢复。Pi 留到需要通用 read/edit/run/test 循环时再接。** 同一轮既迁移 AI runtime 又重做 UI，会把时间花在基础设施上。这个判断是根据代码结构与范围作出的工程推断，尚未完成本机运行/云端部署验证，不能承诺现仓开箱必然可运行。

如果核心创新是“给一个 URL 重建该网站”，Open Lovable 的 Firecrawl→生成→Vite 预览更对题；如果核心是持续编辑一个小应用，Fragments 的范围更小、理解和修改成本更低。Star 表示关注度，不代表质量、活跃度或多租户生产就绪。

## 仓库事实

| 项目 | GitHub API star（取数当时） | 许可证 | 固定 commit | 最近 push |
|---|---:|---|---|---|
| [e2b-dev/fragments](https://github.com/e2b-dev/fragments) | 6,378 | Apache-2.0 | `cc07f43736855f42191de7ac011350cef6752342` | 2026-09-19 |
| [firecrawl/open-lovable](https://github.com/firecrawl/open-lovable) | 28,518 | MIT | `69bd93bae7a9c97ef989eb70aabe6797fb3dac89` | 2025-11-19 |

通过 agent-reach 的 gh 后端读取官方仓库；普通 git clone 网络失败后用 gh API tarball 下载固定 commit。两仓库均先做 codebase-memory 图，再按精确符号 get_code_snippet；无 codegraph 服务，已按 fallback 阅读。Fragments 524 节点，Open Lovable 1,904 节点。未修改工作区。

## Fragments 实际是什么

不是通用 coding agent，而是**模板约束下的结构化代码生成器 + sandbox 运行与预览**：

`Home/useObject → /api/chat/streamObject → fragmentSchema → onFinish → /api/sandbox → E2B host URL → iframe`

| 能力 | 已核实事实 | 对本次意义 |
|---|---|---|
| 生成 | [`POST` 19–71](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/app/api/chat/route.ts#L19) 调 `streamObject({schema, system:toPrompt(template), messages})`，没有 read/edit/test 工具循环 | 固定技术栈、小应用最省时间，复杂任意仓库并不合适 |
| 文件模型 | [`fragmentSchema` 3–53](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/lib/schema.ts#L3) 是一个 `file_path` + `code:string`；多文件 array 只有注释草稿 | 第一版保持单生成入口文件，模板承载其余构建配置；别声称它已支持完整多文件 agent |
| 多轮修改 | [`Home` 25–362](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/app/page.tsx#L25) 累积消息并重新 submit；可选择 Morph 编辑分支 | 用户连续提出修改是真的；无 Morph 时可以重新生成完整单文件 |
| Morph | [`POST` 20–111](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/app/api/morph-chat/route.ts#L20) 先生成编辑指令，再 applyPatch 得到完整新 code，再返回 fragment | 可选优化，有额外服务凭证；Demo 可以先关闭减少依赖 |
| 模板 | [`templates` 10–83](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/lib/templates.ts#L10) 包含 Next.js、Vue、Python interpreter、Streamlit、Gradio | 本次只开放 Next.js，模板预装依赖；减少用户选择和失败分支 |
| 真实执行 | [`sandbox POST` 9–85](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/app/api/sandbox/route.ts#L9) 每轮新建 sandbox、可装依赖、写文件，Web 返回 getHost URL | 已有真实运行底座，无须先写 shell runtime；每轮新建意味着状态/数据不能只留在 sandbox |
| 预览 | [`FragmentWeb` 13–65](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/components/fragment-web.tsx#L13) 真 iframe、刷新、复制 URL | 可直接保留聊天/代码/可交互预览三块体验 |
| 持久化 | Home 的 `messages/result/fragment` 是 React useState；localStorage 是草稿输入和模型偏好 | **刷新后恢复项目并未由这些现有状态完成，必须补 DB** |
| 登录 | [`useAuth` 27–104](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/lib/auth.ts#L27) 支持 Supabase auth；没有 Supabase 时构造 demo session | auth 的存在不等于项目数据持久化/服务端鉴权；API 内 body 的 userID 也不能当认证证据 |
| 分享 | [`publish` 10–52](https://github.com/e2b-dev/fragments/blob/cc07f43736855f42191de7ac011350cef6752342/app/actions/publish.ts#L10) 延长 sandbox timeout，最多24h；可选 KV 短链 | **不是永久部署**。普通 sandbox 默认10分钟，必须处理过期重建与稳定项目链接 |

**重要范围结论**：数据库补齐项目/消息/版本可以让“编辑器项目”持久；若生成的应用本身要持久存业务数据，还要提供受控数据 API 或模板数据库能力，这是第二层持久化，不能混为一谈。

## 6–8 小时如何用 Fragments

1. 保留 AI SDK、代码预览、E2B；固定 Next.js 模板、一个模型配置，禁用无关技术栈与高级设置。不在本次升级框架大版本，不同时迁移 Pi。
2. 增加最小 `projects`、`messages`、`versions`、`runs`，version 保存 schema/code/template/依赖/父版本/验收结果，project 保存当前版本。Supabase Auth 已有接口可接，但服务端仍要验证用户身份、项目所有权与行权限。
3. 生成完成后先落库版本，再启动/更新 sandbox，再记录 preview 状态。浏览器拿 `/projects/:id` 的稳定 URL；sandbox 过期后依据版本重建。不只保存 sandbox URL。
4. 验收限制为一条关键任务：页面可加载、console无严重错误、一个核心控件完成真实状态变化；失败把结构化错误交回同一生成器最多修复一次。Playwright 是自建验收步骤，starter 没有现成完整闭环。
5. 有可用 Playwright 运行环境时加浏览器验收；如果部署环境装浏览器需要大量排障，先保证固定模板构建/运行检查与手动实际点击，不能以假状态冒充测试通过。
6. 稳定公开的是 builder 应用及其项目页；如果题目要求生成站点本身永久可用，就加真正部署/静态发布通道，不能把24h sandbox链接称“已部署”。可先交付固定样例的永久发布，再明确其余为可恢复预览。

**创新放在可靠性与可理解性**：用户能看到“你要的行为→生成了哪些版本→实际点击是否成功→随时恢复上一版”，比单纯多一个聊天窗口更有辨识度。可以借鉴 Codex 的 Thread/Turn/Item，把当前阶段、文件、验证证据映射为产品事件，但不要假称执行了不存在的 agent tools。

## Open Lovable 值得借什么、为什么不优先整仓使用

[官方 README](https://github.com/firecrawl/open-lovable/blob/69bd93bae7a9c97ef989eb70aabe6797fb3dac89/README.md) 定位为 Firecrawl 团队的示例应用，不是 Lovable 官方开源版。README 提供 Firecrawl、多个 LLM、可选 Morph、Vercel/E2B 两种 sandbox；这些依赖会增加第一次配置成本。

图中已定位 generate-ai-code-stream、apply-ai-code-stream、analyze-edit-intent、scrape-url-enhanced、extract-brand-styles、check-vite-errors、create-zip、sandbox lifecycle 等端点。可以借鉴：URL/品牌信息导入、分步骤生成进度、多文件响应解析、Vite错误反馈、ZIP导出、sandbox provider适配器。

但其状态边界不适合直接搬成公开多用户系统：

- [`conversation-state GET` 9–30](https://github.com/firecrawl/open-lovable/blob/69bd93bae7a9c97ef989eb70aabe6797fb3dac89/app/api/conversation-state/route.ts#L9) 直接返回 `global.conversationState`；[`POST` 33–140](https://github.com/firecrawl/open-lovable/blob/69bd93bae7a9c97ef989eb70aabe6797fb3dac89/app/api/conversation-state/route.ts#L33) 直接 reset/update 同一个全局对象，没有按用户/项目分键。
- [`SandboxManager` 11–161](https://github.com/firecrawl/open-lovable/blob/69bd93bae7a9c97ef989eb70aabe6797fb3dac89/lib/sandbox/sandbox-manager.ts#L11) 保存进程内 Map 和一个 `activeSandboxId`；重启丢状态、共享进程并发需要重设计归属与权限。
- 图定位生成 route 单函数到 1,896 行，generation 页面到3,950行，理解改动面明显大于 Fragments；最近 push 也更久。这些是选择 Demo 底座的成本信号，不是完整安全审计结论。
- ZIP下载只是源码导出，不等于托管部署；Vite preview不是永久发布；没有证据应宣称已带完善项目数据库、租户隔离或部署平台。

建议按功能借鉴，不把其单进程全局状态一起搬走。

## 与 Pi/Codex 的选择规则

| 当前目标 | 选择 |
|---|---|
| 6–8小时展示需求→单页代码→真实预览→二改→刷新恢复 | Fragments + 既有 AI SDK + 数据持久化；主推荐 |
| 核心卖点为参考 URL/品牌重建 | 看 Open Lovable 的抓取/样式/生成UI模块，状态层自己写 |
| 任意项目、多文件、安装依赖、反复运行测试、长期维护 | 再引入 Pi 或 Codex harness；其工作空间/runtime模型更合适 |
| 已有可靠 Codex worker/credentials，主要追求现成 coding loop | Codex SDK 后端可优先；但UI、存储、预览仍自己补 |

这不是“Fragments永远优于Pi”，而是先交付产品闭环，再在证据表明需要通用工具循环时替换 runtime。建议抽象自己的 `GenerationBackend`（request/events/artifact），第一版实现 AI SDK，后续实现 Pi 或 Codex，避免同时运行两层 agent loop。

补充：Agent Reach check-update 已执行，当前 v1.5.0 为最新。
