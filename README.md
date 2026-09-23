# Pivloom · 派织

把想法织成可运行的应用。Pivloom 是基于 Pi SDK 的 AI Web 应用构建工作台，固定角色协作完成规划、编码、浏览器检查和有限修复。

本项目原工作名为 nano-Atoms。真实工作台已接通登录、项目与模型配置、Pi 三角色生成、沙箱构建与浏览器检查、版本迭代、停止/重试和预览恢复。公网入口为 **[Pivloom](https://pivloom-69-5-7-187.sslip.io)**，使用免费 sslip.io 域名及 HTTPS。

[#13](https://github.com/hengworkinggit/pivloom/issues/13) 已关闭；[#14](https://github.com/hengworkinggit/pivloom/issues/14) 的公网真实生成、两轮报名应用修改和独立浏览器验收已通过。API 发布为 `dev14-20260923-mobile-review`，Web 为 `dev13-20260923-final`；API 提交 `03b6da8` 的 [CI 已通过](https://github.com/hengworkinggit/pivloom/actions/runs/35820485171)。生产 Run 不设累计 Token 上限，仍记录用量并保留时间与工具调用边界。实测、旧失败及交付材料状态见[收尾记录](docs/test-runs/2026-09-23-finalization.md)和[交付矩阵](docs/test-runs/2026-09-23-delivery-matrix.md)。

## 本地运行

使用 Node.js 24 或更高版本，按[基础设施说明](docs/infrastructure-setup.md)准备 API 与 Web 的本地配置，在仓库根目录执行：

```bash
npm ci
npm run dev:api
# 另一个终端
npm run dev
```

打开 [Pivloom 前端](http://localhost:45231/projects)，使用已准备的真实测试账号登录。在[模型设置](http://localhost:45231/settings/models)填写服务地址、模型和 Key，保存并测试；普通用户不编辑服务器模型环境变量。账号口令和基础设施管理密钥不进入仓库。

使用远端已有 API 时只启动本地 Web，并配置 API 与身份服务的转发地址；同一数据库只能有一个执行器，不要同时启动本地 API 和远端 `pivloom-api.service`。维护者的 `npm run g0:serve -w @pivloom/api` 是独立基础设施探针，不属于正式产品导航。

原 Mock 演示保留在显式 `npm run dev:demo` 模式，含模拟生成、迭代、停止/重试和预览恢复。真实模式不会自动切换为 Demo；演示结果不计入真实产品验收。

## 发布到已有服务器

前后端分别构建，发布到 `/opt/pivloom/api-releases` 和 `/opt/pivloom/web-releases`，由独立 systemd 服务运行。宿主 Caddy 保留原有站点，Pivloom Web/API/预览使用回环端口 18012/18010/18011。

可复用的[打包、发布、回滚和公网探针](infra/release/README.md)已经入库，不依赖维护者的 `.cache/development` 脚本。模型 Key 通过设置页面保存；服务器环境文件只放基础设施配置。构建产物禁止携带 `.env` 文件。

生产 API 拒绝 `TEST_PROFILE` 和测试依赖注入。故障验收的 `apps/api/scripts/testing/repair-server.mjs` 只用于独立测试数据库，不能成为公网服务的启动项。

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

- [PRD：功能、边界与完成条件](docs/PRD.md)
- [TRD：架构、开源模块参考、接口、数据与实施路线](docs/TRD.md)
- [E2E：Codex 内置浏览器测试方案及用例](docs/E2E.md)
- [文档优先级与当前状态](docs/README.md)
- [正式开发总 Spec](docs/specs/real-development-v1.md)
- [GitHub 开发任务、依赖与逐模块 E2E 门槛](docs/tickets/real-development-v1/README.md)
- [研究索引](research/README.md)
- [前端实现与 Mock 接口说明](apps/web/README.md)
- [前端开源参考](docs/frontend-open-source.md)
- [第三方 UI 版权声明](docs/third-party-ui-notices.md)
- [设计方向与样式规范](design/README.md)

确定的主路线：Next 工作台 + 常驻 Fastify API + Pi SDK + OpenSandbox（Docker + gVisor）+ agent-browser + 自托管 Supabase。固定三角色按阶段交接，只有 Builder 写源码；不叠加 Deep Agents、LangChain 或 LangGraph。相关评估已写入 TRD。

## 仓库结构

前后端同仓维护、独立构建和部署，共享接口契约。

```text
apps/
  web/                 Next.js 工作台
  api/                 Fastify API 与 Agent 服务
packages/
  contracts/           共享类型、事件和接口 schema
docs/                  PRD、TRD、E2E 规格
research/              历史研究记录
```

`apps/web` 为 Next.js 前端，`apps/api` 为常驻 Fastify API 与隔离运行时，`packages/contracts` 为共享 schema；`migrations` 与 `infra` 提供数据库和自托管配置。历史研究保留原工作名，不作为另一套产品范围。

PRD/TRD/E2E 描述真实产品的目标；各模块以独立浏览器与真实集成验收为准，Mock、故障 fixture 和真实模型运行分别记录。公开源码交付前应排除私有题面研究记录及任何凭据。
