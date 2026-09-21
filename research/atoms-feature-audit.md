# Atoms 产品功能事实核验与完整对齐范围

> 范围已变更：本文保留完整产品功能事实。下文 M0–M4 和“最终范围”属于原长期规划，不是当前笔试承诺。原题与本次覆盖边界见[最新复核](brief-requirements-recheck.md)，实施以[限时方案 v2](delivery-48h.md)为准。

核验日期：2026-09-21。对象是 **atoms.dev**，用户所说的 Atmos 按上下文指 Atoms。下文阶段是原长期方案的依赖，不是实测工期。

本次使用 agent-reach 的 Exa 发现资料，并逐项打开 Atoms 官网和当前英文帮助中心。未登录 Atoms、未连接私人账户、未进行生成/支付/广告等产品操作。因此，下面“已说明”指官方操作文档存在可执行流程，**不等于我们亲测成功**；官网的产出质量、可靠性和增长效果仍属于营销主张。帮助中心也有新旧文章冲突，列于文末。

## 产品结论

Atoms 的主要产品不是一个网站生成对话框，而是围绕项目持续运作的工作台：需求输入与澄清 → 规划与分工 → 多文件开发 → 可运行预览与修改 → 后端资源 → 版本与发布 → 协作和源码交付 → SEO、分析、广告。官网呈现 AI 团队定位；帮助文档进一步证明其中多个角色已有专门的审批卡、交接和结果状态。角色名称及头像不能用来推断其底层确有八个独立进程、八套模型或某种特定编排框架。[官网](https://atoms.dev/)、[项目聊天](https://help.atoms.dev/en/articles/12129550-project-chat)

下面 20 项均进入最终对齐清单。首期不同时实现所有高级变体；每个阶段必须交付一个用户可以独立完成的流程。建议阶段（M0–M4 均在最终范围内）：

- **M0 产品与平台基础**：定义项目/运行/版本/部署/资源/权限边界，建立租户隔离、持久化、事件契约、凭据管理及成本计量基础；先完成最小可运行纵切，不以研究报告作为用户交付。

- **M1 可持续构建闭环**：项目/任务/源码持久化，澄清与计划，真实工具执行，多文件应用，预览、修错、版本、基本发布，以及可用的数据库/认证/对象存储。
- **M2 完整工作台与交付控制**：深度可视化编辑、代码编辑、主题与资产、完整 Cloud 管理、生产环境、域名、成员权限、导出和 GitHub。
- **M3 专业团队与生态**：研究/数据等专职工作流、依赖交接与并行、Race、连接器扩展、应用内 AI 服务和计量。
- **M4 上线后增长闭环**：GA4/GSC、SEO 内容到代码交付、推广资产、Google Ads。依赖可靠的发布、OAuth、外部动作审批和用量体系。

M0–M4 是建议实施顺序，不表示必须全部串行，也不替代工程拆分估算。我们自己的主创新应落在“用户能持续完成什么”及交互体验上；运行记录是系统能力和调试依据，不把“证据卡报告”作为主产品。

## 核心功能矩阵

| # | 核心功能与用户行为 | 官方已说明的内容与依据 | 付费 / 可用性 / 未证实边界 | 我们的最终对齐范围与分期 |
|---|---|---|---|---|
| 1 | **项目与工作区**：进入工作区、创建/找回项目，从模板或已有项目开始 | Home 输入启动项目；My Projects、工作区切换、Discover、Templates 是工作台入口。项目属于工作区。[Dashboard](https://help.atoms.dev/en/articles/12129546-dashboard-overview) | 模板入口存在，不代表所有模板均适配所有后端或代理。未验证跨工作区迁移、文件夹层级和项目数量上限。 | **M1**：账号、工作区、项目列表、项目详情和续做；模板先选稳定 Web 栈。**M2**：模板管理和 Remix。 |
| 2 | **需求与设计输入**：输入自然语言、图片、文档、文件夹或语音，引用指定素材 | 输入支持附件及 `#` 文件引用；可选 Web/App、Build/Goal、Theme；Goal 的文案是由 Mike 规划并分派。[Input Chat](https://help.atoms.dev/en/articles/12129552-input-chat) | 页面描述可见入口，不保证任意格式都完整解析。没有据此证实 Figma 双向同步、设计稿像素级还原或原生移动发布。 | **M1**：文本、截图、文档和素材库，保存原始输入与引用。**M2/M3**：语音、更多文档解析、主题输入。设计输入必须影响生成内容；**M3** 纳入移动项目、Expo Go 预览与 Android 构建，详见补验。 |
| 3 | **澄清与规划**：回答关键问题、批准或修改计划，再开始较大改动 | Question 卡可以逐页作答并提交；Plan 卡可以批准或拒绝；计划本身不表示已经执行。[Working with Agents](https://help.atoms.dev/en/articles/12129548-working-with-agents) | 没有证实所有请求都强制先问问题、每次修改都需人工批准，或计划完全不耗费积分。 | **M1**：按任务不确定性触发短澄清；可编辑目标、页面/实体/约束和实施计划。批准后创建有状态任务，计划变更可追踪。 |
| 4 | **AI 团队与角色协作**：简单任务用工程师，复杂任务让负责人分工，也可 @ 专家 | Team Mode 关闭通常由 Alex 执行；打开后由 Mike 协调，可 @ 多角色。官方列有 PM、架构、工程、分析、研究、SEO、广告等角色。[Working with Agents](https://help.atoms.dev/en/articles/12129548-working-with-agents)、[角色说明](https://help.atoms.dev/en/articles/12129552-input-chat) | Sarah/Adrian 只在支持的项目出现；Deep Research、Cloud 等工作流限制切换。独立任务可并行，不意味着所有阶段随意并发。 | **M1**：规划/实现/验证的清楚责任与交接。**M3**：完整角色入口、依赖调度、冲突控制及研究/数据专职流程；UI 角色必须对应真实能力。 |
| 5 | **研究与多模型比较**：研究市场/竞品；同一需求比较多组结果后选择 | Deep Research 由 Iris 执行；Race 将同一请求交给多个模型配置比较，提供 Turbo/Standard/Custom 菜单。[Input Chat](https://help.atoms.dev/en/articles/12129552-input-chat) | Race 在当前套餐文档归入 **Max**；具体模型、配置和可用范围变化。不据此假定自动选优或最低成本。[Plans](https://help.atoms.dev/en/articles/12129587-plans-and-credits) | **M3**：研究输入作为项目需求依据；候选版本并行隔离、比较和选择。先保证单路径稳定，再提供 Race，不把“调用多个模型”本身当创新。 |
| 6 | **执行过程与持续修改**：看进度，追加需求、排队、重排、停止与续做 | 聊天展示实际工具活动和结果版本，包含读写、终端、图片及渲染页检查。消息队列可调整；Stop 作用于当前聊天活动，保留已完成产物和被停止状态。[Project Chat](https://help.atoms.dev/en/articles/12129550-project-chat) | 排队不是任意时刻安全改同一文件。工作中断不保证所有在途操作可恢复；附附件的队列消息存在编辑限制。 | **M1**：事件流、任务状态、取消、队列、失败重试、断线恢复；对同项目写入串行或隔离。**M3**：更复杂并行/依赖调度。 |
| 7 | **真实源码与代码编辑**：查看多文件树、Diff、手动改文件，把文件交给代理继续改 | Editor 可管理项目文件，预览多种格式；编辑会话有 Preview、Submit all、Discard all；支持 Diff 和文件上下文引用。[Code and files](https://help.atoms.dev/en/articles/12129559-code-and-files) | 编辑/下载需合适套餐；代理运行、旧版本、保存中可能只读。文件名搜索不等于全文搜索。 | **M1**：真实多文件仓库、依赖、终端构建与增量修改。**M2**：编辑器、Diff、文件操作、代理与人工编辑互斥。单文件片段只能是早期原型，不能作为最终 Atoms 对齐。 |
| 8 | **运行预览、错误定位与修复**：访问页面、填表、看移动布局/日志，把错误交给 AI | App Viewer 提供真实可交互预览、设备切换、路由选择、新标签页和 Console；Issue Report 的 Resolve 启动修复。[App Viewer](https://help.atoms.dev/en/articles/12129554-app-viewer) | 官方“自动修复”描述不证明所有错误都能修好。预览 UI 和渲染检查不能证明完整的自主浏览器 QA，也不能证明复用了 Codex 私有浏览器。 | **M1**：隔离运行环境、浏览器观察/操作、错误上下文回传、修复迭代和用户接管。验收应覆盖实际用户流程；不仅展示截图或 build 通过。 |
| 9 | **可视化编辑、主题与资产**：点击页面元素调文字/布局，局部自然语言修改，替换素材 | Design 有 Theme、Visual Editor、Library；主题管理支持保存和导入导出；元素选择、样式调整、保存/放弃及图像替换有明确流程。[Design](https://help.atoms.dev/en/articles/12129553-design-and-preview) | 当前 App Viewer 限合适桌面项目状态与 editor 权限。主题只能触及共享样式，固定值不会全部跟随；多选时属性面板不是批量编辑器。 | **M2**：稳定的元素→源码映射、局部 edit patch、主题 tokens、素材替换、保存撤销；选中元素后发自然语言修改可先交付。 |
| 10 | **版本、恢复与 Remix**：查看旧成果，恢复当前项目或复制成新项目 | History 有版本预览、Restore、Remix；恢复可选择同步数据库，复制可选择复制数据/广告配置；后续版本仍保留。[Project History](https://help.atoms.dev/en/articles/12129557-project-history) | 活动任务中、最新版本、广告产生版本等存在恢复限制；带后端的历史预览可能不可用。项目恢复不等于任意生产版本一键回滚。 | **M1**：不可变代码版本、项目/任务/会话持久化、恢复、再编辑。**M2**：分支/Remix 与明确的数据快照策略；代码、应用数据、发布版本分别建模。 |
| 11 | **Cloud 数据库与后端连接**：让 Agent 建数据功能，再在表格里管理内容 | Cloud 有独立 Development/Production 数据库、表/行/Schema、CSV 导入导出；Schema 修改通过 Agent 应用。[Database](https://help.atoms.dev/en/articles/12129562-database)；Supabase 是替代连接方案。[Supabase](https://help.atoms.dev/en/articles/12129570-connect-supabase) | Owner 管 Schema/CSV，Editor 可改可写表行；Cloud 与 Supabase 不能同项目并用。Cloud 管理是桌面功能、存在余额和资源限制。[Cloud](https://help.atoms.dev/en/articles/12129561-atoms-cloud) | **M1**：应用真实持久化、租户隔离、迁移和访问控制；优先复用托管数据库。**M2**：数据浏览器、导入导出、开发生产环境、资源管理；不只存聊天历史。 |
| 12 | **生成应用的账户与权限**：要求登录/注册、不同角色，管理应用用户可见范围 | Agent 生成认证 UI 和规则，Cloud 管理账户/会话；支持邮箱密码，Google 登录需明确要求并测试；Users 能查看/搜索注册者。[Authentication](https://help.atoms.dev/en/articles/12129563-authentication) | Users 面板不是完整 IAM 后台：不能在那里邀请/禁用/删除/改角色/重置密码；开发与生产用户分开，面板不能自由切换。 | **M1**：至少一条可靠认证路径、后端授权和角色规则。**M2**：应用用户查询管理及多环境；平台工作区成员、生成应用用户必须分开。 |
| 13 | **应用文件与密钥**：持久保存用户上传，添加秘密凭据并按名字让 Agent 使用 | App Storage 有 bucket、文件夹、上传/预览/管理和 Public/Private；不同于聊天附件和源码。[Storage](https://help.atoms.dev/en/articles/12129565-app-storage)。Keys 有 Test/Production 和可复用 Library，Chat 只引用名字。[Keys](https://help.atoms.dev/en/articles/12129564-keys-and-secrets) | 存储权限与应用文件访问是两层；资源有限额。只有 Owner 新增 Key；未配置 Production 值时官方说明可能沿用 Test 值，不可假设自动安全隔离。 | **M1**：私有对象存储、下载鉴权、secret vault、运行时注入。**M2**：文件管理 UI、环境覆盖、key library 和轮换；不让凭据落入模型上下文或客户端代码。 |
| 14 | **应用内 AI 能力与运行计量**：给最终用户的应用加入 AI 功能，并查用量 | Cloud AI Library 可浏览/选模型，以 `#` 模型标签请求生成 AI 功能；AI Usage 展示项目积分消耗和模型。[Use AI in your app](https://help.atoms.dev/en/articles/12129566-use-ai-in-your-app) | 这是生成应用运行时能力，和“帮你写代码的模型”不同；模型库会变。Cloud/AI 运行钱包与构建积分分账。[Plans](https://help.atoms.dev/en/articles/12129587-plans-and-credits) | **M1** 预留服务网关/计量结构；**M3**：可控模型目录、服务器代理调用、项目额度、限流及最终用户错误状态；避免把平台 LLM key 发给生成应用前端。 |
| 15 | **发布、生产环境和域名**：先预览，主动上线，更新已发布版本，暂停或下线 | Publish 生成公共站点 URL；后续修改需 Update；Cloud 有数据迁移、安全检查、生产资源及暂停/下线流程。[Publish](https://help.atoms.dev/en/articles/12129577-publish-your-project)；Overview 管线上状态、版本、域名、生产资源。[Overview](https://help.atoms.dev/en/articles/12129555-overview) | 当前发布最新可用版本，Live App Version 是展示而非选择器。余额、存储、状态与权限可阻塞。Cloud 暂停不代表停止计费。 | **M1**：稳定公开链接、构建产物与项目解耦、发布状态和基础健康验证。**M2**：自定义域名/TLS、明确开发/生产环境、数据迁移、暂停/撤回、发布保护与我们自己的回滚能力。 |
| 16 | **分享、发现与源码导出**：分享项目供别人查看/Remix，分享成品给访客，交付源码 | Share 有 Public/Private、Discover、App Card；Export 输出 ZIP；Share 的项目链接与 Publish 的成品 URL 不同。[Share](https://help.atoms.dev/en/articles/12129574-share-a-project) | Private、关闭 Discover 和导出需要 **Pro**；Owner 控制可见性。收到链接不会自动成为 Editor，代码 ZIP 也不等于导出托管数据库和第三方账户。 | **M1**：公共预览/成品链接、源码可交付。**M2**：权限化项目分享、Discover/Remix、元信息、导出附部署说明与依赖；应用数据独立导出。 |
| 17 | **GitHub 交付与回流**：连接账户创建库、发送代码、把外部修改带回 | 当前仅在个人账号创建**新私有仓库**；手动 Push Changes / Pull Updates，能选择已连接分支；不会自动同步。[GitHub](https://help.atoms.dev/en/articles/12129569-connect-github) | 需合适付费计划且 Owner 连接；不支持连接已有仓库、组织建库或在连接器中改公开。冲突情况下 push/pull 各自源端覆盖，不是智能合并保证。 | **M2**：先新库导出、手动受控同步与冲突提示。**M3**：已有仓库导入、组织库、PR 交付属于我们可以增强的范围，明确不是 Atoms 已核实能力。 |
| 18 | **团队协作与外部连接器**：邀请同事编辑项目，授权外部工具供 Agent 或应用使用 | 工作区 Owner/Editor、邀请与共享积分有明确规则。[Permissions](https://help.atoms.dev/en/articles/12129576-access-and-permissions)。连接器覆盖开发、文件、工作管理、后端、支付和营销；具体读写取决于连接器。[Integrations](https://help.atoms.dev/en/articles/12129568-integrations) | 邀请有计划/席位限制；文档未证明多人同文件实时 CRDT 编辑。连接账户、启用工具、执行写操作是不同阶段；也未证明所有连接器写操作都强制确认。 | **M2**：成员与角色、项目访问、写入锁/冲突处理、GitHub/Supabase/支付首批连接。**M3**：通用 OAuth/connector registry、授权范围、外部动作审计和更多服务。 |
| 19 | **站点分析与 SEO 运营**：看访问效果，审批内容计划，生成页面、集成发布、查搜索表现 | Analytics 读取 GA4；站点报告需 **Pro+**。[Analytics](https://help.atoms.dev/en/articles/12129580-analytics-overview)。Sarah 提方案→用户选页批准→生成→Alex 集成→用户发布；GSC 看表现、页面/抓取等。[SEO Agent](https://help.atoms.dev/en/articles/12129581-seo-agent) | 连接 GA4 与显示报告的权限不同；数据有延迟。Sarah 不替用户发布、不保证排名。当前 SEO 文档说 Atoms **展示 sitemap 但不代提交**；不是一键“流量增长保证”。 | **M4**：先真实指标与可解释行动；SEO 以选页/内容/链接/素材/代码交接形成闭环，发布后跟踪。GA4 与 GSC 各自建 connector，指标和任务状态分开。 |
| 20 | **广告、转化与推广资产**：准备广告，审预算/关键词/文案，创建暂停广告，主动启用后分析优化 | Adrian 支持 Google Search campaigns：成本说明和计划两次审核后创建，**新 campaign 默认 paused**；有性能、建议、暂停/启用、转化跟踪工作流。[Ads Agent](https://help.atoms.dev/en/articles/12129582-ads-agent)。Overview 含商业视频/海报等资产入口。[Overview](https://help.atoms.dev/en/articles/12129555-overview) | 需支持的已发布 Web 项目、Team Mode、Owner 接通/审批和有权限的 Google Ads 账户；广告费与 Atoms 积分分开。未亲测资产质量、广告效果；仅支持所核实 Google Search 流程，不能扩写为全渠道自动投放。 | **M4**：素材→计划→批准→创建暂停广告→显式启用→数据分析/优化；外部账单和预算控制单独建模。先交付内容和只读分析，再逐步接真实外部写操作。 |

## 不应抹平的状态与领域边界

这些是根据已核实产品流程推导的我们自己的设计要求，不是在声称 Atoms 内部就使用相同数据模型。

1. **Project / Run / Version / Deployment 分开。** 同一项目能多次运行、产生多个版本，其中一个或某个发布产物在线。生成完成、构建完成、已验证、已发布是不同状态。
2. **平台持久化与生成应用持久化分开。** 前者保存项目/任务/消息/源码快照，后者保存最终用户、表数据和上传。仅 Supabase 保存聊天与代码不等于已对齐 Cloud。
3. **代码版本与数据变化分开。** 恢复代码需要显式说明数据库处理策略；不应把数据库整体回退绑定到普通 Undo。生产流量、密钥、数据和部署状态不能随意随代码拷贝。
4. **工作区成员与应用用户分开。** Editor 能改项目不意味着是生成应用管理员；Share 链接、团队邀请、公开成品访问分别授权。
5. **连接器与生成应用集成分开。** Agent 读取文档、Agent 向外部系统写数据、生成应用在运行时调用支付/邮件等服务，是不同权限和凭据生命周期。
6. **Agent 构建成本、应用运行成本、外部费用分开。** 广告预算、第三方服务账单与平台 LLM token 消耗不能在一个不透明“积分”里混为一谈。
7. **多角色是有状态的交接。** Sarah 已完成内容不等于 Alex 已集成，更不等于线上已更新；广告计划通过不等于广告已经启用。对应可见状态应比头像数量更重要。

## 帮助文档冲突与证据等级

- **发布旧版本**：搜索能发现旧文档中的 Always Latest / Specify Version 字样，但当前 [Overview](https://help.atoms.dev/en/articles/12129555-overview) 明确 Live App Version 不是选择器，当前更新发布最新版本。可确定项目历史可恢复；不能据此承诺当前线上一键任选历史版本。我们的产品可以增强，但需标成自建。
- **Visual Editor 适用性**：[Design](https://help.atoms.dev/en/articles/12129553-design-and-preview) 有概括性“任何项目”措辞，[App Viewer](https://help.atoms.dev/en/articles/12129554-app-viewer) 则限定桌面合适项目状态与 editor access。采用后者更明确的条件，不写无条件所有项目可用。
- **SEO 自动提交**：旧 [Marketing Module Guide](https://help.atoms.dev/en/articles/14057591-marketing-module-guide) 泛称自动提交 Google Search Console；当前 [SEO Agent](https://help.atoms.dev/en/articles/12129581-seo-agent) 明确 sitemap 不代提交。当前详页优先，避免“生成即被索引”说法。
- **Ads 入口是否直接启动**：[连接指南](https://help.atoms.dev/en/articles/12129573-connect-google-ads) 与 [Ads 专页](https://help.atoms.dev/en/articles/12129582-ads-agent) 对不同 Create Ads 入口有概括差别。专页区分“打开 workspace”与“发送创建任务”；不要在我们的 UI 把连接账户、启动研究、创建 campaign 和启用花费混成一次点击。
- **质量与自主性**：官网“完整团队、生产就绪、增长/收入”等是定位与效果宣称。本核验确认相应 UI 流程和服务类别存在，没有亲测成功率、速度、输出代码质量、持续运行可靠性，也没有证实底层框架。

## 完整对齐仍需产品侧补验的边界

这些保留在最终对齐计划的待验证清单，不应悄悄删掉或凭菜单猜实现：

- **Web / App**：补验已确认移动项目生成、Expo Go 预览与官方 Android build/package 宣称；这些纳入 **M3** 的最终对齐范围。iOS 构建/商店发布、设备权限与推送仍需补验，不能根据 Android 构建推断。详见下方补验。
- **视频与更多输出**：补验已找到 Video 创建、预览、剪辑和本地导出官方流程，纳入 **M3** 创作输出与 **M4** 推广资产；账户具体额度、分辨率、时长和商业推广视频的完整模板/脚本流程仍未完整核验。独立 Video 项目不等于 Web 项目的 Assets 面板。
- **实时共同编辑**：确认工作区多人协作和权限，不等于确认 Google Docs 式多人同时编辑。同文件协作语义需另行验证，首版可可靠串行。
- **支付集成深度**：官方列 Stripe 连接器，未凭此推出覆盖订阅、退款、税费、Webhook、对账的全部后台。我们对齐时按实际业务流程逐项实现与验证。
- **浏览器自动验证深度**：确认交互预览、错误报告和渲染页检查；未确认 Atoms 存在与 Codex 私有浏览器等同的观察/控制/接管产品。我们可独立做更完整的真实用户旅程验证，不需要把未经证实能力当对齐基线。

## 可供主方案直接采用的取舍

接受更长周期之后，应把**真实多文件工程、长期项目状态、工具循环、隔离运行、浏览器验证、数据与发布控制**纳入主底座，而不是继续以单文件结构化生成为最终架构。可以复用 starter 的界面与模板，但底层不能靠不断覆盖一个组件来承载上表。

功能对齐的完成定义应是每一条用户旅程可用，并能从断点继续、对失败给出可行动结果；不是菜单上放满 Atoms 的同名入口。分期可以晚做 Race、全连接器目录、SEO/Ads，但最终范围保留；上线前应有对应模块验收，不能用“后续接 API 即可”当实现完成。

本轮仅研究与规划，没有授权创建广告、启用 campaign、修改外部账户或产生广告支出；方案中的审批设计不是当前操作许可。

本笔记提供产品事实与功能依赖，不重新指定 Pi/Codex/OpenCode 等 runtime；底层选型应由这些需求约束，并与主报告的源码核验结果一致。


## 有界补验：移动 App、Video 与 Figma（2026-09-21）

补验修正前文的“入口已见、流程待定”：**移动生成/预览/Android 构建与 Video 生成/剪辑/导出已有官方流程证据**。仍未登录或实际生成。以下仅说明产品事实边界，不推导未公开的实现代码。

### 移动 App：确认到 Expo Go 预览与 Android 构建，不延伸成全部商店交付

- 当前 [Output types](https://help.atoms.dev/en/articles/12129547-output-types) 将 App 作为独立于 Web 的输出，要求创建前选择，已有 Web/App 项目不能靠换模型或 Mode 转换；App 暂不支持 Deep Research。
- 当前导航指向的 [Changelog](https://help.atoms.dev/en/articles/12129614-changelog) 在 **2026-05-06** 说明：移动项目生成、预览链接/二维码、Android build 的触发与状态，以及构建包准备完成后获取。这已经超出“响应式网页模拟手机”。
- 公开的 [App preview desktop](https://atoms.dev/app-preview/desktop) 明确要求用手机继续到 **Expo Go**。因此“采用 Expo Go 的移动预览入口”有直接官方页面证据；具体 React Native 项目模板、EAS 服务用法或版本号仍未核验。
- 尚未在本次官方源范围找到 iOS IPA、TestFlight、App Store/Google Play 一键提交、签名证书管理、Android 包究竟 APK 还是 AAB 的明确当前流程。不能因未找到而断言没有，也不能把 Android build package 自动写成双商店上线。
- 搜索仍返回旧 [Project Scope & Capabilities](https://help.atoms.dev/en/articles/12129503-project-scope-capabilities) 的“不直接生成原生二进制”及旧 Build & Export“不支持 APK”等内容。它们与当前 Changelog 有冲突；**采用当前导航文章和明确日期的新功能说明，不继续沿用仅 Web/PWA 的旧结论**。旧 Build & Export 打开失败，亦不适合做当前能力唯一依据。

**对我们范围的含义（建议，不是 Atoms 事实）**：M3 最终对齐包含独立 mobile project type、移动模板、二维码/设备预览、Android 构建 job/状态/产物。可选 Expo 实现路线需要单独工程评估。iOS 和商店提交流程保留为待确认扩展，不把一个 iframe 改成窄屏当移动 App 完成。

### Video / Seedance：已经有生成与编辑流程；推广素材是另一条入口

[Output types](https://help.atoms.dev/en/articles/12129547-output-types) 给出完整路径：Home 的 `+ → Video`，附参考文件，描述主体/动作/风格/镜头，使用 Smart 或界面当前的比例、分辨率、时长，发送后播放审阅，再下载/分享。Video 会关闭 Race、Deep Research、Cloud 和 Theme；套餐、时长、模型等随账号及当前控件变化。因此不能把 Video 当作现有 Web Agent 的一个同义模式。

当前 [Changelog](https://help.atoms.dev/en/articles/12129614-changelog) 的 **2026-05-28** 进一步说明生成、预览和编辑流程，包含缩放、选片段、分割和本地导出。由此可确认存在视频编辑能力；未证实完整专业剪辑台的轨道、字幕、关键帧、批量渲染等全部功能。

[Seedance 模型页](https://atoms.dev/models/seedance-2-0) 声明可以在 Atoms 工作流中使用 Seedance 2.0。其他搜索命中的 `/models/seedance-2.0` 营销页在本次打开时返回 404；部分语言页面的清晰度和时长表述也不同。因此主方案只承诺“provider 能力+实时可用配置驱动”，不采用旧页的 4K、固定时长、固定参考数或免费额度作为 Atoms 当前合同。

商业推广视频与独立 Video 项目应分开：Web 项目的 [Overview](https://help.atoms.dev/en/articles/12129555-overview) 确认 Commercial Promo Video / Ad Poster 等入口；[Files and media](https://help.atoms.dev/en/articles/12129558-files-and-media) 说明 Owner 可在已有版本后管理图/视频/音频/音乐，并在支持时引用、下载、重命名。该 Assets 面板明确不适用于 mobile/video project types。**已确认入口与资产生命周期，未确认从落地页自动提取→脚本审批→镜头制作→配音字幕→成片的完整专属产品流程**。

**对我们范围的含义（建议）**：M3 提供异步生成 job、参考素材、参数、预览/下载及基本剪辑；M4 加 Web 产品上下文驱动的推广素材。后者脚本/分镜审批可成为我们明确设计的能力，不能写成 Atoms 已亲测工作流。媒体生成任务应有独立状态、存储与计量，复用项目空间而不是强塞进源码版本。

### Figma：可上传 FIG，不等于 Figma 解析或设计转代码

- [File types and limits](https://help.atoms.dev/en/articles/12129597-file-types-and-limits) 把 FIG 与 PSD、AI、Sketch 列为“可上传但无内置预览”。该页明确把上传、预览、AI 处理分开；不能从接受文件推断读取 frame、组件、constraints、tokens 的能力。
- 官网 [Atoms vs Anima](https://atoms.dev/comparison/atoms-vs-anima) 比较页把 Figma integration 写为非核心功能，FAQ 明确表示 Atoms 不转换 Figma 文件。这是官方产品营销自述，强于“搜索没找到”；但不是所有账号/连接器最新状态的现场测试。
- 在本次官方帮助中心 Input Chat、Design、Files and media、File types、Integrations、当前 Changelog 与官网比较页面中，未找到专门的 Figma OAuth/MCP/link/node 导入、双向同步或 Figma-to-code 操作指南。`Figma` 在当前 Changelog 中没有匹配。搜索 `site:help.atoms.dev Figma`、`site:atoms.dev Figma import/integration` 也未得到该流程。

**对我们范围的含义（建议）**：M1/M2 保留截图和导出素材参考。Figma link/frame/设计 token 结构化导入若做，应归为我们 M3 的可选增强，不能假称是“对齐 Atoms 的已确认缺口”；用户没有特别要求时，不为一比一菜单而引入 Figma 权限链路。

### 检索覆盖和仍未验证项

补验仅使用 atoms.dev 和 help.atoms.dev 官方公开材料：Exa 三组检索（mobile/Expo/native/store；Video/Seedance/promo；Figma import），官方域名 Web 搜索，并打开当前导航 Output types、Changelog、Files and media、File types、Overview、Input Chat、Design、模型页、移动预览页和 Anima 对比页。额外检索 iOS build、TestFlight、Android build、Commercial Promo Video、Figma import/integration。无私人账号访问、无作品生成、无付款或外部账户操作。

官方公开材料未覆盖的套餐权益、实际包格式、商店交付、完整视频剪辑能力等记录为**未核实**，而非“没有”。后续若要进一步确认，应由有授权测试账号的产品走查或官方支持答复解决，不能继续用营销文案补足。
