# G0 基础运行时实测（2026-09-22）

结论：**Pi → OpenSandbox Docker + gVisor → React 构建 → Chrome 行为检查的基础运行时已通过真实验证。** 本次使用用户提供的 Ark 模型配置，不是预制应用、模拟模型或本地宿主命令替代。正式产品工作台尚未串联此运行时；模型视觉输入能力未测。

后续已补齐仓库维护页面、真实流取消及 snapshot v1，见 [维护入口与后续实测](g0-maintenance.md)。本文保留首次成功运行的原始结果，其中 sourceHash 使用旧 G0 v0 的 path/sha 拼接规则，不能与新的带 schema/template 版本的 hash 直接比较。

## 验证范围与结果

2026-09-22 09:50:48–09:55:25（Asia/Shanghai），`runProbe` 从空 React 模板生成一个中文记录应用。需求包含“记录”文本框、“添加”按钮、提交后的记录列表和 localStorage。自动浏览器验收覆盖填写、提交与显示新记录；本轮没有单独做刷新后持久化、手机布局或模型视觉判定。

| 检查 | 结果 | 实际观察 |
| --- | --- | --- |
| Pi 真实模型循环 | PASS | Ark `glm-5.3-flash`，`openai-completions`，10 轮 HTTP 200 |
| 远程 read / write / edit / bash | PASS | 9 次工具调用，8 次成功；四类工具均有成功记录。一次 write 未完成后，模型重新调用 write 成功，未被人工替写 |
| 固定 TypeScript / Vite production build | PASS | 服务端固定构建入口退出码为 0，不依赖生成应用自报成功 |
| 预览版本绑定 | PASS | 通过 OpenSandbox server proxy 读取 marker；revision 与源码哈希匹配，浏览器检查后源码哈希未变化 |
| 真实 Chrome 行为检查 | PASS | 获取实际页面 refs，填写独有记录文本，点击“添加”，完整 DOM 确认输入记录出现 |
| 截图、异常检查与会话关闭 | PASS | 保存 PNG；浏览器异常集合为空；关闭会话获确认 |
| 模型视觉能力 | 未测 | 本次验收依据 DOM 与实际操作，没有把截图送给模型作视觉判断 |
| 正式工作台生成流程 | 尚未接入 | 本次通过维护者启动器及独立预览运行，不代表项目、生成历史、版本管理等产品流程已完成 |

总耗时 **276.382 秒**。单轮模型请求仍采用 90 秒上限；本次未通过扩大超时或关闭模型思考来获得通过。

## 可复核标识

- Run ID：`c326c79f-bed4-42c8-b0e7-3a87c81fdcbe`
- Revision ID：`80eafc2c-f4b0-4699-a0fe-0bfd8836d215`
- 源码快照：7 个文件；生成的 `src/App.tsx` 为 2,515 字节。
- 源码集合 SHA-256：`0afd9616c666d9c27995b74d8e1620cec7a12aaa26877f199e5a372556e45c75`
- `src/App.tsx` SHA-256：`1795d7dcc2d290c0a4a990ce11c7d48de807f08964a80d922773cbee81ae1e49`
- Chrome PNG SHA-256：`e79b1d3452f0f877455f150d31a84a62a05353d637d304a4e2f0f6c567f3fcc4`
- 本地维护者原始记录：`.cache/development/g0-real-result.json`、`.cache/development/g0-real-chrome.png`。这些是本次工作区的临时证据，不能假定其他克隆中存在。

完成时预览按租约保留供独立验收，记录中的到期时间为 2026-09-22 10:10:51（Asia/Shanghai）。`retained_until_expiry` 表示有意保留，不能解释为已销毁；后续显式清理或 TTL 回收以维护者验证记录为准。临时 localhost 预览地址不是正式部署地址。

## 运行组件与隔离边界

| 组件 | 本次版本 / 方式 |
| --- | --- |
| Pi coding-agent / agent-core / pi-ai | 0.86.1 |
| OpenSandbox TypeScript SDK | 1.1.0 |
| 工作镜像 | `pivloom-g0:20260922` |
| 远程 Node | 24.13.0 |
| Chromium | 153.0.8010.52 |
| agent-browser | 0.38.1 |
| 本地服务 Node | 24.19.0 |
| 沙箱控制面 | OpenSandbox Docker，gVisor systrap；既有主机基础验证见 [sandbox-g0-results.md](sandbox-g0-results.md) |

入口为 [`runProbe`](../apps/api/src/runtime/probe.ts)，正式生成可复用 [`runBuilder`](../apps/api/src/runtime/pi.ts)。Pi 使用内存凭据仓库、独立临时会话目录和禁用宿主扩展/技能的资源加载器；四个工具的执行边界都指向远程工作区。模型 HTTP 请求沿用调用方提供的 BYOK 受控 fetch。

源码读写通过远程 Node 守卫处理，限制路径、软链接、文件类型和大小；镜像不需要 Python。Builder 命令使用沙箱内普通 UID。构建前撤销 Builder 写入口并结束其残留进程，之后使用受控构建及静态预览服务。

管理连接及文件、命令、预览均通过 SDK `useServerProxy=true` 使用管理端点。预览发布回调只把公共预览 URL 返回调用者；管理密钥与 upstream headers 留在后端。本记录不包含任何模型密钥、管理密钥或登录凭据。

## 失败修正与局部检查

首次真实生成在两次 bash 后于模型阶段失败，候选沙箱已确认销毁。该轮原始摘要保存在 `.cache/development/g0-real-attempt1.json`。原错误信息不足以证明具体原因；随后补齐轮次、HTTP 状态、耗时和脱敏错误摘要，并将探针收敛为小应用与明确四工具顺序，第二轮完整通过。

接入期间修正了两个实测问题：Vite 默认配置加载会尝试写 root 所有目录，固定构建改用 native config loader；远程后台命令结束与日志读取存在竞争，完成状态后追加一次日志读取，避免漏掉 Chrome 的 JSON 输出。

本地验证：API typecheck 与 runtime lint 通过；runtime 的 5 项边界测试和旧维护入口的 3 项 HTTP 测试通过。边界测试覆盖 late-create 取消清理、清理失败保持 pending、敏感/越界源码路径拒绝、浏览器外部 origin 拒绝、过期或跨观察 refs 拒绝。这些外部端口 fixture 测试与上面的真实链路记录分别计量。

早期 `/probe` HTTP stub 保留为明确的 `410 PROBE_RETIRED`，继续保留本机 Host/Origin 防护，不再提示配置 E2B 或环境变量模型凭据。此次不扩展正式业务路由、模型参数界面或产品导航。

## 独立复核与清理补记

随后 Codex 内置浏览器在跨来源 iframe 实际添加独有记录，刷新整个外层页面后记录仍显示。该步骤补充了上述自动 Chrome 用例没有覆盖的刷新持久化。验收后显式销毁预览，维护启动器确认 `CLEANUP {"confirmed":true}`。联合 Supabase 负载及真实页面配置详见 [基础设施联合验收](foundation-validation-2026-09-22.md)。
