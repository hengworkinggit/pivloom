# RC-03 · E30/E40 隔离故障复核（局部证据）

关联 [#19](https://github.com/hengworkinggit/pivloom/issues/19)。执行于 2026-09-24（Asia/Shanghai），工作树基线 `1a5a1be`，含本报告新增的单项测试；Web/API 由同一工作树在本机启动，页面部署 SHA 显示“未核实”。**E30/E40 仍为 PARTIAL，#19 不应据此关闭。**

## 实际边界

- 数据库是本机新建的独立 PostgreSQL `pivloom_executor_test_rc03`，应用迁移 001–017；测试 owner 和项目只存在于该库。运行时为 Node 24、Pi 0.86.1。未连接生产数据库、正式 A 账号、旧作品或远端 OpenSandbox。
- 执行器测试使用真实 PostgreSQL 事务、Pi 角色和资源状态机；Provider SSE 与沙箱 HTTP/进程由明确的隔离 fixture 提供。未将夹具的 `kill/isRunning` 当成官方 OpenSandbox 的真实销毁证明。
- 独立 Chromium（agent-browser）访问本机 Next 工作台 `http://127.0.0.1:55443` → 本机 Fastify API `:55442` → 同一独立 PostgreSQL。Auth 为本机协议 fixture。页面示例 Run 由测试环境预置为 `failed/RUN_TIMEOUT/cleanup_pending`，**不是**执行器测试中的同一 Run；浏览器只验证页面呈现、阻塞与恢复后的重试入口，不冒充完整故障从浏览器发起的 E30。

## 新增的短 deadline 测试

新增 `executor.integration.test.ts` 的 `a short run deadline survives a terminal write outage and keeps the project locked until cleanup confirms`。测试在接受请求后、派工前只改该隔离 Run 的 deadline 为约 2 秒；Builder fixture 持续等待直到 abort。同时注入第一次 `finishFailed` 事务失败、第一次沙箱销毁失败，后台结算与清理扫描间隔 50 ms。

[原始脱敏状态](rc03-e30-local.json)显示 Run `0b318a96` 的实际结果：`failed / cleanup / RUN_TIMEOUT / cleanup_pending`，项目锁仍指向该 Run，fixture 远端仍活着；终态事务共尝试 2 次，未新调模型。此时对同一项目接受新任务被 `PROJECT_BUSY` 拒绝。解除销毁故障后，近期扫描收敛为 `failed / confirmed / RUN_TIMEOUT`，远端 fixture 已关闭、项目锁为空，Provider 调用数保持 **2→2**。随后新的 retry Run `a7fc03ca` 被接受并关联原 Run、继承相同请求文字；测试立即取消该新 Run 清理夹具，不让它调用模型。

测试命令的定向结果：新增用例 **1/1 PASS**；既有取消终态 DB 故障和首次销毁失败用例 **2/2 PASS**；API typecheck、lint 均通过。测试自身使用精确 owner/project 前缀清理数据库记录。此处首次终态失败是 repository 边界夹具注入，而非真实 PostgreSQL 网络断线；事务与恢复写入确实经过独立 PostgreSQL。

## 独立浏览器所见

本机页面示例 Run `99196dcf` 在 `cleanup_pending` 时，明确显示“生成超过测试时限，已停止”“正在清理执行资源”，发送按钮不可用；点“以新任务重试”提示“当前项目仍有执行或清理操作”。[待清理页面](rc03-e30-ui-pending-local.png) · [阻塞提示](rc03-e30-ui-blocked-local.png)。

调用服务端 `confirmCleanup` 后重新打开项目，页面出现“资源清理已确认”“准备好你的下一个想法”，重试入口可点击。[确认后页面](rc03-e30-ui-confirmed-local.png)。点击重试确实创建了新 Run `746b78c9`，其 `retry_of=99196dcf`；该新 Run 随后因故意配置的本机模型 URL 被 `MODEL_ENDPOINT_NOT_ALLOWED` 拒绝。它不算真实 Provider 成功重试，也未创建远端沙箱。

## 尚未达到的关票条件

E30 尚缺从浏览器实际发起的同一短 deadline Run、真实 OpenSandbox `kill/get` 确认及沙箱到期/Provider 超时/shutdown 各原因区分。E40 尚缺真实 OpenSandbox 首次销毁故障与实际 PostgreSQL 短时断线在同一页面链路的 cancelled/failed 两终态复核。当前生产 A0 正占远端沙箱，本轮没有抢占或新建真实沙箱。旧 current 保留的断言在本例新项目中为空；已有 #19 旧版本保留证据仍需与最终统一构建复核。

本机工作台、API 和浏览器会话在取证后关闭；隔离 PostgreSQL 数据仅包含上述测试账号与夹具，最终停止本机数据库进程。生产环境未改动。
