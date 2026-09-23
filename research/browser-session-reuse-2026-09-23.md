# 浏览器、沙箱与登录会话：成熟实现复用核查

日期：2026-09-23。以官方仓库、固定版本源码、官方文档和本地工具探针为依据。只做研究和探针，没有对生产调用模型或改动账号。

## 结论

浏览器保留已有 agent-browser，直接使用原生 `press / wait / batch / screenshot`；Pi 的 image ToolResult 用于把截图传入模型。OpenSandbox 保留官方 SDK 生命周期接口。登录会话沿用 Supabase 官方 session_id 与注销语义。以上都不需要另建浏览器内核、按键调度器或身份服务。

但三者的组合仍需要少量 Pivloom 业务适配：owner/revision 校验、当前任务的取消信号、数据库终态与快照原子提交。不存在拿来就能替平台完成这些不变量的通用 CLI。

## 1. agent-browser：已有成熟操作，不应在外层人为截断

2026-09-23 GitHub 查询：`vercel-labs/agent-browser` 43,103 stars，非归档，Apache-2.0；最新发布为 0.38.1。固定 tag 对应提交 `aff6125c023b810ea3f2e5deec5379e9a4270bdc`。main 已前进到 `d01253d9db28d75080e36da3c1c31ef89454731e`，本轮不按 main 漂移升级。

| 需求 | 可直接复用的官方实现 | 对 Pivloom 的决定 |
|---|---|---|
| 四向键盘、Space、数字/运算符 | [`press_key_with_modifiers`](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/native/interaction.rs#L322) 使用 CDP keyDown/keyUp | 复用官方 key 映射，扩展当前外层 schema；不自己实现按键协议 |
| 条件等待、短延迟 | [`handle_wait`](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/native/actions.rs#L6425) | 直接调用 wait；平台只限制作用域、总时长、取消和等待后重新观察 |
| 动态游戏短动作序列 | [原生 batch](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/README.md#batch-execution)、[MCP JSON argv 适配](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/mcp.rs#L3386) | 沿用 JSON argv 数组和 bail 语义；不写另一套时序执行器。每项结果保留，不把 batch 退出成功当业务通过 |
| Canvas 截图 | [官方截图实现](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/native/screenshot.rs#L98) | 实际 PNG/JPEG bytes 作为 Pi image content 返回；仅 artifact ID 不够 |
| 独立测试身份 | [官方 session 文档](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/README.md) | QA A、QA B、产品 Reviewer 分开会话，不能用两个共享 Cookie 的标签冒充隔离 |

仓库上游有 batch 参数测试、wait E2E 和键盘 E2E：[commands.rs](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/commands.rs#L6576)、[e2e_tests.rs](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/native/e2e_tests.rs#L2782)。这些是成熟度依据，不代表本轮已运行全部上游测试。

还检查了官方 `@agent-browser/eve` 集成。它依赖另一套 Agent runtime，且 README 明示 inlineScreenshots 是给 UI 的 data URL、通过 toModelOutput 对模型隐藏。整包引入既不适合当前 Pi 栈，也不能据此声称已有视觉理解。[官方 README](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/packages/%40agent-browser/eve/README.md)

### 已完成的本地探针

使用临时安装的原版 agent-browser 0.38.1、Node 24.19.0 和独立 Chrome 会话，在本地合成页面运行九个官方 batch 动作：等待 Ready、四向按键、Space、80ms 等待、读取实际按键日志、保存截图。全部成功；页面观测的 keydown 顺序为右、下、左、上、空格。探针没有模型调用，也不是生成游戏验收。[脱敏结果](upstream-browser-probe-2026-09-23.json)

已部署沙箱 Dockerfile 固定 0.38.1，而开发机默认全局 CLI 实际为 0.36.0；测试必须分别记录并显式选择版本，不能把本机命令默认值当作生产值。[Dockerfile](../infra/sandbox/Dockerfile#L6)

**待实施验证：**把实际截图送入当前配置 Provider 后，是否能通过 Pi 返回正确图像观察；该能力本轮没有发付费模型请求验证。不能降低为只做 DOM 版贪吃蛇来跳过这个门槛。

## 2. OpenSandbox：复用 SDK，保持生命周期语义正确

GitHub 当前仓库名为 `opensandbox-group/OpenSandbox`（旧 alibaba URL 重定向），15,482 stars，Apache-2.0。生产基础版本是 server commit `15426df5d146d6ce7499a16bd1ed871e7242fe27` 与 JS SDK 1.1.0；main 的 `db156437a846c3872b41e69f52ad5c52e62ef625` 仅作为现状，不自动升级。

官方 [`Sandbox`](https://github.com/opensandbox-group/OpenSandbox/blob/15426df5d146d6ce7499a16bd1ed871e7242fe27/sdks/sandbox/javascript/src/sandbox.ts#L1026) 已定义：kill 删除远端实例；close 释放本地 transport；renew 把 expiresAt 设为当前时间加 timeoutSeconds。[官方 JS 示例](https://github.com/opensandbox-group/OpenSandbox/blob/15426df5d146d6ce7499a16bd1ed871e7242fe27/sdks/sandbox/javascript/README.md)

因此生命周期改造应直接调用并等待这些 SDK 方法，再把远端确认写回已有 PostgreSQL 状态。不能把 close 当作已销毁，也不能因为模型结束就提前释放仍在清理的项目锁。运行中 renewal 与运行截止对齐，预览 TTL 另行控制。SDK 不负责本产品 owner、currentRevision、取消/完成竞争或事务失败重试，这些薄业务层仍必须保留。

## 3. Supabase：使用原生登录 session，不重造身份系统

官方文档明确：JWT 包含 session_id，对应 auth.sessions；注销移除会话记录，但已签发的 access token 可能在到期前仍有效。若要求退出后立即拒绝新访问，需要核对该 session 是否还存在。[Sessions](https://supabase.com/docs/guides/auth/sessions)、[Sign out](https://supabase.com/docs/guides/auth/signout)

本项目已使用 `signOut({scope:'local'})`，应保留，不再添加全局踢出逻辑。[现有实现](../apps/web/src/lib/workspace.ts#L105)

私有 Preview 复用现有独立来源、HttpOnly Cookie 与短期 capability，但其最小授权绑定必须加入已验证身份的 session_id；服务端验证 owner/revision 和会话仍有效。平台退出时失效当前 session 的预览能力，另一个有效 A 会话不应被一并销毁。API 的 `getUser` 不是“所有旧访问凭证已经立刻失效”的充分证据；用已验证 token 提取 session_id 后，以受限的服务器查询验证会话。[当前 verifier](../apps/api/src/auth/supabase.ts#L27)

可以参考 OpenHands 的 workspace-cookie 范围隔离与清除端点，但其凭据模型不同，不能把长寿命 workspace API key 直接装进本项目预览 Cookie。具体固定源码与限制见 [OSS 审计](oss-reuse-audit-2026-09-23.md)。正式发布地址保持匿名可读，不能混入私有 Preview 撤销测试。

## 4. 复用纪律与新增测试门槛

- 原生 SDK/CLI 已解决的动作直接调用；只有类型转换、scope、信号、持久化收口使用项目代码。
- 复制源码先固定 commit、查看该文件所属目录 LICENSE/NOTICE，保留归属；直接依赖不能伪称复制了完整 Agent。
- browser_* capability probe、Pi image-content probe、真实 Provider vision probe、Supabase session 撤销矩阵分别记录。前两个离线通过不替代后两个真实联调。
- 原研究中的 DOM-only 简化路线撤回。Canvas、普通网页控件与键盘/时间交互都进入正式复核，不预写计算器或贪吃蛇业务实现来代替模型生成。
