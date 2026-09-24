# RC-05 · 真实沙箱首键后取消

关联 [#21](https://github.com/hengworkinggit/pivloom/issues/21)。公开 Web/API `/version` 均为 `9255399a8685b0c69f2bb9b2b4a04177d123a83c`，探针使用该提交的产品 `RemoteBrowser`、`OpenSandboxWorkspace` 和真实 OpenSandbox `agent-browser 0.38.1`。没有调用模型、修改生产账号/项目/Run，或触碰另一条贪吃蛇验收沙箱。

**受控取消门槛 PASS。** 在浏览器 Session `result.json` 所列当前候选中，启动四步原生 batch：ArrowUp、ArrowRight、ArrowDown、ArrowLeft，每步后等待 1000ms。页面把每次键盘 down/up 写入沙箱本地事件日志，同时由沙箱页面服务转发到只监听宿主 Docker bridge `172.17.0.1:28055` 的临时 collector。脚本先验证沙箱到 collector、浏览器到 collector 都可达，再用宿主长轮询等到第一个 ArrowUp **keyup**，从而确认该键已完整按下并释放。

首键 `keydown` 为 `2026-09-24T02:02:42.157Z`、`keyup` 为 `.168Z`；宿主 collector 分别在 `.182Z`、`.183Z` 收到。`RemoteBrowser.close()` 于 `.337Z` 触发，距收到 keyup 154ms，处在第一步 1000ms 的等待窗口内。运行中的 batch 被拒，错误码 `BROWSER_CLOSED`；第一次关闭因命令曾在途为 `confirmed=false`，等待中断后第二次关闭 `confirmed=true`。再等待 1300ms 后，沙箱本地日志与宿主日志逐条一致：仅有 ArrowUp down/up，**ArrowRight、ArrowDown、ArrowLeft 均为 0 次**。完整观察、时间、事件和版本/Session 见[脱敏原始结果](rc05-key-cancel/result.json)。本地同一产品代码的[挂起进程回归](rc05-local-batch-cancel.md)还独立验证了 `interrupt → close` 顺序、不会重调度第二批和关闭后的操作被 `BROWSER_CLOSED` 拒绝；本轮 manager 日志也记录了目标沙箱命令的 `DELETE .../proxy/44772/command?id=...` 返回 200。

原始 JSON 的 `cancelPass=true` 是本次取消门槛结果；`modulePass=false` 仅表示 `cancelOnly` 模式没有在同一次沙箱中重跑已完成的七键正常用例，不能读作取消失败。

此前外部 `/proxy/4173/events` 的 HTTP 502 有两层测试环境因素。旧夹具仅监听容器 `127.0.0.1`，管理器代理无法经容器网卡连接；改为 `0.0.0.0` 后空闲代理 GET 实测 200，但长 batch 期间并发 GET 仍返回 502。最后一次探针改用宿主 bridge collector 做首键门控，并在 batch 结束后把其日志与沙箱本地日志交叉核对；不把一次 HTTP 成功、CLI 退出码或 HUD 文本当成键盘业务证据。

本轮唯一新沙箱 `destroy.confirmed=true`，全新 SDK `connect/getInfo` 独立返回 HTTP 404。collector 启动前仅绑定 Docker bridge，结束后按 PID 校验并停止，脚本/PID/日志文件已删除，`172.17.0.1:28055` 不再监听。[隔离探针](../../apps/api/tests/fixtures/canvas-negative/remote-key-cancel-probe.mts)和[collector](../../apps/api/tests/fixtures/canvas-negative/host-event-collector.py)均不含凭据。`9255399` 定向本地取消回归 1/1 通过，API typecheck/lint 通过。原生 `press` 的固定源码语义仍是一次 `keyDown` 后接 `keyUp`，本次没有声称验证持续持键。

本证据补齐了 #21 的远端受控取消缺口；[七键正常路径](rc05-e34-seven-key-cancel.md)、[真实 Provider 的 Canvas 正反例](rc05-real-reviewer.md)分别保留其执行来源和限制。未测试真实生成贪吃蛇的完整玩法，仍由 #27 验收；本任务不自行关闭 #21。
