# DEV-13 · 上线真实工作台并完成独立全链路验收

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F01–F15 / D01–D05。

## What to build

评审在公网HTTPS入口登录，独立生成、操作、修改和重新打开项目；交付说明准确列出通过、未完成和限制，不依赖开发机或Mock。

## Implementation decisions

- 单Linux主机复用Caddy，Compose管理web、常驻api与裁剪Supabase；同源/api/v1和SSE保留路径且不缓存流。沙箱须G0锁定，用户模型通过设置页管理；禁止生产TEST_PROFILE和demo adapter。
- CI跑共享contract、必要集成测试、typecheck/lint/build；Codex内置浏览器无已验证无头CI接口，UI E2E采用桌面实测门槛，不能造一个假自动Actions成绩。
- 公开部署、账号/云资源缺失记录具体前置；不新购服务、不公开secret。仓库现含私有研究记录，成果公开策略须排除敏感历史；本票不擅自切public或发送提交消息。
- 干净checkout运行说明、配置名称、迁移/模板、模板锁版本、备份/重启与回收步骤齐全；记录准确收题T与剩余B，不从本次issue时间重置48h。

## Acceptance criteria

- [ ] 最终UI关闭Mock入口/虚构日志，Reviewer gate强制；A初次+两次修改、B初次均真实模型运行且对应行为通过。
- [ ] 模块票逐一附当时E2E证据，最终只在这些基础上做跨模块与线上回归；严重S0/S1无未解决项。
- [ ] 所有适用E01–E31/I01–I12逐项PASS或清楚说明例外；BLOCKED/NOT_RUN不能当完成或作为关闭本票理由。
- [ ] 线上E01/E04/E05/E08/E11/E21/E31、390px工作台与生成应用、真实跨源预览及SSE均通过。
- [ ] D01–D05逐项记录：入口、clean checkout、功能清单、权限/材料、实际截止；需用户最终发送/权限动作时标待执行，不冒充已提交。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| RC全量 E01–E31/I01–I12 | 在隔离staging执行适用正常与故障测试，复用已验证模块数据但记录本次build/config。 | A3轮+B1轮是真实链路；fixture故障分开；所有S0/S1修复后相关模块立即复测，非相关测试无需盲目重跑。 |
| 线上 E01/E04/E05/E08/E11/E21/E26/E31 + I11/I12 | Codex内置浏览器从公网登录→生成→iframe操作→修改→重登录；检查代理、bundle与生产开关。 | 无需本机；静态资源与SSE正常；无跨owner信息、private keys或测试注入入口。 |
| D01–D05 | 在干净环境按交付说明运行，核对成果入口、仓库访问策略和真实提交期限。 | 功能完成清单与证据一致；敏感研究/凭据不公开；未授权的提交发送不执行。 |

## Blocked by

- [DEV-04 · #5](https://github.com/hengworkinggit/pivloom/issues/5)
- [DEV-07 · #8](https://github.com/hengworkinggit/pivloom/issues/8)
- [DEV-12 · #13](https://github.com/hengworkinggit/pivloom/issues/13)

## Out of scope

不追加P2历史回滚/ZIP、多团队、可视化编辑、应用Cloud或永久发布；范围变更必须另行记录。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。

## 已授权部署主机补充（2026-09-22）

只读检查：Ubuntu24.04 x86_64、2vCPU、约4GiB内存、剩余约25GiB磁盘；无/dev/kvm及vmx/svm标记。随后已部署并通过OpenSandbox/gVisor基础设施探针；当前磁盘约21GiB空余，完整负载容量待实测。

- 复用现有Caddy，保留80/443原站点及127.0.0.1:3000既有应用；项目使用独立目录、服务名、网络和回环端口。代理先备份、validate、reload，再回归原站点。
- Docker/Compose已运行，启动前确认原无既有容器；新增独立gVisor runtime，默认runtime不变。Supabase优先裁剪自托管并由代理生成配置，采用正式Docker部署方案；不增加MinIO。
- 沙箱采用已实测OpenSandbox Docker + gVisor systrap。内部服务受systemd管理并仅绑定回环；文件/命令/Chrome/跨origin预览/取消/TTL/清理已通过。完整Pi、Auth/Storage、联合容量及公网预览验收仍待完成，不能将fixture或内部隧道结果当作产品上线。
- 本地开发/E2E无需域名；公网发布阶段才配置DNS/HTTPS及预览入口。缺域名不能阻塞本地模块开发。
- 普通用户模型Key由设置页录入、服务端加密存储；平台主密钥与服务配置由部署代理维护。不能把一个用户Key变成全站共享默认模型。
- [ ] 公网HTTPS、同源API/SSE、独立预览origin以及新旧站点共存通过；资源有余量，新增服务可独立停止/回退。
- [ ] 线上回归E31模型设置和实际选中模型生成；SSH/数据库/模型密钥不进入issue、Git、镜像或脱敏证据。
