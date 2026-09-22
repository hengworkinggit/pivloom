# 基础设施联合验收 — 2026-09-22

结论：基础方案已达到继续正式开发的门槛。已验证的组合是 **Pi 0.86.1 + OpenSandbox 1.1.0 SDK / Docker / gVisor + 自托管 Supabase Auth / PostgreSQL / 私有 Storage**。以下保留基础模块当时的边界；12:08 的正式工作台生成补充见文末。本记录不表示完整产品交付。

## 真实验收

| 项目 | 结果与证据 |
| --- | --- |
| 真模型生成 | 用户指定 Ark `glm-5.3-flash` 经 Pi 实际执行远程 read/write/edit/bash，固定 TypeScript/Vite build、源码 marker 验证通过。第二次从维护页面输入需求重新生成，耗时 236.002 秒。见 [运行时记录](g0-runtime-real-results.md)。 |
| 沙箱内 Chrome | 真实 fill → click → DOM 新记录 → 截图 → 关闭会话均通过。[截图](../artifacts/foundation-2026-09-22/generated-app-chrome.png)。 |
| Codex 独立浏览器 | 从另一个来源的 iframe 添加“独立浏览器验收通过”，刷新整个页面后记录仍显示。不是复用沙箱浏览器的自报结果。 |
| Auth / 项目 | A 在浏览器创建两个不同项目，刷新/退出重登后逐一重开；B 列表为空且不能读取 A 项目；真实 API 停机时提交失败保留中文输入，恢复后成功创建。B 服务端撤销会话后刷新回登录。见 [前端补测](../artifacts/foundation-2026-09-22/frontend-module-notes.md)。 |
| 模型设置 | 页面完成错误 Key → 更正 → 实际流式/工具测试 → 保存 → 刷新/重登 → 编辑/更新密钥 → 切换默认 → 删除/刷新，均通过。Key 存入服务端加密记录；删除与在途版本引用的真实数据库契约见 [后端补测](foundation-model-followup-2026-09-22.md)。 |
| 私有 Storage | 服务端实际上传/读取一致；匿名以及 A/B 用户直接读取私有对象被拒绝。 |
| 可重复准备 | migrate 和 seed 重跑通过；测试资源按 manifest 精确清理，保留 A/B 账号及浏览器单独创建的验收项目、模型配置。 |
| 真实取消 | 已收到实际模型流式内容后触发取消，HTTP 流关闭、Pi abort settle、后续无新增字节且沙箱确认销毁；真实长命令/子进程取消、创建返回前取消后的资源销毁均 PASS。见 [取消记录](../artifacts/foundation-2026-09-22/g0-abort.json)。 |

## 联合负载与适用范围

服务器为 2 vCPU / 约 4 GiB RAM。Supabase 四个服务与一个真实生成沙箱同时运行，观测时间 09:45:01–09:59:54（Asia/Shanghai），约 15 分钟、869 个样本。

- 主机最低可用内存 1392 MiB（约 1.36 GiB），Swap 最大使用量 0。
- 沙箱 cgroup 内存峰值 678.58 MiB（包含缓存，不等于进程 RSS）。
- Storage / DB / REST / Auth 峰值分别为 275.90 / 103.72 / 51.11 / 19.11 MiB；各峰值不能直接当作同一时刻总和。
- 原网站 174 次探测，失败 0 次。
- [结构化资源摘要](../artifacts/foundation-2026-09-22/capacity-summary.json)。

这证明当前单任务开发与演示可行。**没有证明 Supabase 下多沙箱并发、多人生产容量，或者将 Pivloom 前后端也部署上去之后的容量**。此前两个沙箱隔离/取消/TTL 等 fixture 结果单独见 [沙箱验证](sandbox-g0-results.md)，不与本次联合负载混为一谈。

## 修复过的真实阻塞

- GoTrue 默认 CORS 预检拒绝 Supabase SDK 的 `apikey`；Compose 加入 `GOTRUE_CORS_ALLOWED_HEADERS=apikey,x-supabase-api-version`，真实 OPTIONS 与浏览器登录复测通过。[上游配置讨论](https://github.com/supabase/auth/issues/1589)。
- 最小 Supabase 初始化移除了不存在的 functions 角色引用，恢复本次被中断的官方数据库迁移；Auth 初始化和真实登录通过。新安装使用修正后的 SQL。
- Storage 健康检查的 localhost 解析为 IPv6，但服务监听 IPv4；改用 127.0.0.1 后 healthy。实际对象读写此前已经通过。
- API 空请求不再误带 JSON Content-Type；模型缺加密主密钥有明确 503；Auth 临时网络/限流不会误清有效会话。
- 弃用旧 E2B probe stub，明确 410；移除 E2B 依赖及模型 Key 环境变量示例。

两条复查线提出的适用问题已修复并补测：Standards 侧修复刷新草稿丢失、认证限流误判和快照缺 schema/template 版本；Spec 侧补齐维护页面实际操作、实际模型流取消、完整模型设置 UI 与删除后的凭据回收。复查范围为基础模块，不将未来 Run、Reviewer 或发布模块当作已完成。

## 尚未完成，不伪装为通过

- 正式工作台尚未串联真实生成运行时；当前页面可以真实登录、配置模型、创建项目。
- 模型图像理解/视觉评价未测；本轮浏览器验收使用 DOM 和实际行为。
- 当前配置已验证 Ark；Anthropic 查询兼容经过边界测试，没有真实 Anthropic Key 调用。
- Run 生命周期、流式进度、重启恢复、版本迭代与发布属于恢复目标后的实现范围。
- 模型版本的 freeze/resolve/release 引用与密文回收已通过真实数据库测试；完整 Run 的接受/结束事务将在 #4 接入，尚未宣称运行中修改模型的完整产品流程通过。
- Supabase 和沙箱控制服务仅监听远程回环，通过 SSH 隧道供本地开发；公网正式体验与 HTTPS 部署尚未交付。

## 验证版本与维护

基线 `5d1ae44c35e7d2c6b52a18178bb68354fbcfff97` 加本轮工作区修改，包含新 API/contracts、前端真实 adapter 与基础设施配置。验证过程中修复后再次运行相应边界测试；默认测试中的 4 个真实集成用例默认跳过，但已独立启用真实环境执行并全部通过，不能把默认 skipped 计为 PASS。

模型与账户凭据仅保存在忽略的本地配置、测试 manifest 或服务端密文中，本报告不含凭据。开发 API、前端、SSH 隧道保留用于后续开发；独立浏览器验收后已显式销毁一次性生成沙箱，控制端确认 `CLEANUP {"confirmed":true}`。原站点和 Supabase 数据卷保留。

最终检查：全仓 typecheck、lint 和 `git diff --check` 通过；API 36 项单元/边界测试、Web 24 项通过。另行启用的 4 项真实 HTTP/Auth/Postgres 测试全部通过（128.78 秒）。另复制不含 node_modules、构建产物和私有环境文件的源码到独立临时目录，Node 24.19.0 / npm 11.17.0 下 `npm ci --no-audit --no-fund`、全仓 typecheck / production build 全通过。Supabase 四个容器均 healthy，原站点跟随跳转后 HTTP 200。

仓库自带的可信空 React 模板另外导出到临时目录，安装其固定版本依赖后 TypeScript / Vite 8.3.0 构建通过（23 包，Vite 构建 315ms）；本地没有执行模型生成的应用。模型生成、构建和 Chrome 操作均在远程隔离沙箱。

## 维护页面独立复测

2026-09-22 10:29:20–10:33:16（Asia/Shanghai），Codex 内置浏览器在仅本机维护页面输入“今日想法”小应用需求并启动真实调用。Pi 成功执行远程 read、write、edit、bash 各一次，沙箱内 Chrome 完成 fill / click / 独立 DOM / 截图 / 关闭。随后内置浏览器在跨源 iframe 添加独有中文记录，刷新外层页面后记录仍在；390px 外层视口下再添加第二条记录成功，整页 scrollWidth 为 390，没有横向溢出。维护页面及 iframe 的控制台 error/warn 为空。点击“清理沙箱”后控制端确认 `confirmed`。

- 维护 Boot ID：`ed7973b0-3ff3-4b18-aa3d-aca0ca056fed`。
- Run ID：`d2078358-6207-4df9-8100-2619d1f7f186`；Revision ID：`6a2f9ffa-960e-4c99-a23b-236c9ccdc5b3`。
- 源码 hash：`e53d9b9cd4f38a6e4024b90003f50e6fe24e9fba22f5a189e1b1dd4a166259ac`，含 schemaVersion=1 和模板版本 `react-vite-node24-20260922`。
- 该次维护进程实际宿主 Node 22.15.1；沙箱内 Node 24.13.0、Chromium 153.0.8010.52、agent-browser 0.38.1。干净安装构建使用 Node 24.19.0；没有将不同宿主版本混为一次实测。
- 旧镜像 digest 与导出的依赖锁定文件保存在 `infra/sandbox/`。仓库 Dockerfile 使用相同顶级版本和导出 lock，但完整镜像尚未从该新 Dockerfile 重建；不能把导出构建上下文称为重建已通过。

## 模型取消补测

Run `c1468bc0-9827-4714-89d9-ff678bb2a605`（宿主 Node 24.19.0）在 10:45:09.888 收到实际模型 delta 后，由父控制程序立即发出 abort；HTTP 流在 .890 关闭，Pi 会话在 .891 确认停止，状态 `CANCELLED`，没有后续字节。随后控制面确认该沙箱已销毁。独立长命令创建了真实子进程，取消以整个沙箱移除并核对不存在收尾；另一次真实创建中取消，迟到返回的沙箱仍登记并销毁。

第一次取消尝试因模型先自然结束而记为 `COMPLETED_WITHOUT_ABORT / FAIL`，未充当取消通过证据；其首次清理确认 pending，随后按确切 ID 重查并确认销毁。第二次改为真实输出触发取消，未改变模型参数或抹去失败记录。上述毫秒数为客户端观察时序，不代表供应商后台停止计算或计费的保证。

## 11:15 基础可用性复核

2026-09-22 11:15（Asia/Shanghai）应用户要求收口基础验证。已提交的基础版本为 `dee0ae5`；本次只复核已有实测证据和当前服务，不将工作区中 #4 的生成模块草稿计为已验收。

- API `/api/v1/health/ready` 返回 `ready`，boot ID 为 `5700dba2-51f5-4239-a084-a94bc3534a95`；本地前端 `/login` 返回 HTTP 200。
- 远端 Supabase DB / Auth / REST / Storage 四个容器均 healthy；OpenSandbox systemd 服务 active。
- 主机当前 available 为 1766 MiB、Swap 使用 0；这是空闲时点读数，容量结论仍以前述真实联合负载记录为准。
- 原站点跟随跳转后 HTTP 200，当前没有遗留 sandbox 容器。
- 基础设施达到恢复正式开发的门槛。正式工作台生成、Reviewer、版本和公网发布仍属于后续开发与验收范围。

## 12:08 正式工作台链路补充

恢复开发后，#4 工作区实现已经从正式工作台使用两个 UI 模型配置，分别真实生成活动报名与读书清单候选；在 Codex 内置浏览器操作校验、添加、确认/已读、搜索/筛选、刷新持久、独立窗口、源码与 390px 界面均通过。全部 23 个文件通过鉴权接口读回，文件和 bundle hash 与生成 Revision/sandbox 绑定一致。详细步骤和未完成项见 [DEV-03 记录](generation-validation-2026-09-22.md)。

补充联合监测 32 分钟、1894 个样本，其中 473 个样本同时有已保存预览与另一个生成沙箱：主机最低可用内存 1390 MiB，swap 最大 0；原网站 379 次检查全部通过。监测已停止，两个沙箱均按 TTL 回收，Supabase 四个服务仍 healthy。[容量记录](../artifacts/dev-03-2026-09-22/capacity-summary.json)。

基础选型无须继续等待候选验证。12:08 时 #4 尚在完成故障路径验收；两个生成结果按规范标“尚未检查”，未晋升 current。真实 Reviewer、版本迭代和公网完整产品容量仍由后续模块验证。

12:36 补测完成：上传失败、对象保存后数据库引用失败、执行中模型配置修改/删除和构建脚本篡改均符合规格，测试资源已精确清理。#4 候选生成子链路验收通过，完整记录见上述 DEV-03 报告。基础设施已达到继续开发门槛，无须购买 E2B 或补交云端 Supabase 配置。

## 13:58 当前服务复核

2026-09-22 13:58（Asia/Shanghai），针对用户“先验清基础再恢复目标”的要求，仅复核当前健康状态及既有真实证据，不将此轮健康检查当作重新执行模型或浏览器验收。

- 已提交 HEAD 为 `1d9312a`；#6 工作区仍在开发，未计为模块验收通过。
- 现有 API 返回 `ready`，boot ID `fc6374c1-03b5-4587-beb4-29ee4c51a8d2`；前端 `/login` 返回 200。
- 远端 OpenSandbox 服务 active，Supabase 四个容器均 healthy；运行容器列表无沙箱。
- 主机当时 available 1749 MiB、Swap 使用 0；原站点返回 HTTP 200。
- 既有真实生成、Chrome、内置浏览器、私有 Storage、取消清理及联合容量证据仍足以支持继续开发。此处不声称完整产品、公网部署或多人生产容量已经验收。

## 14:55 基础验证收口

当前 API 返回 ready（boot `d11551c2-a634-4df6-ae09-ca18fc804e33`），前端 `/login` 返回 200。远端 OpenSandbox active，Supabase 四个容器 healthy，原站点 HTTP 200。主机 available 1746 MiB、swap 使用 0，无遗留沙箱容器；这是健康复核，不代替前述真实联合负载测试。

基础设施已经达到恢复开发门槛，无需再等待 E2B 选型或购买。新增 #6 的真实澄清回答链路本次触发 RUN_TIMEOUT，沙箱已确认销毁，未产生候选版本；这是仍需修复验收的产品链路问题，详细记录见 [DEV-05](planning-validation-2026-09-22.md)，不宣称完整产品已可用。

## 前次基础收口：可继续开发

在远端 API 与数据库、沙箱服务共置后，真实奖金计算需求完成澄清 → 独立 Builder → 构建 → 候选预览，耗时 165.442 秒。Codex 内置浏览器实测计算、整千边界、清空和刷新保存通过；详细 Run、源码 hash 与步骤见 DEV-05 报告。该候选仍为“尚未检查”，不代表 Reviewer 或完整产品交付。

最新 30 分钟联合监测包括远端 API、Supabase、生成沙箱与保留预览：1750 个样本、最低可用内存 1347.1 MiB、swap 为 0，原站点 350 次检查无失败。[容量摘要](../artifacts/dev-05-2026-09-22/capacity-summary.json)。前端仍在本地，此结果不是完整公网部署的容量验收。

本次收口复核：API ready（boot `03eff461-d35c-446e-a641-24d22c4e0139`）、本地前端 200；`pivloom-api.service` 和 `pivloom-sandbox-g0.service` active；Supabase 四个容器 healthy；原站点公网 200。容器列表无遗留沙箱，奖金候选的 TTL 销毁已由数据库读回确认。

基础选型通过，用户无需购买 E2B、另建云端 Supabase 或提供新域名即可继续开发。#6 的另一条报名生成仍有模型流中断，保持未验收；它是接下来需要修复的产品可靠性问题，不被此次基础收口掩盖。

## 16:57 最新复核：基础验收完成

2026-09-22 16:57（Asia/Shanghai），应用户要求确认恢复开发前的基础门槛。当前提交 `964abd5` 已完成 #6；前述报名失败历史保留，后续相同需求 R12 已在 249.551 秒生成候选，并经 Codex 内置浏览器实际操作表单校验、模拟支付、名单新增、刷新保存和手机键盘提交，详见 DEV-05 最终验收。奖金计算链路为 165.442 秒。两次都是实际模型与远程构建，不是 Mock。

本次即时复核：正确端点 `/api/v1/health/ready` 返回 ready，boot `ee5dfec1-3521-4f5d-9b66-b56501c505e0`；本地 `/projects` 返回 200，原站点公网返回 200。API 与 OpenSandbox systemd 服务均 active，Supabase 四个容器均 healthy，容器列表无遗留沙箱；主机 available 1609 MiB，swap 使用 0。首次误查 `/health/ready` 返回 404，随后按实际 API 路径确认成功，不归因为服务故障。

此轮复核没有重复调用模型或重新执行浏览器行为测试；真实链路结论引用已保存的验收记录，健康状态为本次实测。基础方案已可继续开发，无需用户购买 E2B 或提供云端 Supabase 配置。产品 Reviewer、自动验收晋升、完整版本迭代及公网发布仍未完成；R12 的“将发送确认邮件”不实文案已记录交 #7，不把候选称为完整应用通过。本轮不启动后续模块。
