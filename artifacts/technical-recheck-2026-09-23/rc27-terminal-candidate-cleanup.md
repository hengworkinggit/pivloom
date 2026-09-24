# RC-27 · 终态失败候选立即释放沙箱

`finishReview` 对通过、最终失败（`needs_changes`）和被阻断（`failed`）都可能返回 `repairNextAttempt=null`。执行器原先据此无条件保留沙箱；当检查在早期失败时，候选会继续占用原租期，数据库 `nano.sandboxes.state='active'` 也挡住部署。源码版本和检查记录在执行 Reviewer 前后已分别保存，不需要靠活沙箱保留。

现在仅在持久化 `run.state='completed'` 时保留已验收 Preview。最终 blocked/failed 由原有 `finally → destroy()` 立即撤销 Preview、kill 并确认沙箱、将数据库绑定标为 `destroyed`；清理失败仍走原有 pending/sweep 重试。提交回复丢失后的重新读取、终态落库重试也遵守同一规则，避免在恢复路径再次错误保留失败候选。`Revision`、源码对象和 `Check` 不删除，之后仍可按既有恢复预览流程重建。

新增快速确定性回归以模拟 `repository.finishReview` 的 `completed`、`failed`、`needs_changes` 返回值和沙箱 `destroy`：旧“无条件 retain”逻辑下两个失败终态用例为红（2 failed），改为仅 `completed` 保留后 4/4 通过；修复分支的资源销毁仍由原有逻辑处理。另有隔离数据库集成用例检查 blocked 后远端销毁、DB 释放、源码/Check 保留及下一 Run 可接受，同时检查 accepted 预览仍存活。该慢用例本机曾因 worktree 身份文件路径未设置而未执行；显式指定隔离测试身份后运行超过 100 秒未结束，已按时限中止并精确清理该测试创建的项目、Run 和模型配置。**未将慢集成测试记为通过**；API typecheck、lint 与 diff 检查通过。该分支不包含先前 60/45/65 分钟固定预算实验，不修改生产 Run、沙箱或控制面。
