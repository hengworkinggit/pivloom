# Pivloom（原 nano-Atoms）研究与实施入口

**当前开发规格已整理为：[PRD](../docs/PRD.md)、[TRD](../docs/TRD.md)、[E2E 用例](../docs/E2E.md)。** 它们接续限时方案 v3，进一步确定接口、状态和测试方式；开发以新规格为准。[文档优先级](../docs/README.md)

原题依据：[原题要求与 Atoms 功能复核](brief-requirements-recheck.md)；范围来源：[限时交付方案 v3](delivery-48h.md)；团队参考：[Multica 团队机制](multica-team-reference.md)。

用户只有 **48 小时**，覆盖此前长期完整对齐的选择。原题的 48 小时是收题后的提交期限，6–8 小时是建议集中开发窗口。M3/M4 延期，保留生成、预览、持续修改、项目与源码持久化、工作台上线和 GitHub 交付；固定三角色协作、浏览器操作与有限修复构成选定延展。生成应用独立数据库、双环境和一键发布不再必做。技术主选择仍为 Next + Pi + E2B + agent-browser + Supabase，生成应用 React/Vite。

[完整产品与架构蓝图](implementation-blueprint.md)保留为长期参考，不代表这次交付承诺。有范围或组件冲突时，以最新 PRD/TRD/E2E 为准，再参考 48 小时方案。

## 当前有效的专项依据

- [Multica 团队机制](multica-team-reference.md)：固定三角色协作与浏览器检查；借鉴设计，保持 Pi/E2B，明确直接复用的许可与集成边界。
- [Atoms 功能核验](atoms-feature-audit.md)：官方功能、限制、来源、移动/视频/Figma补验。
- [运行时 ADR](runtime-decision-v2.md)：Pi、远程工具、队列、会话、取消、恢复与预算。
- [浏览器与视觉修改](browser-decision-v2.md)：正式版本、本地实测、接管、源码映射和许可。
- [移动模块](mobile-decision.md)：Expo、Android构建、原生验证及版本兼容边界。
- [视频模块](video-decision.md)：生成/剪辑/导出、任务与工件、开源许可和集成门槛。

最新 PRD/TRD/E2E 细化限时范围；长期蓝图和专项笔记保留技术依据、实际证据与未验证项。移动和视频专项仅作后续参考。当前是研究与架构交付，不是已经实现或部署的产品。

## 历史背景

`atoms-product-and-architecture.md`、`browser-agent-options.md` 与其余初轮研究保留供追溯；其中 Fragments 单文件主底座、以逐版本证据卡作为差异化卖点的建议已经撤回。不要直接将旧稿的时间限制、候选列表和主架构作为开发任务输入。
