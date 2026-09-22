# DEV-10 · 沙箱过期后从已保存版本恢复预览

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F05/F07/F11。

## What to build

用户打开失效预览时看到“源码已保存，需要重新启动”，点击后得到相同源码的新预览；构建可用的失败候选也可明确选择后恢复，不能当作成功版本。

## Implementation decisions

- POST project preview/restore与GET preview状态；按revisionId授权，恢复和生成共用项目operation互斥；Idempotency-Key贯穿创建和已完成结果。
- 读私有快照校验→新OpenSandbox→锁定安装→可信构建→marker/健康检查→保存binding；不调用生成模型、不创建源码revision。
- GET项目只探活/返回过期，不自动创建沙箱。旧restore幂等结果过期则提示用户新key发起，不静默重复花费。
- 保留失败候选的snapshot/check；可销毁未promote沙箱。查看构建通过候选时优先有效binding，否则按本流程恢复，并持续显示检查失败/受阻；build失败候选只显示源码与错误。

## Acceptance criteria

- [ ] 强制过期后UI可恢复并重新操作应用；revisionId/sourceHash完全一致，model调用计数不增加。
- [ ] 重复恢复/并发生成最多接受一个项目operation；失败明确可重试，操作锁正确释放或等待cleanup。
- [ ] 恢复候选不改变current、不把failed/blocked检查改成passed；不承诺恢复浏览器表单和localStorage。
- [ ] 无权revision、跨项目revision、破损hash和无法构建的候选均不能返回错误预览。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E17 | 从UI记录revision/hash→维护者精确销毁该测试sandbox→打开项目→点击恢复→操作应用。 | URL/binding可变化，但源码hash、revision不变，无新增模型请求；能新增/筛选同一功能。 |
| I01/I05 恢复子集 | 重复key、key异revision、恢复与生成并发、snapshot hash不符。 | 幂等返回已有operation；冲突拒绝；未校验快照不运行。 |
| 候选恢复专项；E24后复测 | 在隔离环境准备已保存、build通过但check失败的候选，销毁沙箱后UI查看并恢复。 | 警示仍在、current不变、无模型调用；构建失败候选无iframe。 |

## Blocked by

- [DEV-08 · #9](https://github.com/hengworkinggit/pivloom/issues/9)

## Out of scope

不做生成应用永久部署、旧版本promote回滚UI或跨来源业务数据迁移。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
