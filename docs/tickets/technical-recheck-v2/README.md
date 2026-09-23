# Pivloom 技术复核开发任务

规格：[总Spec](../../specs/technical-recheck-github-spec.md)。按 /to-spec 与 /to-tickets 从已确认方案拆成12个完整切片；每票完成后立即执行关联E2E，再关闭。

| 票 | 交付 | 直接阻塞 |
|---|---|---|
| [RC-01](rc-01-deployment-provenance.md) | 页面展示可核对的 Web/API 部署 SHA | 无 |
| [RC-02](rc-02-pi-lifecycle.md) | 复用 Pi 原生生命周期并可靠停止三个角色 | 无 |
| [RC-03](rc-03-durable-terminal-cleanup.md) | 失败终态可靠落库并完成资源清理与重试 | RC-02 |
| [RC-04](rc-04-reviewer-image-pipeline.md) | 让 Reviewer 真正读取截图并验证模型图像能力 | RC-02 |
| [RC-05](rc-05-canvas-browser-actions.md) | 复用原生批量动作完成 Canvas 游戏观察闭环 | RC-04 |
| [RC-06](rc-06-five-groups-full-regression.md) | 固定五组验收并完整保留增量子检查 | 无 |
| [RC-07](rc-07-preview-session-isolation.md) | 退出与切账号后撤销私有 Preview 访问 | 无 |
| [RC-08](rc-08-revision-history-diff.md) | 浏览完整历史版本及真实源码差异 | 无 |
| [RC-09](rc-09-atomic-revision-rollback.md) | 原子回滚已验收版本并统一 Preview 与对话基线 | RC-03, RC-07, RC-08 |
| [RC-10](rc-10-calculator-increments-e2e.md) | 全新计算器完成真实生成及功能和视觉两轮增量 | RC-01, RC-03, RC-05, RC-06 |
| [RC-11](rc-11-canvas-snake-e2e.md) | 全新 Canvas 贪吃蛇通过真实模型和浏览器验收 | RC-01, RC-03, RC-05, RC-06 |
| [RC-12](rc-12-frozen-release-recheck.md) | 冻结部署并完成跨会话回滚与故障最终复核 | RC-09, RC-10, RC-11 |

规格就绪不等于无阻塞。领取所有阻塞项已完成的前沿任务；共享生产生成槽属于运行资源约束，不额外把计算器和贪吃蛇互相设为阻塞。

只保留生产A、保护现有作品、维持定时任务关闭；隔离环境临时数据按本轮manifest精确清理。真实模型、离线fixture、上游测试和独立UI证据分别记录。
