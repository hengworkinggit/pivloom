# [RC-12] 冻结部署并完成跨会话回滚与故障最终复核

## Parent

[总Spec](../../specs/technical-recheck-github-spec.md)

## What to build

评审者打开明确的一组Web/API产物即可复现两种新应用、两轮增量、五组结果、版本回滚和身份恢复；维护者有相同构建下的故障终态与资源证据。

## Acceptance criteria

- [ ] 先确认每个上游模块issue已有独立关联E2E记录，不能在本票补一张总表代替模块验收；冻结实际Web/API SHA、Pi/浏览器/沙箱与模型配置。
- [ ] 在线正常路径复核计算器A0/A1/A2和Canvas贪吃蛇，逐轮源diff、5组子项、Preview及版本元组一致；不继承旧样本PASS。
- [ ] 在最终产物上完成全新A浏览器、A退出重登、同浏览器切B、独立B及另一有效A矩阵，核对项目、对话、源码、版本和私有Preview。
- [ ] 同构隔离环境完成完整回滚及失败/并发/重启窗口；在最终构建核对回滚后下一次生成基线，公开发布仍只由用户主动更新。
- [ ] 超时、各阶段取消、终态DB失败、Provider单层重试、资源首次清理失败和服务重启均有对应UI/数据库/远端补证。
- [ ] 全部必需E01–E42、I01–I21、D01–D05逐项列状态及证据；固定0.86.1未升级时I22明确N/A；任何必需FAIL/BLOCKED/NOT_RUN不得关闭。
- [ ] 精确清理本轮临时身份/fixture/沙箱，保留生产A及正式作品；不恢复任何Codex巡检或飞书评论定时任务。
- [ ] 更新交付入口、当前实现范围、部署SHA和可复现测试报告；无凭据泄漏、不伪造结果，不自动代用户回复评审或发送材料。

## Upstream reuse

采用 U01–U15；按[固定源码与许可清单](../../../research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

这是一轮冻结产物的最终验收，不是重做所有开发；阶段失败先归因并重测受影响范围，必要模块仍保持开放。

## Testing and completion gate

- 关联UI/E2E：E01–E42, D01–D05。
- 关联集成：I01–I21, I22: conditional。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](../../E2E.md) · [技术方案](../../specs/technical-recheck-v2.md)

## Blocked by

- [RC-09 · 原子回滚已验收版本并统一 Preview 与对话基线](rc-09-atomic-revision-rollback.md)
- [RC-10 · 全新计算器完成真实生成及功能和视觉两轮增量](rc-10-calculator-increments-e2e.md)
- [RC-11 · 全新 Canvas 贪吃蛇通过真实模型和浏览器验收](rc-11-canvas-snake-e2e.md)
