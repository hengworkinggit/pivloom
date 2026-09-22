# Pivloom 开发规格

版本：1.0 · 2026-09-22。状态：**真实身份/项目/模型设置及 Pi/OpenSandbox 基础探针已通过；正式生成工作台、版本和公网全链路尚未完成。** 以[基础验收记录](foundation-validation-2026-09-22.md)为当前实测状态。

正式开发使用 `/to-spec`、`/to-tickets` 形成的 GitHub issues，每模块完成后立即执行相关 E2E。默认运行版本是 API 模式；历史 Mock 显式保留，边界见[前端说明](../apps/web/README.md)。[历史 Mock 验证记录](frontend-verification.md)不计为真实产品验收。

正式开发入口：[总 Spec](specs/real-development-v1.md)、[开发任务与依赖](tickets/real-development-v1/README.md)。任务编号使用 `DEV-xx`，避免与 TRD 的技术模块 `Txx` 混淆。

接入准备见[基础设施与 E2E 分工](infrastructure-setup.md)：已授权服务器自托管 Supabase 和 OpenSandbox，开发代理负责服务配置、迁移、账号、数据和清理，用户模型通过页面配置。

这套规格面向用户确认的限时 Atoms Demo：真实生成、持续修改、交互预览、平台持久化，以及固定三角色的浏览器检查与有限修复。它接续研究阶段的[48 小时方案 v3](../research/delivery-48h.md)，将技术选择细化为可开发的契约。

| 文档 | 解决的问题 |
|---|---|
| [PRD](PRD.md) | 给谁用、做到什么程度、哪些不做、用户流程和完成定义 |
| [TRD](TRD.md) | 模块职责、开源实现参考、数据模型、接口、状态机、远程工具、部署和开发顺序 |
| [E2E 测试规格](E2E.md) | Codex 内置浏览器操作规程、测试数据、用例、异常注入、证据和发布门槛 |

开发时的优先级：**用户后续明确指示 → 正式开发 Spec 与 GitHub issues → 本套 PRD/TRD/E2E → 限时方案 v3 → 专项研究 → 历史蓝图**。题面事实仍以[原题核对](../research/brief-requirements-recheck.md)为依据。长期文档中的队列集群、完整 Cloud、视觉编辑、移动和视频，不因被研究过而自动进入开发范围。

这里的 `Fxx` 是产品功能，`Txx` 是技术模块，`Exx` 是浏览器用例，`Ixx` 是服务集成用例，`Dxx` 是交付核对。E2E 文档末尾给出映射。代码目录、接口和开发命令均是**待实现约定**，不能把它们当作已经存在的文件、服务或测试成绩。

当前已验证的是研究工具能力：Codex 内置浏览器能操作独立夹具中的表单和跨源 iframe、读状态与控制台、调整视口；产品内部 agent-browser 有此前本地独立 smoke。二者都不等于 Pi + OpenSandbox + Pivloom 全链路已经跑通。详见 [E2E 的能力核验记录](E2E.md#capability-probe)。

截止时间是收题后 48 小时，准确收题时刻尚未提供。实施时先填写实际截止时间和剩余可工作时间，不能从本文件日期重新倒数。

沙箱已经在授权服务器通过独立基础设施探针并选定 OpenSandbox Docker + gVisor，见[实测结果](sandbox-g0-results.md)。Pi/Supabase 单沙箱联合链路已经通过；多沙箱联合容量和正式产品全链路 E2E 仍待完成。
