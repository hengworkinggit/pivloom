# DEV-01 · G0：打通 Pi → 隔离沙箱 → 可操作预览的真实垂直探针

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent（仅表示规格就绪，仍须检查依赖和环境前置）。

覆盖：F03/F05/F09/F14 的技术前置。

## What to build

维护者从本地受控探针页面输入一个小需求，经真实 Pi tool call 修改隔离沙箱空模板，在 iframe 操作结果，并由沙箱内 agent-browser 独立执行同一交互；失败能定位到实际边界。此探针用于决定后续实现可行性，不作为正式产品 E04 的替代。

## Implementation decisions

- 先检查并保留现有 Mock 前端工作区，建立可复现代码基线，禁止覆盖用户未提交改动；共享 contracts 只放请求、事件和错误 schema，API 与 web 独立工作区。
- 采用 Pi coding-agent SDK、经G0验证的沙箱适配器、React/TypeScript/Vite 空模板；准确版本以已选 TRD 基线、实际包类型与编译结果锁定。记录 Node、Pi、沙箱SDK/runtime、CLI、Chrome、模板ID/digest，不把当前本地 CLI 版本当成远程镜像版本。
- Pi 使用隔离资源加载、受控模型配置；工具名称 allowlist 与 customTools 按锁定版本核实。read/write/edit/bash 全部映射远端；禁用未远程适配的宿主工具。
- 探针仅本地或维护者受控测试环境可用，不能把匿名生成、原始 shell、凭据或测试开关暴露公网；不新增永久产品导航。
- BrowserPort 封装观察、点击、填写、截图及清理；UI 浏览器与产品 Chrome 独立 session。锁定预览端口、origin、marker、lifetime与跨源iframe兼容性；本地可用不同回环端口，公网阶段验证HTTPS。
- 所需输入为受控模型profile、所选沙箱服务/模板、自托管Supabase与A/B身份；基础设施由代理准备，OpenSandbox服务与管理Key已在授权服务器生成；只记录配置是否可用，不输出 secret。缺项记 BLOCKED，不自动购买资源或借用个人 CLI 登录态。

## Acceptance criteria

- [ ] 干净安装可 typecheck/build，空模板本地与所选沙箱构建通过；记录准确工具签名和可复现命令。
- [ ] 真实模型至少执行远端读、写、精确编辑和一个命令；宿主项目没有被生成代码执行或写入。
- [ ] 沙箱内 Chrome 打开指定预览、填写并提交表单、观察结果、保存截图、关闭 session；不能只截首页。
- [ ] Pi abort 和真实长命令/子进程取消均验证结束确认；create 返回前取消后得到的沙箱被登记并销毁。
- [ ] Auth 身份验证和私有 Storage 上传/读回/哈希 roundtrip smoke 成立；无模型明文Key或平台私钥从API回显、进入日志或沙箱环境。

## E2E immediately after this module

| 用例 | 操作与前置 | 必须观察到 |
|---|---|---|
| G0-UI | 内置浏览器打开探针 → 输入需求 → 观察实际阶段 → 在跨源 iframe 添加一条合成记录。 | 页面行为、marker 与源码对应；无控制台错误；390px 容器可操作。 |
| G0-REAL / I02 / I10 子集 | 真实 Pi 与所选沙箱执行后，检查 Chrome 动作及取消长命令；失败资源按本轮 manifest 清理。 | 记录调用 ID、退出状态、截图及资源最终状态；缺 credentials 或图像能力即明确 BLOCKED/DOM-only，不能改用 fixture 宣布通过。 |

## Blocked by

None（可立即开始；真实服务前置缺失时显式标 BLOCKED）。

## Out of scope

不做完整用户项目、三角色协作或通用工具平台；无 Deep Agents/LangChain/LangGraph，无宿主执行生成应用。

## Module completion gate

- [ ] 本模块实现后立即执行本票 E2E 与受影响的已完成模块回归，再开始依赖本票的开发；不得把相关 E2E 延后到最后一票。
- [ ] 主用户流程由 Codex 内置浏览器实际操作。产品 Reviewer 的 agent-browser 报告、HTTP 200、截图或 build 成功都不能替代独立 UI E2E。
- [ ] DB 互斥、owner、事务、取消、版本绑定等 UI 无法严格证明的不变量，补真实 Postgres/HTTP/必要 OpenSandbox 集成断言；fixture 仅在隔离配置边界注入，注明哪些步骤没有接真实服务。
- [ ] 记录测试时间、环境 URL、commit/build（若含未提交代码加 diff 摘要）、API boot ID、模型/模板/CLI 版本、test owner/prefix、run/revision/hash、步骤/预期/实际、PASS/FAIL/BLOCKED/NOT_RUN、脱敏截图/日志和清理结果。
- [ ] S0/S1 修复后复测；任何本票必需检查 FAIL/BLOCKED/NOT_RUN 都保持 issue 打开。当前所有正式用例状态：NOT_RUN，已有 Mock 成绩不继承。

## Implementation notes

以仓库既有 PRD/TRD/E2E 的 F/E/I 编号定位完整契约；本票给出可独立完成的范围，不要求未来未开发功能提前通过。范围相关 UI 每次都增量检查桌面、390px、可访问名称、键盘和中文输入。不要为不相关文案变化反复调用模型。完成记录只保存必要调试证据，不要求用户逐版本阅读长报告。

## 接入与环境准备补充（2026-09-22）

- 模型通信直接复用pi-ai，Pi包版本保持一致。G0可使用维护者受控的临时模型输入进行探针；正式用户必须经过DEV-14页面配置，不把环境文件当产品流程，不读取个人CLI授权。
- Supabase优先在已授权服务器裁剪自托管，服务地址/密钥由开发代理生成；迁移、私有bucket、A/B身份、测试数据及清理均由代理准备。本地使用localhost或SSH隧道，无须先准备域名。
- 沙箱选定OpenSandbox Docker + gVisor systrap并已部署内部服务；服务端15426df5d146d6ce7499a16bd1ed871e7242fe27、SDK1.1.0、gVisor20260914.0。固定React fixture的文件/命令/真实安装构建、Chrome和跨origin iframe、长命令及子进程取消、创建中取消、两沙箱文件隔离、60秒TTL与清理均PASS。
- gVisor单沙箱1核/1GiB，cgroup峰值746.40MiB，旧站点193次探测无错误、swap为0；Supabase未参与，联合容量尚未通过。系统服务启动后的create/exec/kill也PASS，管理端点仅回环并要求Key，测试容器已清理。
- **本票保持打开**：真实Pi工具生成、正式WorkspacePort/BrowserPort适配、Auth/Storage及与Supabase联合容量未完成。fixture不计入正式E04或G0-REAL通过。仓库记录：docs/sandbox-g0-results.md；原始工件：artifacts/g0-sandbox-2026-09-22/。
- [ ] 配置准备可重跑；真实验证Pi工具、沙箱启停与子进程取消、Chrome交互、私有Storage roundtrip、新旧服务共存与峰值内存。只输出状态，不输出密钥。
