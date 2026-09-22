# DEV-14 · 在页面配置自己的模型服务并验证连接

## Parent

https://github.com/hengworkinggit/pivloom/issues/1

优先级：P0；状态：ready-for-agent；覆盖 F15 / E31 / I12。编号为新增票编号，不表示最后开发。

## What to build

登录用户从“设置 → 模型服务”添加 Provider、Base URL、API Key 和模型名称，测试连接、保存、编辑、更新密钥、设为默认及删除配置。刷新或重新登录后配置仍在，只回显密钥掩码。工作台显示用户选中的模型，并在真实生成中使用它。普通用户不编辑服务器环境文件。

## Implementation decisions

- 页面、鉴权 API、私有数据库记录和 Pi 连接探针一起交付；模型通信直接复用 pi-ai，不新增 Provider 框架。
- 模型配置按 owner 隔离，元数据与加密凭据分开；凭据使用服务端随机生成、独立于数据库保存的主密钥加密。加密记录绑定 owner/profile/version，响应只含掩码和配置状态。密钥不进入 localStorage、日志、Run/SSE、源码快照或 OpenSandbox。
- 设置 API 提供 GET/POST /api/v1/model-profiles、PATCH/DELETE /model-profiles/:id、POST /model-profiles/test（未保存草稿）、POST /model-profiles/:id/test（已保存版本）；草稿测试不持久化Key；PATCH 中省略 apiKey 表示保留，掩码字符串不能当新密钥保存。默认项按账号维护。
- 列表返回 provider、baseUrl、modelId、配置版本、掩码、默认状态和已验证能力，不返回可解密材料。测试通过实际 Pi 请求验证连接、流式和无副作用的工具调用；图像能力另测，未经验证标 unknown/DOM-only。
- 用户提供的首个配置为火山方舟 Coding Plan，Base URL https://ark.cn-beijing.volces.com/api/coding/v3，模型 glm-5.3-flash。密钥不写入工单。协议由实际 Pi 兼容性验证决定；不自动改到其他计费端点。
- Base URL 只接受本轮支持的公开 HTTPS 模型端点；拒绝内嵌凭据、回环/私网/链路本地地址和重定向绕过，对 DNS 解析与实际连接目标做一致校验。连接探针有超时、限频和有限输出。
- 配置变更产生新版本。Run 固定 modelProfileId/configVersion 及服务端凭据版本引用；运行中编辑、设默认或删除不悄悄切换已接受任务。删除阻止新任务引用；在途任务所需凭据版本按任务结束后清理规则保留，不把明文复制到 Run。
- 本票在 #3 通过后执行，不要求先完成整条生成链。#4 依赖本票，将 modelProfileId/configVersion 纳入请求幂等校验，并在那里验证选中配置真正生成应用。

## Acceptance criteria

- [ ] A 从 UI 添加首个配置，错误 Key 得到脱敏错误；更正后真实 Pi 连接、流式、工具调用通过。
- [ ] 保存、刷新、重新登录、编辑、默认切换、密钥更新、删除均实际可用；从不回显完整 Key。
- [ ] B 无法列举、读取、修改、测试或删除 A 的配置；数据库直接访问不能越权。
- [ ] 页面无配置时指向设置，失败保留非敏感输入；不自动用其他账号/部署者模型，也不退回 Mock。
- [ ] 不支持的协议/模型与能力不足有明确反馈；视觉能力未经实测不标通过。
- [ ] 已删除配置不能接受新任务；配置版本与默认切换语义有可执行契约，#4 实测运行中一致性。

## E2E immediately after this module

| 用例 | 实际操作 | 必须观察到 |
|---|---|---|
| E31 设置全流程 | Codex 内置浏览器登录 A → 打开设置 → 添加配置 → 错误连接 → 更正 → 真实测试 → 保存 → 刷新/重登 → 更新/设默认/删除 | 真实反馈、配置持久、密钥只显掩码；桌面及 390px、键盘可操作；截图避开正在输入的密钥 |
| E31 / I12 owner | 切换 B 并用真实 HTTP 尝试访问 A 的 profile | 一致拒绝且无模型调用/配置副作用 |
| I12 凭据与目标 | 检查存储与响应；测试私网 URL、DNS/重定向绕过、掩码误保存和超时 | 数据库无明文 Key，响应/日志无泄漏，未授权网络目标不被请求 |
| #4 联动复测 | 工作台选择配置并生成；同幂等键换配置、运行中修改默认/配置、删除 | 实际调用与冻结版本一致；冲突明确，不影响正在运行的任务 |

## Blocked by

- [DEV-02 · #3](https://github.com/hengworkinggit/pivloom/issues/3)

## Out of scope

组织共享密钥、自动供应商路由、自动充值、OAuth 供应商授权、计费平台和读取个人 CLI 登录态。

## Module completion gate

本票完成后立即执行 E31/I12 适用子集和身份模块回归，并运行 typecheck、相关测试和 code-review。真实模型/身份缺失时记 BLOCKED，保持 Issue 打开；HTTP 200、Mock 或静态页面不能替代连接与浏览器验收。记录 build、环境、测试账号别名、profile/version、期望与实际及脱敏证据，不记录密钥。#4 联动项随 #4 执行；本票完整设置/连接流程不延后到最终发布。
