> 这是专项调研笔记。部分选型建议基于该子问题独立提出；最终跨项目组合与本次实施范围以[综合决策报告](atoms-product-and-architecture.md)为准。

# 高 star Agent／执行层补充候选

2026-09-21 通过 agent-reach 的 gh 与 Exa 后端核实。stars、license、pushed_at 均是 `gh api repos/...` 现场结果；stars 是时点热度，不是可用性或安全评估。仅审阅官方 README/文档，未实施带模型的集成测试。

| 项目（实际作用层） | GitHub stars | License | pushed_at UTC | 本次 6–8h 用法判断 |
|---|---:|---|---|---|
| OpenHands/OpenHands（Agent Canvas 产品控制台） | 88,690 | MIT | 2026-09-21 09:22:26 | 参考会话、Agent backend 切换、workspace 与服务边界；不要整体 fork 当作网页生成器 |
| e2b-dev/E2B（云 sandbox 执行层） | 13,901 | Apache-2.0 | 2026-09-21 09:14:04 | 若已有账号/key，适合与 Pi 等 Runner 组合，用于命令、文件、preview URL；不是 Agent loop 替代品 |
| opensandbox-group/OpenSandbox（自托管 sandbox 平台） | 15,438 | Apache-2.0 | 2026-09-21 07:45:04 | Docker/K8s sandbox lifecycle/exec/files/ingress 独立组件；若已有可用部署可用，否则 6–8h 从零搭平台风险大 |

## 关键纠正：OpenHands 的高 star 主仓不是现在的 Agent SDK

当前 OpenHands/OpenHands README 标题为 **Agent Canvas**，标识 beta，定位 self-hosted developer control center。它可控制 OpenHands、Claude Code、Codex、Gemini 或 ACP agent，工作在本机、Docker、VM/远程后端。README 分层明确：Canvas 产品 UI、Software Agent SDK/Agent Server、automation scheduler 分仓负责。不要用旧知识把整个 88k★ 仓库当作一个 SDK。

实际可替换 Pi/DSH 的底座是 `OpenHands/software-agent-sdk`：现场 1,146★，MIT，pushed_at 2026-09-21 08:17:39 UTC，固定 commit `856d99d48e4b11c70c5f1cab21e7830570dbc324`。提供 Python、TypeScript 与 REST APIs；Agent/Conversation/Tools/Workspace/Event/Agent Server；可在本机或 Docker/K8s ephemeral workspace 执行。当前 SDK README 说 browser-compatible TypeScript client 已在 `clients/typescript`，而 Canvas README 还指旧独立 client 仓库，说明边界正调整；因此应以锁定版本的 Agent Server/OpenAPI 合约核实集成。

**推荐用途**：中期若我们需要服务化 Python Agent、远程 Workspace、多个 coding agent provider，评估 OpenHands Software Agent SDK；本次全 TypeScript 小 Demo 优先轻量 SDK，借鉴 Canvas 的“前端产品→规范 API→Agent Server→Workspace Provider”分层。此建议是适配判断，不是性能对比实验。

一手链接：[Canvas 固定 README](https://github.com/OpenHands/OpenHands/blob/a5eb10d584f4dfbc6ac0fd7043c5b73bc0fa9f8e/README.md)、[SDK 固定 README](https://github.com/OpenHands/software-agent-sdk/blob/856d99d48e4b11c70c5f1cab21e7830570dbc324/README.md)。

## E2B：借执行能力，不借 Agent

E2B 官方 SDK 的最小接口是 `Sandbox.create()`、`sandbox.commands.run()`，可以执行 AI 生成代码。官方公开 URL 文档确认 `sandbox.getHost(3000)` 返回对应 sandbox 服务端口的 HTTPS host，后台运行服务后即可嵌入应用预览。适合我们的 `ExecutionProvider + PreviewProvider`，让 Agent 写项目、构建、启动服务，网页显示 preview。

**需要自己补**：sandbox 与 project/revision 的映射、文件快照的外部持久化、sandbox 超时后的恢复、用户隔离与 preview 权限、发布后的稳定产物。sandbox 的临时 preview URL 不能自动称为永久“部署链接”。

**本次建议**：已有 E2B key 时，是减少运维工作的候选。若没有账号/key，先将 ExecutionProvider 写成可替换接口，不要为了“全开源”在 6–8h 内自托管 E2B：官方 self-host README 指向 Terraform infra，支持 AWS/GCP，通用 Linux machine 未勾选。开源 SDK 的 Apache-2.0 不代表云服务免费，也不表示云服务所有运行 SLA 自动具备。

一手链接：[E2B 固定 README](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/README.md)、[sandbox public URL](https://e2b.dev/docs/network/public-url)、[self-host infra](https://github.com/e2b-dev/infra/blob/main/self-host.md)。

## OpenSandbox：更适合自托管执行层路线

`alibaba/OpenSandbox` 在 GitHub API 返回的 canonical 名称为 `opensandbox-group/OpenSandbox`。当前 README 描述 Docker/Kubernetes runtime、多语言 SDK、统一 lifecycle/exec/file API、ingress gateway、per-sandbox egress、credential vault，以及可选 gVisor/Kata/Firecracker 加强隔离。这是 **执行环境平台**，可跑 coding agent，但本身不决定模型如何改代码。

**推荐用途**：后续自托管版用其管理每项目 sandbox、端口入口、网络策略、文件生命周期。已有 Docker/K8s 与平台熟悉度时可先 spike 本地 Docker 路线；否则本次 MVP 只借接口设计，不承担从零搭 K8s/网关/卷的成本。不要因为它支持很多 runtime 就同时叠加多个 runtime。

一手链接：[OpenSandbox 固定 README](https://github.com/opensandbox-group/OpenSandbox/blob/b1a29cf93a823a95913f7943010febb3f29de05c/README.md)、[Server](https://github.com/opensandbox-group/OpenSandbox/tree/b1a29cf93a823a95913f7943010febb3f29de05c/server)、[API specs](https://github.com/opensandbox-group/OpenSandbox/tree/b1a29cf93a823a95913f7943010febb3f29de05c/specs)。

## 最小组合决策

不要把这些项目全装进来。选择关系是：

- **Agent loop**：Pi SDK / DSH SDK / OpenHands Software Agent SDK 三选一；推荐本次 Pi，DSH 与 OpenHands作为架构参照或后续独立验证。
- **Execution + preview**：已有云 key 时 E2B；已有自托管平台时 OpenSandbox；受控演示也可先 Docker provider。三选一。
- **产品界面/版本/应用发布**：自己围绕网页生成任务建立；OpenHands Canvas 主要参考长任务状态与后端解耦，不能替代我们的产物 UX。
