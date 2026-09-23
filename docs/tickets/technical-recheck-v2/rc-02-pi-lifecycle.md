# [RC-02] 复用 Pi 原生生命周期并可靠停止三个角色

## Parent

[总Spec](../../specs/technical-recheck-github-spec.md)

## What to build

用户在Coordinator、Builder、Reviewer的模型流、工具等待、重试退避或上下文压缩期间点击停止，看到真实取消结果；正常/重试成功的任务只在SDK真正结束后收口。

## Acceptance criteria

- [ ] 三个Pi依赖固定0.86.1；复用官方会话、远程operations、ToolDefinition、retry与compaction；不引入第二套Agent循环或顺带升级0.87。
- [ ] 先做必要的薄宿主收敛，再逐角色迁移并保持回归可运行；保留owner/路径约束、凭据隔离和可回读业务证据。
- [ ] 等待原生abort/idle或运行promise结束再dispose；不能在agent_end(willRetry)时提前宣告角色完成。
- [ ] 修复Builder返回cancelled却进入finishFailed的路径；用户取消最终为cancelled，deadline、Provider超时和服务停止保留不同原因。
- [ ] 使用Dyad取消请求latch的小模块适配Run UUID；连续点击Stop不会反复提交或提前解除停止状态。
- [ ] Provider重试仅一个控制点，成功assistant响应重置连续错误计数；退避中可取消，认证/非法参数不盲重试。
- [ ] Pi listener返回void不代表外部写库完成；保留异步事件drain并传播错误，不能通过吞异常删掉执行责任。
- [ ] 官方compaction替代固定last-two-turn裁剪；长会话压缩后工具声明、要求和证据可回读，取消压缩能收口。
- [ ] 完成E13/E14/E41及I02/I03/I19/I20/I21的定向实测；真实远端终止与离线SDK结果分别报告。

## Upstream reuse

采用 U01, U02, U04, U06, U08；按[固定源码与许可清单](../../../research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不重新加入累计Token停止阈值；不把本地abort或按钮状态当远端沙箱已销毁。

## Testing and completion gate

- 关联UI/E2E：E13, E14, E41。
- 关联集成：I02, I03, I19, I20, I21。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](../../E2E.md) · [技术方案](../../specs/technical-recheck-v2.md)

## Blocked by

None (can start immediately).
