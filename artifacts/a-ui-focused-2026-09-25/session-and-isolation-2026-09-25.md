# A08 补证：全新浏览器恢复与跨账号隔离（2026-09-25 04:50–04:56 CST）

本记录补上 [A 界面切片验收](../../docs/e2e/a-ui-focused-2026-09-25.md) 中此前的 `BLOCKED`：B 测试身份不能用。全部观测来自部署中的公开站点 `https://pivloom-69-5-7-187.sslip.io`（Web/API 均为 `d9f3e22cf8492bc97edc844e284a33c44315a160`，`builtAt 2026-09-24T20:07:30.865Z`），浏览器为 agent-browser 的独立命名会话，每个会话各有全新 profile，没有导入任何认证或存储。未执行模型生成、预览恢复、回滚或发布。

## 1. 全新浏览器会话登录 A：平台数据恢复

会话 `pivloom-a08-a-fresh`（新 profile，首次打开站点即为登录页）：

| 对照项 | 实际观察 |
| --- | --- |
| 项目 | 直接打开 `/projects/bfbbe5cc-4207-4d3e-9620-84df5035e1bc` 正常渲染该项目工作台，未被重定向到新项目氛围的空白页 |
| 对话 | 左栏恢复该项目完整对话：v5 三次失败、v6 复检通过（12 项）、A1 增量（17 项）、A2 深色改造需求，与 `artifacts/technical-recheck-2026-09-23/rc10-three-version/report.md` 记录一致 |
| 版本与 hash | 工具栏显示“正在查看 v8”、短源码 hash `424bd83f`、版本 `36b6a2eb`；"复制完整源码 hash" 按钮可点 |
| 源码 | 代码页列出 7 个文件（index.html、package-lock.json、package.json、src/App.tsx、src/main.tsx、src/style.css、tsconfig.json），可读且标注“v8 · 只读” |
| 检查 | 工具栏显示“检查结果 5/5”，可进入检查抽屉 |
| 预览 | 显示“预览已到期”，提供“重新启动预览”；说明文字明确重启不调用模型。本次没有点击重启，因此不占沙箱、不产生生成 |
| 部署标识 | 页脚显示 Web `d9f3e22c`、API `d9f3e22c` |

截图：`a-fresh-browser-workbench.png`（工作台整体）、`a-fresh-browser-source.png`（7 文件与只读源码）。

## 2. 临时 B 身份与跨账号隔离

原 `pivloom-dev-e6d33625ef2b` manifest 里的 B 身份密码已失效（`invalid_credentials`，与上一轮 A08 记录一致），A 仍可正常登录。为此新建了一次性身份：

- 创建/验证脚本：`.cache/identity/prep/create-ephemeral-b.mjs`（调用生产 Auth 管理接口，创建后立即用 publishable key 验证密码登录；不打印任何密钥）
- 身份记录：`.cache/identity/ephemeral-b-452758d0.json`（0600，`.cache` 已被忽略）；`id=b1d7d738-bb82-44d4-aa51-fdb1ce26c88c`，邮箱 `pivloom-ephemeral-b-452758d0@example.test`
- 登录验证：脚本输出 `signIn: ok`；随后在浏览器会话 `pivloom-a08-b`（另一全新 profile）用该身份登录成功

浏览器观测（`b-empty-project-list.png`）：

| 动作 | 结果 |
| --- | --- |
| B 登录后进入 `/projects?view=list` | 标题“我的项目”，正文“还没有项目”，无任何 A 的项目或截图 |
| B 直接访问 A 的计算器项目 URL | 页面显示“暂时无法打开这个项目 / 项目或配置不存在，或你没有访问权限。”，没有渲染 A 的任何对话、版本或源码 |

API 隔离矩阵（10 条探针，原样记录在 `account-isolation-matrix.json`，UTC `2026-09-24T20:49:01Z`）：A 的私有项目、版本列表、源码文件、单文件、Check、预览、发布记录、运行详情与事件流，A 全部 `200`；B 全部 `404`；未带 token 全部 `401`。B 的项目列表为 0 条且不含 A 的项目。

## 3. 本次仍然没有覆盖的部分

- A 的临时预览在观测时已到期，没有活动绑定可测；**私有预览对 B / 匿名访问的拒绝**未在本轮执行，留给 #37 在有活动预览时补。
- 未导出/导入浏览器存储以外的会话数据；生成应用自己的 localStorage 不在平台恢复承诺内。
- B 是"可登录但无数据"的全新账号；B 侧的已有项目恢复、B 的模型配置越权等未涉及。
- 没有点击“重新启动预览”、没有发布、没有真实模型运行；这些属于冻结版 #37 主线。
- 临时 B 身份保留待 #37 复用（隔离与多账号排队都可使用），用完应通过 Admin API 删除并清理记录文件。

## 4. 三处 SHA（同一时点）

`2026-09-25 04:56 CST`（UTC 2026-09-24 20:56）读取：线上 `/version`、`/api/v1/version` 与 GitHub 默认分支 HEAD 均为 `d9f3e22cf8492bc97edc844e284a33c44315a160`；工作区 `main` 多出尚未推送的 `614fc28`（仅契约：`queued` 状态与本人任务列表），因此冻结发布时要按新的并集重新对齐。
