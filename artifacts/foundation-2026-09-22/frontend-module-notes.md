# DEV-02 / DEV-14 前端模块验收补充

记录时间：2026-09-22（Asia/Shanghai），包含 10:27 自动验证及随后主执行者回传的 UI 结果。对应 [#3](https://github.com/hengworkinggit/pivloom/issues/3) / [#15](https://github.com/hengworkinggit/pivloom/issues/15)。

本记录区分主执行者在 Codex 内置浏览器获得的真实结果和 React/HTTP 边界 fixture 测试。仍待检查的项目不计为通过；不据此关闭 Issue。联合基础设施结果见 [基础设施联合验收](../../docs/foundation-validation-2026-09-22.md)。

## 版本、范围与环境

- 基线：`5d1ae44c35e7d2c6b52a18178bb68354fbcfff97` 加未提交工作区；主要增量为真实身份/项目 adapter、模型配置 UI/API、owner 私有查询隔离和基础设施。最终 commit、API boot ID 由主执行者在收尾记录中补齐。
- UI：`http://localhost:45231`；API：`http://127.0.0.1:45310`；Supabase Auth：本地 SSH 隧道 `http://localhost:45322`，连接已授权服务器上的真实自托管实例。
- 账号：该实例的 A/B 测试身份。账号口令与资源 ID 保留在忽略的私有 manifest 和主执行者记录；本报告不复制凭据。
- 模型：Pi `0.86.1`；OpenAI-compatible；Ark Coding Plan `https://ark.cn-beijing.volces.com/api/coding/v3`；`glm-5.3-flash`。未验证真实 Anthropic 或视觉能力。
- #3 是服务端空项目，#15 是用户模型设置。本票页面不制造生成结果；Run / Revision / sourceHash / 模板版本不适用，正式生成衔接等待后续模块。

## #3：已证实与待补检查

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| 真实登录、创建、刷新恢复、退出并重登 | PASS（本轮 UI） | 主执行者在 1280×800 重新登录 A，“我的项目 2”；分别重开 `565783d9…` 与 `355d526f…`，标题与 ID 一致。完整 ID 由主执行者私有资源记录保存。 |
| B 的项目列表隔离 | PASS（本轮 UI） | 主执行者确认 B 的项目数为 0；直接打开 A 项目显示不泄漏归属的拒绝信息，不呈现 A 项目内容。 |
| 真实 API 停机时创建失败并保留输入 | PASS（本轮 UI，390px） | 主执行者停 API 后创建，页面显示错误且中文输入完整保留；重启后提交第二项目，之后重新登录逐一重开两个不同 ID 的项目。 |
| 空白 / 超长需求不提交 | PASS（React DOM 边界） | 真实 `ProjectsPage` 的 textarea/submit button：空白禁用且 Enter 不请求；8,001 字显示错误、`aria-invalid=true` 且不请求。外部 Auth/API 用 fixture，不能替代真实浏览器。 |
| 中文 composition 不误创建 | PASS（React DOM 边界） | 向真实组件派发 composition/keyboard DOM 事件；`isComposing=true`、兼容 `keyCode=229` 均不请求、不拦截输入法默认动作；组合完成后的普通 Enter 成功请求项目创建并导航。此项不是手工输入法端到端成绩。 |
| Shift+Enter | PASS（React DOM 边界） | 实际 handler 不提交且不 preventDefault，让 textarea 保留原生换行行为；jsdom 不模拟浏览器的默认插入字符。 |
| 草稿刷新恢复与身份隔离 | PASS（本轮 UI + 公开边界） | 第二项目输入中文草稿并刷新，原文保留；主执行者确认主动退出后旧草稿清空。公开边界另验证仅清当前 owner，session 暂时失效保留草稿且其他 owner 读取不到。 |
| B 会话撤销后回登录且无私有内容 | PASS（本轮真实 Auth + UI） | 后端精确 global signOut B，`auth.sessions` 从 1 到 0，旧 JWT 的 `GET /user` 返回 403 `session_not_found`；浏览器刷新从模型设置自动回 `/login`，无私有内容。这是服务端撤销测试，不能称为 JWT 自然到期测试。 |
| 1280×800 登录/重开项目与整页宽度 | PASS（本轮 UI） | A 重新登录并分别打开两个项目；`document.scrollWidth = 1280`，没有整页横向溢出。390px 登录/创建及键盘提交见主执行者同轮记录；IME 特殊事件由 DOM 边界补证。 |
| 真实 HTTP/Postgres/Storage 越权检查 | 见联合验收及后端报告 | 前端浏览器拒绝并不能证明数据库/Storage 不可绕过；该项由真实集成证据支持。 |

首页确有 Enter 快捷键，不是仅依赖原生 form submit。相关生产代码为 `apps/web/src/components/projects-page.tsx` 的 textarea `onKeyDown`；本轮只添加测试，未更改稳定组件。

## #15：本轮独立浏览器进展

以下结果由主执行者在真实 UI 操作后提供，补充报告作者未并行操作浏览器。

| 检查 | 结果 | 实际观察 |
| --- | --- | --- |
| 390px 模型表单/列表 | PASS | `document.scrollWidth = 390`，没有整页横向溢出。 |
| 设置表单键盘操作 | PASS（内置浏览器） | Enter 激活“编辑”；从“配置名称”按 Tab，焦点进入 `model-provider` 下拉框；Enter 激活“关闭模型配置表单”后表单消失。未改动原配置。 |
| 错误 Key → 更正 → 保存并测试 | PASS | 错误 Key 真实连接失败，非敏感字段保留；更正真实 Key 后保存并测试通过。 |
| 编辑名称与 Key 轮换 | PASS | 临时配置改名、改为故意无效 Key，掩码变化且已验证能力重置；恢复真实 Key 后保存并测试通过。 |
| 切换默认配置 | PASS | 原配置设为默认，UI 显示成功。 |
| B 的模型列表 | PASS | B 登录后模型列表为空，没有 A 的模型配置。 |
| 删除配置 | PASS（本轮 UI） | 主执行者在 `/settings/models` 确认删除“E31 已编辑与轮换”，卡片消失并显示“模型配置已删除。”；原“火山方舟 · GLM 5.3 Flash”仍为默认配置。 |
| 删除后刷新持久化 | PASS（本轮 UI） | 主执行者刷新 `/settings/models` 并等待加载完成后，“E31 已编辑与轮换”没有恢复；仅见原“火山方舟 · GLM 5.3 Flash”（默认）和后端测试管理的临时 lease 卡片。 |
| 删除后不可测试及 credential lease 回收 | 见后端真实集成报告 | 不从卡片消失推断端点拒绝或密文回收；临时 lease fixture 由后端测试管理，本次没有修改或清理。 |
| 刷新/退出重登、1280px 与键盘、完整 B 操作拒绝 | 见主执行者最终 #15 记录 | 此前联合验收已验证保存后刷新保留掩码；本轮 B 空列表及会话撤销回登录均已验证。完整步骤与服务端 B 操作拒绝由其主报告记录。 |

模型 Key 仅短暂存在密码输入状态及提交请求，保存后清空；列表只显示掩码。公开模型 adapter 对响应进行 schema 投影，边界测试确认意外响应中的原始 Key 不进入返回对象。真实存储加密、owner 权限、lease 回收和日志扫描由后端/主执行者的集成报告给出。

## 本轮自动验证

2026-09-22 10:27（Asia/Shanghai）执行：

```text
npm run test -w @pivloom/web
6 files / 24 tests PASS
npm run typecheck -w @pivloom/web
PASS
npm run lint -w @pivloom/web
PASS
```

- 24 项中，12 项是原有显式 Demo 回归；其余 12 项是新增真实模式的外部边界/DOM 测试。这些测试没有连接远端 Supabase 或付费模型。
- 新增 `apps/web/src/components/projects-page.test.tsx` 渲染真实 ProjectsPage、AuthGate、Supabase SDK、workspace adapter 与草稿模块，仅替换外部 HTTP 和 Next 导航边界；正常 Enter 的正向断言保证测试不会因事件未绑定而空通过。
- `api-workspace.test.ts` 覆盖迟到请求、退出/重登竞态、401 重试与 owner 改变、无请求体 DELETE、主动退出清草稿与过期保留；`workspace.test.ts` 通过真实 SDK 验证身份服务 429 不能误报密码错误或清除有效 session。
- `models-api.test.ts` 覆盖响应密钥剥离；`drafts.test.ts` 覆盖 owner/project 隔离及模块重载后恢复。
- 先前对应 API 修复的 7 项定向测试通过：400/413/415 请求解析错误返回固定安全消息；模型加密主密钥缺失时匿名请求 401、已认证模型端点 503。最终 API 全量成绩以主执行者/后端报告为准。

未重启 Next、未更改稳定组件、未触发模型调用。本轮新增测试运行未创建服务器资源，无额外清理对象；真实 UI 临时项目/模型清理由主执行者在最终 manifest 中记录。

本报告经内容复核，仅含公开模型地址/名称、本地服务地址、截断项目 ID 和测试结果，不含账户密码、模型 API Key、Supabase Key 或完整会话凭据。
