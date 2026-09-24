# RC-05 · 挂起 batch 的本地适配器取消复核

关联 [#21](https://github.com/hengworkinggit/pivloom/issues/21)。本次只运行现有 `browser.test.ts` 中的真实 `RemoteBrowser` + `OpenSandboxWorkspace` 接口，`SandboxConnection` 和 `RemoteProcess` 为可控夹具；未创建远端沙箱、没有 Chrome 或模型调用、没有数据库/Storage 写入。基线 `85c1a7a`；产品源码修改只在独立分支。

**发现并修复的边界：**当原生 key batch 的 `RemoteProcess.wait()` 挂起时，旧版 `RemoteBrowser.close()` 只发送另一条 CLI `close`，没有中断正在运行的 batch。新增回归测试先为红：批次已开始，调用 `close()` 后观测到的首个动作是 `close`，缺少 `interrupt`。现在 `RemoteBrowser` 的关闭信号传给 `OpenSandboxWorkspace.executeService()`；进程建立后若被取消，先调用原生 `RemoteProcess.interrupt()`，使挂起的 `wait()` 及时结束，再发浏览器 `close`。

修复后同一测试为绿：观察到 `interrupt → close` 顺序；正在运行的 batch 以 `BROWSER_CLOSED` 结束，不会被重新调度为第二个 batch；首次关闭因命令曾在途而保持 `confirmed=false`，在途操作结束后重试关闭得到 `confirmed=true`；新的 batch、普通观察都被 `BROWSER_CLOSED` 拒绝。浏览器、Workspace 和 Reviewer 定向测试合计 **114/114 通过**，API typecheck、lint、`git diff --check` 均通过。

固定的 [agent-browser 0.38.1 源码](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/native/interaction.rs#L322-L385)中，`press_key` 调用 `press_key_with_modifiers`，后者先发 CDP `keyDown`、再发 `keyUp`。因此已有七键实测只能证明一次次原生 `press`，**不能称为持续持键验证**。

本地进程接口夹具证明适配器在挂起/取消竞争中会请求 interrupt 并阻止服务层继续调度；它不能证明远端 agent-browser 在真实 OpenSandbox 中已收到首键、取消后剩余键都没有到达页面。该远端事件门控在[前次 E34 报告](rc05-e34-seven-key-cancel.md)中为 NOT_RUN，生产也尚未部署本分支修复。故 #21 仍保持 **OPEN**，不能以本地夹具代替已部署真实取消验收；完整生成贪吃蛇仍由 #27 负责。
