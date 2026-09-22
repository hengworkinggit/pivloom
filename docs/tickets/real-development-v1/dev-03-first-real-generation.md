# DEV-03 · 从一个真实需求生成、保存并预览多文件应用

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F03/F04/F05/F07。

## What to build

用户在空项目提交活动报名需求，服务真实生成源码、构建、保存快照并提供能操作的预览。第二种读书需求独立生成不同实现，彻底替换按类型选静态成品的 Mock 路径。

## Implementation decisions

- 实现 POST /projects/:id/runs、GET /runs/:id、基础 SSE、项目结果读取。接受事务创建 Run、用户消息和 accepted 事件后才返回 202；一个项目一个操作，全局初始一个生成。
- Idempotency-Key 与规范请求 hash 去重；expectedCurrentRevisionId 防过时提交；冲突/未接受保留草稿。执行器在响应之后运行，SDK 事件进入串行 EventAppender，关键阶段 await flush。
- Builder 为唯一写入者；新候选独立于已有成功预览；可信服务执行固定 typecheck/build，禁止模型改脚本空跑冒充通过。
- 源码快照采用确定性文本 manifest+哈希+压缩 bundle，先私有 Storage 校验上传，再 DB 引用；大小/路径/链接/敏感文件按既定约束拒绝。
- 预览绑定 revisionId/sourceHash/sandbox，服务写 marker 并核对；iframe 只接受后端生成的不同来源地址，禁止顶层导航和工作台 token 泄漏。
- G1 仅交付真实生成并保存的候选：Reviewer 尚未接入时，以 CHECK_BLOCKED（检查能力尚未就绪）明确结束 run，释放生成操作锁；候选展示“尚未检查”，current 保持为空。关闭Chrome并撤销写权限后，将候选转为明确登记、受短TTL限制的candidate-preview供UI验收；不得被run的finally立即销毁。过期提示不可用，DEV-10接入后提供恢复。不得造passed；DEV-06接入后重跑完整E04/E12，才验收正常completed/current。
- 真实调用从本票起就具备最小安全结束边界：run10分钟、单模型90秒、工具80次、输出/文件大小上限、短sandbox lifetime、超时后远端清理。DEV-11集中实现日额度、统一跨角色计量、扫描和压力验收，不能等它完成才给早期真实E2E加超时。

## Acceptance criteria

- [ ] 1–8000 字符有效输入才接受；请求失败不丢草稿；accepted 成功后有唯一用户消息与 run ID。
- [ ] 活动报名和读书清单各用新项目走真实模型/工具，产物符合不同需求，不读取预制成品作为结果。
- [ ] 状态来自实际执行；非零 build、预览失败、Storage 失败均不宣告成功或破坏已有 current。
- [ ] 已保存快照可从服务端读回，文件 hash 与执行源一致；成功/失败都保留可读原因和关联 ID。
- [ ] 本票只验收生成/构建/保存/可操作候选子链路；检查未就绪以可解释的 blocked 结果结束，current 不变；完整 E04/E12 在 DEV-06 由真实 Reviewer 验收。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E04/E05/E06/E12 的候选生成子集 | 内置浏览器输入既定活动需求A；依次验证空字段、not-an-email、添加林舟/田禾/宋宁、确认田禾、搜索林；另建项目输入读书需求B并添加两书。 | A 新增/校验/确认/搜索实际成立；B 无活动/邮箱字段且标已读可用；相同预览来源刷新保留业务数据；新标签 revision一致。 本票结果明确为已保存候选、检查受阻；不把完整成功生成 E04/E12 记 PASS。 |
| E27 / I05 | 隔离环境对本 run 注入 Storage 上传失败，以及上传成功但 DB 引用失败。 | UI 显示保存失败；current 不悬空；没有假成功 revision；孤儿对象可识别；实际执行结果和注入边界分别记录。 |
| I01/I11 子集 + E02 提交子集 | 相同 key 同/异内容、不同 key 并发提交；无效身份发起生成；篡改 build script 测可信 gate。 | 唯一 run/消息、冲突正确、未鉴权无模型调用、无宿主运行；准确记录本票未完成的 Reviewer 部分。 |

## Blocked by

- [DEV-01 · #2](https://github.com/hengworkinggit/pivloom/issues/2)
- [DEV-02 · #3](https://github.com/hengworkinggit/pivloom/issues/3)
- [DEV-14 · #15](https://github.com/hengworkinggit/pivloom/issues/15)

## Out of scope

不在本票实现完整重连、停止 UI、有限修复或永久应用托管；这些由后续依赖票验收。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。

## 模型入口补充（2026-09-22）

- DEV-14（#15）的用户模型设置是本票前置。工作台读取当前owner的配置，展示默认/选中模型；无配置引导设置，不借用其他账号密钥或退回Mock。
- 请求传modelProfileId/modelConfigVersion；服务端验证owner、版本有效性和已实测能力。Run固定配置与凭据版本的服务端引用，幂等hash包含profile/version；Key不进入Run、SSE、日志、快照或沙箱。
- 运行中更新、默认切换、删除不得悄悄换模型；未开始的新任务按新配置校验。真实连接/流式/工具调用在#15验收，本票再次验证所选配置实际完成应用生成。
- [ ] UI选择与真实provider/model/version一致；两个有效配置的切换实际验证，无前置的用例记BLOCKED。
- [ ] 覆盖伪造/他人/删除的profile、同幂等key异profile/version、运行中配置编辑/默认切换/删除；桌面与390px可操作，响应无Key。
- 图片存储不等于附件聊天/音视频；视觉能力未经实测仍为unknown/DOM-only。
