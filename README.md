# Pivloom · 派织

把想法织成可运行的应用。Pivloom 是基于 Pi SDK 的 AI Web 应用构建工作台，固定角色协作完成规划、编码、浏览器检查和有限修复。

本项目原工作名为 nano-Atoms。当前真实模式已接通登录、项目持久化和页面模型配置；Pi → OpenSandbox/gVisor → 构建 → Chrome 检查已通过独立维护探针。**正式工作台的生成、版本和发布流程尚未串联，尚未完成公网交付。** 详见[基础验收记录](docs/foundation-validation-2026-09-22.md)。

## 本地运行

使用 Node.js 24 或更高版本，按[基础设施说明](docs/infrastructure-setup.md)准备 API 与 Web 的本地配置，在仓库根目录执行：

```bash
npm ci
npm run dev:api
# 另一个终端
npm run dev
```

打开 [Pivloom 前端](http://localhost:45231/projects)，使用已准备的真实测试账号登录。在[模型设置](http://localhost:45231/settings/models)填写服务地址、模型和 Key，保存并测试；普通用户不编辑服务器模型环境变量。账号口令和基础设施管理密钥不进入仓库。

真实模式支持项目创建、重开、刷新/重登持久化及账号隔离。维护者可运行 `npm run g0:serve -w @pivloom/api`，在仅本机页面输入临时模型凭据验证真实生成与沙箱预览；它不属于正式产品导航。

原 Mock 演示保留在显式 `npm run dev:demo` 模式，使用演示账号 `demo@pivloom.app` / `demo1234`，含模拟生成、迭代、停止/重试和预览恢复。真实模式不会自动切换为 Demo；演示结果不计入真实产品验收。

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

PRD/TRD/E2E 描述真实产品的目标，前端 Mock 并不等于这些端到端验收已完成。当前前端验证与已知边界见 [验证记录](docs/frontend-verification.md)。公开源码交付前应排除私有题面研究记录及任何凭据。
