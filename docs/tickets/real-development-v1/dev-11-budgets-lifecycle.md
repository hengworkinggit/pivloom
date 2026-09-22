# DEV-11 · 容量、额度和超时约束下可控运行与资源回收

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F09/F10/F11/非功能资源约束。

## What to build

用户遇到忙碌、额度不足或超时时得到明确状态，未被接受的需求不会消失；Chrome、候选和过期预览按真实生命周期回收，不持续产生无界成本。

## Implementation decisions

- 服务端集中预算：项目生成1、全局生成1、恢复1、sandbox上限须通过Supabase联合容量校准（覆盖旧预览+新候选共存，不沿用4）；run10min、模型90s、install120s/build90s、browser动作15s/review300s；工具80次、token200000、每账号日accepted20；Reviewer/Token已按2026-09-22首次三角色集成校准，依据见TRD §12.4，其余限制按G0校准。
- 未接受容量满503+Retry-After，额度429；只有accepted run计日额度，重试是新accepted run，幂等重放不二次计数；不建隐形队列。
- 统一跨角色预算守卫和deadline触发既有取消/清理路径；缺usage不能当0，token只做预留+实际计量约束，不宣称精确金额硬截断。
- 每分钟扫描已登记过期资源，服务端TTL兜底；不能驱逐活动检查候选或误杀current；快照5MiB/200文件、单文件512KiB，日志/工件有上限。
- 清理仅操作本服务manifest登记资源；失败候选数据保留以供诊断和按需恢复；记录无法在创建返回前登记的崩溃窗口。

## Acceptance criteria

- [ ] 多账号/项目并发全局限制成立，拒绝侧输入保留；同key重试不重复占槽或扣quota。
- [ ] 全局总sandbox数量受控，恢复与生成共同计容量；任务终态且清理确认后释放资源。
- [ ] 短deadline注入后停止派工，UI说明超时与cleanup pending，确认结束才解锁。
- [ ] 重启可重新扫描登记资源；超额文件/日志不静默丢弃后宣称完整，未知价格不报虚假成本。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E28 | 同时从两个项目触发生成，使用受控额度耗尽测试账号再提交。 | 一个accepted，另一个503/429且草稿保留；没有隐藏run、重复额度与后台排队。 |
| E30/I02/I08 | SHORT_DEADLINE_CLEANUP_DELAY缩短预算并延迟清理确认；真实OpenSandbox资源核对。 | 不再新调用；UI明确pending；不能立即新建；确认资源销毁后释放锁。 |
| 生命周期集成 + E17回归 | 过期回收器处理空闲预览并保留活跃候选；用户回到被回收预览点击恢复。 | 计数/绑定一致；快照仍在且恢复不调用模型；没有误杀活动run。 |

## Blocked by

- [DEV-09 · #10](https://github.com/hengworkinggit/pivloom/issues/10)
- [DEV-10 · #11](https://github.com/hengworkinggit/pivloom/issues/11)

## Out of scope

不做计费平台、支付、跨实例队列或复杂资源调度集群。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。
