# G0 维护入口与复现

范围是 DEV-01 / GitHub #2：维护页输入需求，真实 Pi 远程生成，固定构建、独立 Chrome 检查、跨来源 iframe 操作及明确取消/清理。它不注册永久产品导航，也不实现正式 Run、项目版本或发布模块。

## 前置与启动

使用 Node 24 和已安装的仓库 workspace。`apps/api/.env.local` 只需包含当前 OpenSandbox 管理连接配置：`OPENSANDBOX_BASE_URL`、`OPENSANDBOX_API_KEY`、`OPENSANDBOX_IMAGE`。这个文件被 Git 忽略，不把模型 Key 放入其中。新沙箱环境的构建入口见 [infra/sandbox](../infra/sandbox/README.md)。

从仓库根目录运行：

```sh
npm ci
npm run g0:serve --workspace @pivloom/api
```

等价的直接启动命令为：

```sh
cd apps/api
node --env-file-if-exists=.env.local --import tsx scripts/g0/serve.ts
```

默认维护页 `http://localhost:45312/`，独立预览 origin `http://localhost:45311`；两个服务只监听 127.0.0.1。必要时通过 `G0_PORT`、`G0_PREVIEW_PORT` 修改端口。启动会输出 boot ID、非敏感连接状态与证据目录。

页面默认填入公开 Ark endpoint / 模型 ID，**Key 始终为空**。输入需求和本次 Key 后点击“开始真实验证”；Key 在提交时从输入框清空，服务端只在本次执行的内存中持有它，不回显、不存入日志、浏览器存储或证据文件。

观察阶段列表中的真实模型流、远程 read/write/edit/bash、构建与 Chrome 行为。成功后在 iframe 自己添加记录；可切换 390px，使用键盘操作，再刷新整页验证应用持久化。点击“清理沙箱”，只有控制面确认资源消失才显示 confirmed；cleanup pending 时保留重试入口，并禁止创建下一候选。

“取消任务”会发送 AbortSignal 给 Pi，并销毁本次沙箱。页面先显示正在取消，收到结束结果后显示清理状态。服务收到 SIGINT/SIGTERM 时也按自己登记的 run 清理，失败仍受沙箱 TTL 限制；不会批量删除未知沙箱。

## 边界与证据

- Host allowlist、同源 Origin 检查、随机 CSRF token 同时生效；没有公开生成接口或原始 shell HTTP 入口。模型 transport 复用 BYOK 的 HTTPS/DNS 校验与连接固定实现。
- 预览独立 origin，随机能力链接换取 HttpOnly/SameSite cookie；代理只向登记的 sandbox `/proxy/4173` 转发 GET/HEAD。管理 Key 与 upstream headers 从不返回浏览器。iframe 禁止顶层导航，响应带受控 CSP。
- 脚本把脱敏 JSON 和 Chrome PNG 保存到 `.cache/g0-maintenance/`（或 `G0_ARTIFACT_DIR`）。包含 boot/run/revision、工具调用、版本、hash、检查结果和清理状态。JSON 不包含截图 base64 或模型输入 Key。
- 旧 `/probe` 路径明确返回 410；当前维护入口为根页面 `/` 与受控 `/runs` 路由，避免旧 E2B stub 被误认成真实运行入口。

## 真实流取消验证

```sh
npm run g0:abort --workspace @pivloom/api
```

脚本等待 stdin 输入一行临时模型 JSON，字段为 `provider`、`api`、`baseUrl`、`id`、`apiKey`、可选 `maxTokens`。使用不回显的管道或关闭回显的维护终端输入，不能把 Key 写到命令行参数、仓库或 shell 历史。默认不读取个人 CLI 登录状态。

收到 `G0_STREAM_STARTED` **之后**，向同一 stdin 写入一行 `abort`。控制器也可在看到这个真实 delta 事件后立即写入 `abort\n`。脚本核实客户端 HTTP AbortSignal、流关闭、Pi abort 完成、完成后没有新字节及真实沙箱销毁，随后顺序验证真实长命令/子进程取消与真实 late-create 清理。模型自然结束、提前取消或仅收到 HTTP 头都不计为通过。

该结论证明客户端模型流与 Pi 会话停止，不声称能观察云模型供应商内部计算何时停止。报告位于 `.cache/g0-maintenance/abort-<runId>.json`。缺少真实模型凭据时此项保持未测，不用 fixture 替代。

## 2026-09-22 实测补充

维护页面实测 run `d2078358-6207-4df9-8100-2619d1f7f186`，boot `ed7973b0-3ff3-4b18-aa3d-aca0ca056fed`，maintenance ID `10f75c2b-7740-4543-9255-ab5eee0492e5`，耗时 236.002 秒。四类工具、固定构建、marker、沙箱 Chrome 全部 PASS。主代理另行在 Codex 内置浏览器完成页面输入需求、阶段观察、iframe 添加记录、刷新恢复及 390px 操作，并从页面清理到 confirmed。

本轮 sourceHash 为 `e53d9b9cd4f38a6e4024b90003f50e6fe24e9fba22f5a189e1b1dd4a166259ac`，协议为 schema 1、模板 `react-vite-node24-20260922`。固定 JSON 顺序为 `{schemaVersion, templateVersion, files}`；files 按路径排序，包含 `{path, encoding:'utf8', content, sha256}`，每个 SHA 来自实际字节。时间与随机 ID 不进入哈希。更早的 [运行时初测](g0-runtime-real-results.md) 使用 G0 v0 的 path/sha 拼接规则，其旧 hash 不与新协议混用。

取消实测 run `c1468bc0-9827-4714-89d9-ff678bb2a605`：10:45:09.888（Asia/Shanghai）收到真实 delta，外部控制器同毫秒发取消；HTTP 流在 09.890 关闭，Pi abort 在 09.891 完成。模型流停止、长命令/子进程取消、late-create 清理三项均 PASS，相关沙箱均 confirmed；临时默认模型凭据 lease 已释放。前一轮 `419513ca-d2a3-4a23-a9a2-cc47647af9d0` 因取消发出前模型已自然结束，如实保留 FAIL，其资源后续已确认清理。

准确区分版本：本轮维护页宿主 Node 为 **22.15.1**，真实取消及干净安装/build 使用宿主 **24.19.0**；远端镜像 Node 为 **24.13.0**。使用新维护脚本推荐的直接 Node loader，避免 `npx` 选择到其他本地 Node。沙箱 SDK 1.1.0、Pi 0.86.1、agent-browser 0.38.1、Chromium 153.0.8010.52。模型视觉输入未测；正式产品工作台尚未串联。
