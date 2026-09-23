# Pivloom · 派织

Pivloom 是一个可在线使用的 AI Web 应用构建工作台。用户描述需求，三个固定角色依次规划、编写代码、操作浏览器检查；通过检查的版本成为项目当前版本。工作台保存对话、源码和检查结果，支持在同一项目继续修改。

**[在线体验](https://pivloom-69-5-7-187.sslip.io/)** · **[已发布的示例应用](https://3c866a6a-26e9-4af4-89d4-d84127b7d430.app-69-5-7-187.sslip.io/)** · **[产品与技术文档](docs/README.md)**

## 能做什么

- **生成与迭代**：用自然语言创建 React/TypeScript 应用；后续需求基于当前已验收版本继续修改。
- **可见的协作过程**：Coordinator 定义目标和可观察行为，Builder 写入多文件源码，Reviewer 在真实浏览器中检查候选应用；失败时最多执行两轮修复。
- **版本与恢复**：服务端保存项目、消息、源码快照、运行事件和检查结果。旧成功版本不会被失败候选覆盖；临时预览到期后可从保存的源码重建。
- **可选永久发布**：用户主动点击“永久发布”，才把当前已验收版本的静态产物部署到独立 HTTPS 地址。未发布项目不会自动获得永久链接；发布地址不依赖预览沙箱存活。
- **自带模型配置**：用户在设置页填写 Provider、Base URL、模型和 API Key，完成流式与工具调用测试后使用。密钥按用户隔离并在服务端加密保存。
- **完整工作台**：注册登录、项目列表与真实截图、只读源码、运行事件、停止/重试、六个模板、中英与明暗主题及窄屏布局。

## 体验路径

1. 打开[在线工作台](https://pivloom-69-5-7-187.sslip.io/)，注册或登录；到“模型设置”连接可用的模型服务。
2. 创建项目并描述需求。执行时可查看三个角色的阶段、运行事件以及上一成功版本。
3. 在预览里实际操作生成的应用，查看对应源码；再发送修改需求。
4. 预览到期时使用“重新启动预览”。需要长期分享时，再点击“永久发布”。

[活动报名示例](https://3c866a6a-26e9-4af4-89d4-d84127b7d430.app-69-5-7-187.sslip.io/)可匿名访问，展示表单校验、报名列表、搜索筛选、确认与统计。生成应用自己的业务数据由其代码决定：该示例使用浏览器 localStorage，不提供跨设备云数据库。

## 架构

| 层 | 实现与职责 |
|---|---|
| 工作台 | Next.js 16、React 19、TypeScript、Tailwind；项目、对话、预览、源码和模型设置 |
| API 与执行器 | 常驻 Fastify 服务；HTTP/SSE、身份校验、固定角色交接、运行状态、版本提交和发布 |
| Agent | Pi SDK；角色会话与工具权限由服务端约束，只有 Builder 能修改生成源码 |
| 隔离运行 | OpenSandbox + Docker/gVisor；安装依赖、构建、运行生成应用及浏览器检查均在沙箱内 |
| 持久化 | 自托管 Supabase Auth、PostgreSQL 和私有 Storage；项目与运行状态在数据库，源码及检查工件在对象存储 |
| 公开入口 | Caddy；工作台、版本独立预览域名、按项目划分的可选静态发布域名 |

生成应用默认只有短期预览。预览恢复重新创建沙箱并从保存的源码构建，不调用模型；正式发布复制与当前已验收版本匹配的静态构建产物，访问发布域名时不启动沙箱或模型。每个版本的预览使用独立 origin；浏览器 localStorage 不会自动跨版本或跨发布域名迁移。

当前是单实例部署，生成任务全局串行。生成应用的通用后端、独立数据库、自定义域名、多人实时协作和支付计费尚未实现。[产品范围](docs/PRD.md)与[技术设计](docs/TRD.md)说明了取舍。

## 本地开发

需要 Node.js 24+、npm，以及按[基础设施说明](docs/infrastructure-setup.md)准备的 Supabase 与 OpenSandbox。复制 [API 示例配置](apps/api/.env.example)和 [Web 示例配置](apps/web/.env.example)到各自的本地环境文件，填入本地基础设施地址与管理凭据；用户模型密钥在页面配置，不写入 Web 环境文件。

~~~bash
npm ci
npm run build:contracts
npm run dev:api
# 在另一个终端
npm run dev
~~~

工作台默认位于 <http://localhost:45231/projects>。真实模式连接 API，不会静默降级为假数据；若只需查看早期前端演示，可显式运行 `npm run dev:demo`，其结果不代表真实生成。

## 验证与部署

~~~bash
npm run typecheck
npm run lint
npm test
npm run build
~~~

真实环境另需验证身份隔离、模型调用、沙箱构建、浏览器行为、预览恢复及永久发布。实际执行记录见[主流程验收](docs/test-runs/2026-09-23-finalization.md)、[前端验收](docs/test-runs/2026-09-23-frontend-refresh.md)和[可选发布验收](docs/test-runs/2026-09-23-publication.md)。

前后端同仓、独立构建部署；单实例生产环境使用 systemd 运行 API/Web，并由 Caddy 提供 HTTPS。参见[发布与回滚指南](infra/release/README.md)。生产密钥、测试账号密码和服务器配置不提交到仓库。

## 仓库结构

~~~text
apps/web/           Next.js 工作台
apps/api/           Fastify API、Agent 执行器与沙箱集成
packages/contracts/ 前后端共享的接口与事件 schema
migrations/         PostgreSQL 数据结构及权限
infra/              Supabase、沙箱和生产发布配置
docs/               产品、技术与验收文档
research/           选型研究与历史决策
~~~

第三方组件及 UI 参考见[开源来源](docs/frontend-open-source.md)和[版权说明](docs/third-party-ui-notices.md)。本仓库目前未附独立的软件许可证；公开可读不自动授予再分发许可。
