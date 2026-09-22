# DEV-03 真实候选生成验收（2026-09-22）

对应 [#4](https://github.com/hengworkinggit/pivloom/issues/4)。基线 `dee0ae5` 加本票更改；当前状态：**候选生成子链路验收通过**，提交记录见 Issue。本票只交付 Builder 生成、可信构建、私有快照和可操作候选。Reviewer 尚未接入，因此两个真实结果都是 `CHECK_BLOCKED`，`currentRevisionId=null`，未把候选记为正式成功。

## 环境与真实调用

- 本机工作台 `http://localhost:45231`；API `127.0.0.1:45310`；独立预览来源 `http://localhost:45311`。
- API Boot `48ee2dd8-b9e6-4943-b687-6eef111a17d1`，宿主 Node 24.19.0，Pi 三包 0.86.1，OpenSandbox SDK 1.1.0。
- 远端 2 vCPU / 约 4 GiB RAM，OpenSandbox Docker + gVisor systrap；镜像 `pivloom-g0:20260922`，模板 `react-vite-node24-20260922`；Auth、Postgres、私有 Storage 均为已部署的真实 Supabase。
- 测试 owner 为独立 A 账号（`pivloom-dev-e6d33625ef2b` 环境）；模型为用户指定 Ark Coding Plan / `glm-5.3-flash`。两个有效 UI 配置引用同一实际端点/模型，但有不同 profile ID，均已完成真实连接/流式/工具验证。没有把它们称作两个不同模型。
- API Key 从页面配置、经服务端加密 lease 解析，只在服务端调用时使用；无模型 Key 环境变量。

| 真实需求 | Project / Run / Revision | 实测时间（北京时间） | 配置与结果 |
| --- | --- | --- | --- |
| 活动报名 | project `e8f58ae8-8665-4fb6-b07a-9cae763392ab`；run `1a4d0fac-b6cc-487c-b1f3-eeb663498d5d`；revision `7f3e0c34-23de-46eb-831a-e2995a859fe8` | 11:44:42.512–11:50:37.247，354.735 秒 | profile `ea2e0acf-4277-4670-8280-1e6635e7b363` v1，11 文件候选 |
| 读书清单 | project `9adc212f-3904-44c1-8360-65b227178e05`；run `bfc512e1-75fd-4902-82cc-85e777346f45`；revision `83976a4b-2dad-41ef-b931-38206b0394f3` | 11:51:34.552–11:57:10.104，335.552 秒 | profile `a0c5ba16-83fc-4451-95d3-a90e8e632015` v1，12 文件候选 |

每次实际调用从空 React 模板生成源码，未读取活动/读书成品。首个活动 run `0d849922-6e07-4f50-b271-a500f19013cd` 因第 3 轮模型调用超过 90 秒失败，错误和沙箱清理已保留。修复是通用 Builder 指令要求小文件/小工具参数、拆分写入，未放宽 90 秒限制，未预写业务实现；上述活动 run 是修复后的新接受请求。[首次失败记录](../artifacts/dev-03-2026-09-22/first-run-failure.json)。

## Codex 内置浏览器实际操作

以下从真实工作台和跨源 iframe 操作，未使用生成应用的自报检查结果。必要截图已在本任务浏览器工具结果中留存，未截取明文凭据。

| 用例 | 期望与实际 | 结果 |
| --- | --- | --- |
| 活动空字段、非法邮箱 | 初始 0 条；空提交显示姓名/邮箱必填；`not-an-email` 显示邮箱格式不正确，列表仍 0 条 | PASS |
| 活动新增与确认 | 添加林舟/设计、田禾/开发、宋宁/设计；默认待确认；确认田禾后只有该条变已确认 | PASS |
| 活动搜索 | 搜索“林”仅剩林舟；清空后恢复 3 条 | PASS |
| 活动持久与独立窗口 | 刷新预览仍 3 条且田禾已确认；由 UI 打开新标签后同一 revision、同样业务数据 | PASS |
| 读书不同需求 | 初始空书单，不含报名/邮箱/活动类别；空书名报错；添加《海边的地图》/作者甲和《晨间笔记》/作者乙 | PASS |
| 读书状态与筛选 | 标记《海边的地图》已读；总数 2、已读 1；已读仅海边，未读仅晨间，全部恢复两条 | PASS |
| 读书持久与独立窗口 | 刷新预览和新开工作台仍总数 2/已读 1；UI 新标签保持 revision `83976a4b…` 及两书状态 | PASS |
| 工作台执行与输入 | 实际 phase/tool 记录及固定模型 v1；活动 run 执行中重载仍跟踪原 run；忙时 Enter 不发第二次请求、下一轮草稿保留 | PASS |
| 全局忙与配置选择 | 活动生成时提交读书需求返回 SERVICE_BUSY，草稿保留；活动终态后重发被接受；读书使用第二个 profile v1 | PASS |
| 源码视图 | 活动显示 11 文件、读书 12 文件；可读 `src/App.tsx`、组件和存储模块；只读展示来自保存快照 | PASS |
| 桌面/窄屏/键盘 | 桌面 1280 无横向溢出；活动窄屏按钮展示独立窄布局；实际工作台 390px 时 scrollWidth=390，模型可选、中文草稿及 Shift+Enter 保留、对话/结果可切换、左右方向键切预览/代码 | PASS |
| 到期 | 活动到期后取消 iframe/刷新入口，显示“预览已到期，源码快照已保存”；已保存源码仍可读取；读书到期也显示相同状态 | PASS |

读书预览最初在开发热更新期间停留加载状态，手动刷新后可操作；随后新开工作台自动加载同一预览、刷新业务数据持久通过。未把第一次加载等待记录抹去，也未据此声称网络故障恢复模块已完成。

## 快照、绑定和容量

对每个真实 Revision，从鉴权 HTTP 接口逐文件读回，独立计算文件 SHA-256 和规范 bundle hash；与 manifest、Revision 及持久化 sandbox 绑定一致，两个 current 均为空。[结构化读回证据](../artifacts/dev-03-2026-09-22/real-generation-readback.json)。

- 活动 sourceHash：`b9f07751df3d7f737d57a6f14be1450b30d11d260bb5ec9b6b1f4a1fa9f7d388`。
- 读书 sourceHash：`4e5c9813d3cc09a1b33e8040f9d852dd9ca2f897357f4b22cb837f76b6194512`。

11:31:40–12:04:10 持续采样 1894 次；其中 473 个样本有两个沙箱（一个已保存静态候选预览 + 一个 Builder）。最低主机可用内存 1390 MiB，swap 最大 0；旧站点 379 次探测、0 失败，最大响应 35.4ms。观察进程已正常停止。[容量摘要](../artifacts/dev-03-2026-09-22/capacity-summary.json)。

这支持当前单生成槽、最多两沙箱的开发链路；**未证明并行 Chrome Reviewer、多人负载或把完整 Pivloom 前后端部署同机后的容量**。

## Standards 审查

固定基线 `dee0ae5` 的工作区差异；初审 1 P1、2 P2。

- P1：POST 接受事务期间断连可能没有 `finish`，导致永不派工。改为响应 finish/close 与已断连兜底，exactly-once 启动；真实 HTTP/Auth/Postgres 行锁复现断连后执行一次、幂等重放不再执行、新 key 可接受，PASS。OpenSandbox 在此回归为外部 HTTP 故障 fixture，未调用模型。
- P2：本地 acceptedRequestId 未清理，另一标签提交后旧标签永久等待。修复并通过 DOM 用户流程回归。
- P2：较早项目快照与较新 Run 终态拼接，可能停止刷新却不显示候选。终态新观察补取一致项目快照；修复并通过完成时序交错的 DOM 回归。
- 复核另发现首次确认 R1 迟到、项目已到 R2 时仍会等待 R1；已改为 owned Run 详情确认接收，页面继续展示权威 R2，公开组件回归先红后绿。最终 Standards 复核无剩余 P1/P2。
- P3：可信命令记录缺少 `durationMs`。已用真实命令调用前后的单调时钟记录，抛错也在 finally 留存；既有运行时回归覆盖，已修复。

## Spec 审查

同一范围独立初审 1 P1、2 P2。

- P1：同上述接受后断连，已修复并通过真实回归。
- P2：可信构建结果只存通过/失败，没有实际命令、退出码和日志尾部。已记录具体命令、真实 exit、脱敏的各 2KiB UTF-8 日志尾部和耗时；类型失败、构建失败、预览失败分别保留真实构建事实，公共 DTO 不暴露私有诊断。已通过 runtime 外部边界 fixture 回归。
- P2：10 分钟父 deadline 被错误记成取消。已正确映射 RUN_TIMEOUT，保留实际清理状态；用明确父 deadline signal 注入回归通过，未冒称为等待了十分钟的真模型测试。

最终独立 Spec 复核无剩余 P1/P2或越界项。固定 gate 正常路径是真远端；非零退出和部分异常传播的 fixture 与真实远端证据分开记录。

## E27 与运行中模型变更

两个故障项目与正常 A/B 项目分开。独立维护 API 使用生产 createApp、Pi、真实 OpenSandbox/Auth/Postgres/Storage，只在精确测试项目注入故障；正常 API 没有故障开关。

| 用例 | 真实执行与注入边界 | 实际结果 |
| --- | --- | --- |
| 上传失败 | run `fb744735-97f7-4553-a964-8a96dad47044`，12:13:30–12:18:07；真实模型、写代码、可信构建和 marker 后，只在该项目 SourceObjectStore.upload 抛错 | UI 显示“源码快照保存失败，请稍后重试。”、SNAPSHOT_SAVE_FAILED；Builder succeeded、Run failed；0 Revision、current=null；沙箱 destroyed、cleanup confirmed。PASS |
| 对象已保存，DB 引用失败 | run `86cea5df-f7d6-4405-9810-a59f33a9e04b`，12:20:05–12:24:58；真实生成/构建，私有 Storage 上传及读回的压缩 SHA 一致；仅匹配 owner+project 的临时 Postgres trigger 拒绝 Revision INSERT | UI 显示“生成或保存未完成，请稍后重试。”、GENERATION_FAILED；0 Revision、current=null，操作锁释放；可识别的 1 个孤儿对象未变成版本；沙箱 destroyed、cleanup confirmed。PASS |
| 运行中配置冻结 | 第一故障 run 接受 B profile v1 后，UI 改为 v2/模型 `pivloom-e2e-must-not-be-used`，设默认→切回原 A 默认→删除临时 B profile；两次重载运行中工作台 | Run 始终固定原 glm-5.3-flash/v1，并在变更后完成真实代码生成和可信构建才到达预设上传故障。删除时 v1 加密凭据保留 1 条/lease 未释放；终态后该密文为 0、lease 已释放。PASS |

这些是带明确故障边界的真实执行测试，不计作新增生成质量样本。两个模型配置的正常生成质量证据仍是前述活动与读书需求。

证据：[中途及终态事实](../artifacts/dev-03-2026-09-22/fault-state-observations.json)、[真实 Storage 日志](../artifacts/dev-03-2026-09-22/fault-storage-journal.jsonl)、[精确清理结果](../artifacts/dev-03-2026-09-22/fault-cleanup.json)。已停止故障 API，删除 2 个专用测试项目及其 Run/lease、1 个孤儿对象和唯一触发器/函数；清理核对所有这些残留数为 0，两沙箱确认不存在。原活动/读书项目、源码、默认模型和其他用户资源保留。

正常 API 已恢复，Boot `c626092f-99a7-4e7d-b77c-def365ec5276`，ready 通过。工作台重新加载后可读历史、候选与持久化源码。开发热更新曾因 hook 依赖数组长度变化留下 React 开发告警；重新加载最终代码后操作正常，未把热更新状态当作生产构建结果。

## 最终检查

Node 24.19.0 下，全仓默认测试 API **71 PASS / 13 opt-in SKIP**、Web **35 PASS**；全仓 typecheck、lint 和生产 build 全通过。独立启用的本票真实集成为 **5 个持久化 + 3 个鉴权 HTTP + 1 个事务期间断连**，均通过且精确清理。HTTP 边界此前一次调用显示的 9/9 包含 6 个匿名无出站测试，不能把这 6 个再算成真实 Postgres 集成。[结构化检查记录](../artifacts/dev-03-2026-09-22/checks.json)。

基础模块此前的 4 个真实集成结果仍见基础报告，本段未冒称重新执行；本票通过真实 A/B 鉴权隔离、项目读写、模型设置/冻结/删除和源码访问补做受影响边界回归。

## I11 可信构建不受项目脚本支配

12:31–12:36 使用生产 Workspace 和 buildAndPreview，在两个独立的真实远端 gVisor 沙箱执行，每个限制 1 CPU / 1 GiB / 180 秒 TTL，无模型调用或模拟命令。[完整命令、退出码与清理记录](../artifacts/dev-03-2026-09-22/trusted-build-tamper.json)。

- 假成功：将 package.json 的 typecheck/build 改为输出 PASS、退出 0，另写入明确 TypeScript 类型错误。实际 npm 脚本均返回 0，但固定 tsc 检出 TS2322、退出 2，返回 TYPECHECK_FAILED，未执行 Vite。PASS。
- 假失败：另一干净沙箱使用合法源码，将 npm build 改为退出 1。实际 npm 脚本返回 1，但固定 tsc/Vite 均返回 0，实际预览 marker 的 Revision 与 sourceHash 一致。PASS。
- 两个测试沙箱均立即销毁，并独立查询确认 404；最终管理 API 和 Docker 沙箱残留数均为 0。探针最初误写 runtime 注册名导致的预检失败单独保留，该次未执行 gate，沙箱也确认清理，修正仅涉及探针断言。

## 后续边界

真 Coordinator、Reviewer、有限修复、连续版本迭代、取消/重启/恢复及公网部署属后续票，未在本报告标为通过。当前候选的 15 分钟预览已到期且沙箱已回收，保存的源码仍可读取；本票没有恢复到期预览功能。
