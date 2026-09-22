# DEV-02 · 登录后创建、重开并隔离服务端项目

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F01/F02/F07。

## What to build

评审用户以预建账号登录，从真实服务创建自己的空项目，刷新和重新登录后仍可打开；其他账号无法读取或操作。现有首页样式保留，真实模式不显示三张预置项目或自动登录。

## Implementation decisions

- Supabase Auth signInWithPassword 与 session 刷新；Fastify 校验 access token 的有效身份，不能仅 decode JWT。
- 建立 owner 隔离的 Project 与分页查询；GET /me、GET/POST /projects、GET /projects/:id 走 /api/v1。私有表和 bucket 不向 anon 直接开放。
- 把前端数据调用收敛为显式可切换的 Demo/API adapter；真实模式配置缺失必须显示配置错误，禁止悄悄降级到 Mock。登录退出清除私有查询缓存。
- 正式项目列表从服务读取，空态提供示例需求但不生成预制成品；可安全保留未发送草稿。初步同源代理与健康检查在此落地，已有部署环境时同步跑 staging 入口，不等发布票才验证网络。

## Acceptance criteria

- [ ] 有效账号进入；错误登录反馈一致；过期 session 返回登录；退出后受保护页面不残留项目内容。
- [ ] A 连续创建两个项目，得到独立 ID；刷新与重新登录后还在；B 的列表不包含 A 的项目。
- [ ] B 读取/修改 A 的项目返回不泄漏归属的拒绝响应；直接访问数据库/Storage 不能绕过 API。
- [ ] 登录、空列表、创建中、创建失败都有实际状态；失败保留输入；正式模式无测试口令/账号硬编码。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| E01/E02/E03/E11 项目子集 | A 错误登录→正确登录→创建两项目→刷新→退出→重新登录→分别打开。 | 账号、标题、项目 ID 一致；空文本/超长提示不触发提交；中文输入 composition 不误发。 |
| E25 / I09 项目子集 | 记录 A 项目 ID，退出后登录 B；由浏览器和真实 HTTP 请求访问 A 的资源。 | UI 不展示 A 内容；服务返回拒绝且无写入；不同标签不能冒充独立登录 context。 |
| E26 增量 | 1280×800 和 390px 完成登录/创建，键盘操作核心按钮。 | 无整页横向溢出，输入及错误有可访问名称。 |

## Blocked by

None（可立即开始；真实服务前置缺失时显式标 BLOCKED）。

## Out of scope

不做注册、找回密码、组织、多团队、删除和项目共享；本票不调用模型。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。

## 接入与环境准备补充（2026-09-22）

- Supabase Auth/Postgres/私有Storage优先由代理在已授权服务器自托管，保留已有Caddy与站点，裁掉未用组件。服务URL、API Key及数据库密码由部署过程生成，不要求用户申请Supabase云项目。
- 代理负责迁移、私有schema/bucket、A/B身份、随机测试密码、幂等seed、资源manifest及精确清理；本地开发通过localhost/SSH隧道连接，不依赖域名。
- 每个实例有显式环境ID；维护脚本核对目标地址和实例标识，不把supabase.co后缀当唯一合法环境。环境级故障用可丢弃隔离实例，共享/评审数据禁止全库reset。
- 源码快照、截图和诊断工件使用Storage私有bucket及持久卷，设计备份恢复；本轮不增加MinIO。
- [ ] setup/seed可重跑；A/B登录、跨owner拒绝、Storage上传/读回/删除与测试资源精确清理通过。
- [ ] 测量裁剪栈与原站点共存的资源占用；4GB主机是否有余量供沙箱构建和Chrome使用仍须实测。
