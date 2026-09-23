# Pivloom 文档入口

当前产品已有真实模型生成、三角色检查、项目与源码持久化、预览恢复和可选永久发布；历史结果见[收尾验收](test-runs/2026-09-23-finalization.md)和[发布验收](test-runs/2026-09-23-publication.md)。

2026-09-23新增技术复核正在进入改造阶段。**本轮已完成源码调研和离线接口探针，尚未完成业务移植或新版产品E2E。** 计算器、Canvas贪吃蛇、两轮增量、新会话隔离、回滚和部署SHA不能继承旧样本PASS。

| 文档 | 用途 |
|---|---|
| [GitHub总Spec #16](https://github.com/hengworkinggit/pivloom/issues/16) / [规格正文](specs/technical-recheck-github-spec.md) / [开发票清单](tickets/technical-recheck-v2/README.md) | 本次正式实施规格、完整切片、阻塞依赖和逐模块关闭门槛 |
| [技术复核方案 v3](specs/technical-recheck-v2.md) | 当前要实现的路线、五组/完整子检查、实施顺序和通过门槛 |
| [E2E v2](E2E.md) | 新原始Prompts、E01–E42与I01–I22、故障gate和证据口径 |
| [精确复用清单](../research/reuse-manifest-2026-09-23.json) | 固定上游commit、许可、COPY/ADAPT/直接调用边界、目标模块和测试映射 |
| [Pi审计](../research/pi-reuse-audit-2026-09-23.md) | 官方SDK接口、45离线测试、5探针、0.87迁移边界 |
| [开源回滚/生命周期](../research/oss-reuse-audit-2026-09-23.md) | OpenCode、OpenHands、Dyad的源码/测试与许可审查 |
| [OpenManus与小游戏](../research/openmanus-games-reuse-2026-09-23.md) | 图片反馈、Canvas短动作、Manus公开范围和历史game recipe |
| [浏览器/沙箱/会话](../research/browser-session-reuse-2026-09-23.md) | 原生动作探针、OpenSandbox生命周期、Supabase注销语义 |
| [PRD](PRD.md) / [TRD](TRD.md) | 产品和领域背景；本次改造冲突以当前复核方案为准 |
| [部署](../infra/release/README.md) / [基础设施](infrastructure-setup.md) | 现有自托管服务及发布运维 |

文档优先级：用户最新明确要求 → 当前复核方案/复用清单/E2E → 原PRD/TRD和开发票 → 历史研究。已关闭旧issue不代表新复核通过；Mock、离线fixture、上游测试、真实模型与独立UI分别记录。

每模块完成立即做关联E2E，最终冻结一组明确Web/API SHA复核。生产只保留原评审账号的要求继续有效；隔离测试临时身份和资源按精确manifest处理。Codex服务巡检与飞书评论自动化已停用，本轮不自动恢复。
