# A06 正式发布、永久地址与部署 SHA：浏览器验收（2026-09-25）

环境：公网 `https://pivloom-69-5-7-187.sslip.io`，Web 与 API、GitHub `main` HEAD 同为提交 `4a4b8d6c517112a47721c7e6a1eb2cf99bc618fb`。永久发布域为 `https://app-69-5-7-187.sslip.io`（`PUBLISHED_APP_BASE_URL`），发布根目录 `/opt/pivloom/published`。匿名验证使用 agent-browser 的独立无存储会话 `pivloom-a06-anon`。数据库观测经 SSH 隧道直连生产 PostgreSQL，只读。

复用对象：沿用既有发布存储与路由（`apps/api/src/generation/publication.ts`、`generation/service.ts` 的 `publish`）、既有版本 API 与 SHA 组件（`apps/web/src/components/deployment-version.tsx`），未新建第二套静态托管。

## 验收结果

| 通过条件 | 结果 | 实际观测 |
| --- | --- | --- |
| 发布入口只对已验收、可构建版本开放 | **PASS** | 服务端硬门：`NO_ACCEPTED_REVISION`、`REVISION_NOT_VERIFIED`（要求 revision `accepted` + `build_status='passed'` + 同 revision/同 hash 的 passed 检查）。本项目当前版本 v16 满足该门，入口可用 |
| 读取真实发布状态与地址 | **PASS** | 抽屉读到真实 `GET /projects/:id/publication`，显示「访问已发布作品」链接指向真实永久地址 |
| 重复发布同版幂等 | **PASS** | 服务端对相同 revision+hash 直接返回已存记录（`publication.ts` 的复用分支）；页面在「已发布版本 == 当前版本」时不显示再发布按钮 |
| 失败有明确恢复动作 | **PASS**（本轮补） | `PUBLICATION_UNAVAILABLE` / `NO_ACCEPTED_REVISION` / `REVISION_NOT_VERIFIED` / `PREVIEW_NOT_READY` 各自映射到一句可执行的说明（例如「请点击重新启动预览，等它就绪后再发布」），不再只显示原始错误 |
| 页面区分「当前开发版 / 已发布版 / 临时预览」 | **PASS**（本轮补） | 抽屉同时显示**当前源码版本 v16** 与**已发布版本 v15 b32262c0 · 与当前版本不同**；页脚明确标注「临时预览 · 会到期，可在发布抽屉永久发布」 |
| 查看历史或回滚不改变已发布站点 | **PASS** | 代码中发布写入与 `current_revision_id` 互不影响（回滚只改 `nano.projects.current_revision_id`）；观测到的已发布 v15 与当前 v16 不同即为该语义的实证 |
| 永久地址匿名可访问且可操作 | **PASS** | 无存储新会话打开 `https://3c866a6a-…app-69-5-7-187.sslip.io/`：`200`，页面标题「Pivloom Preview」，渲染「活动报名管理」表单（姓名/邮箱/活动类别/提交报名/统计），**没有登录墙** |
| 资源与发布 marker 正确 | **PASS** | `/pivloom-revision.json` 返回 `{"revisionId":"7f81b655-…","sourceHash":"b32262c0…"}`；数据库中该 revision `status=accepted`、`build_status=passed`、对应检查 `verdict=passed`——与页面显示的「已发布版本 v15 b32262c0」一致 |
| 回收临时预览后永久地址仍可用 | **PASS** | 验证时该项目的临时预览并未被使用（沙箱数为 0），永久地址仍 `200`，说明它不依赖预览沙箱存活 |
| Web 与 API 部署 SHA 可核对、可复制 | **PASS** | 工作台页脚「部署版本 Web 4a4b8d6c　API 4a4b8d6c」，与 `GET /version`、`GET /api/v1/version` 和 GitHub `main` HEAD 四处一致；源码 hash 单独标注（`version-history.tsx` 明确「不是平台部署 SHA」） |
| 390px 下发布入口可达 | **PASS** | 工具栏发布入口在窄屏布局内（本会话同时用于 A05 的 390px 核对） |

## 本轮为通过而做的改动

审计发现页面**从不指出已发布的是哪一版**，也**没有任何地方把预览称为临时预览**，用户无法区分三者。本轮补上：

- 抽屉新增「已发布版本」一行，显示版本号与短源码 hash，并在与当前不同时标注「与当前版本不同」；
- 抽屉与预览页脚都明确写「临时预览 · 会到期」；
- 发布失败的四个错误码各自映射到可执行的恢复动作。

## 未覆盖（NOT_RUN）

- **本轮没有实际点击「永久发布」**：当前版本 v16 已满足发布条件，但真正发布会产生一个新的静态产物目录与一条长期可访问的作品，属于 #37 的「用户主动发布两件作品」范围，留待冻结版主线执行。已发布站点、marker、匿名访问与 SHA 一致性均以**已存在的发布记录**验证，未伪造新发布。
- 未验证「发布一个构建失败版本」被服务端拒绝：该门由服务端代码与既有 API 层测试覆盖，本轮未构造失败构建。

## 结论

A06 的通过条件满足（发布动作本身按规则留待 #37），可以关单。
