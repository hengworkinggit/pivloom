# Pivloom · 派织

把想法织成可运行的应用。Pivloom 是基于 Pi SDK 的 AI Web 应用构建工作台，固定角色协作完成规划、编码、浏览器检查和有限修复。

本项目原工作名为 nano-Atoms，面向限时 Atoms Demo 交付。当前处于规划阶段，**尚无产品代码或已部署 Demo**。

- [PRD：功能、边界与完成条件](docs/PRD.md)
- [TRD：架构、开源模块参考、接口、数据与实施路线](docs/TRD.md)
- [E2E：Codex 内置浏览器测试方案及用例](docs/E2E.md)
- [文档优先级与当前状态](docs/README.md)
- [研究索引](research/README.md)

确定的主路线：Next 工作台 + 常驻 Fastify API + Pi SDK + E2B + agent-browser + Supabase。固定三角色按阶段交接，只有 Builder 写源码；不叠加 Deep Agents、LangChain 或 LangGraph。相关评估已写入 TRD。

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

目前应用目录只有职责说明，尚未安装依赖或生成框架代码。历史研究保留原工作名，不作为另一套产品范围。

规格中的目录、接口和测试是待实现约定。当前完成了资料研究和独立浏览器能力探针，产品 E2E 尚未运行。公开源码交付前应排除私有题面研究记录及任何凭据，实际运行/部署说明将在实现后补充。
