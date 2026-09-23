# [RC-03] 失败终态可靠落库并完成资源清理与重试

## Parent

[总Spec](../../specs/technical-recheck-github-spec.md)

## What to build

取消、超时、Provider失败、数据库短时故障或首次销毁失败后，用户重新打开项目能看到正确终态；资源确认后可以继续提交或显式重试。

## Acceptance criteria

- [ ] 终态事务失败不能只log/catch吞掉后从执行队列移除；待持久化责任仍可追踪，DB恢复后幂等收口，不重发模型/工具副作用。
- [ ] 失败Run及错误阶段、原因、已保存候选可重新读取；旧current始终保留，重试生成新Run并关联旧Run。
- [ ] cleanup_pending有近期重试和持久化结果，不能只等原Preview TTL；确认前不误释放相应操作锁/资源槽。
- [ ] 按官方OpenSandbox区分renew、kill和close；确认远端已销毁后再记confirmed，精确绑定owner/run/sandbox。
- [ ] 处理创建后未绑定、Check完成但终态未提交、取消与成功竞争、API被终止后重启等窗口；只有一个合法终态且无永久活动Run。
- [ ] 恢复预览任务也参与停止与重启对账；关闭进程不无限等待无人持有的restore。
- [ ] 首个destroy失败不能误删其他owner/版本或永久发布产物；恢复后的显式重试可真正执行。
- [ ] E15/E18/E20/E30/E40和关联集成用例实际通过，报告包含DB状态、远端确认和模型调用计数；fixture与真实故障补证分开。

## Upstream reuse

采用 U07, U08, U12；按[固定源码与许可清单](../../../research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不建设分布式队列或透明Agent续跑；不以无限放宽超时、Token或工具限制掩盖状态缺陷。

## Testing and completion gate

- 关联UI/E2E：E15, E18, E20, E30, E40。
- 关联集成：I02, I03, I07, I17, I19。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](../../E2E.md) · [技术方案](../../specs/technical-recheck-v2.md)

## Blocked by

- [RC-02 · 复用 Pi 原生生命周期并可靠停止三个角色](rc-02-pi-lifecycle.md)
