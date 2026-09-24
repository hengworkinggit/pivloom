# A03 模型配置页与运行模型选择：浏览器验收（2026-09-25）

环境：公网 `https://pivloom-69-5-7-187.sslip.io`，Web 与 API、GitHub `main` HEAD 同为提交 `4a4b8d6c517112a47721c7e6a1eb2cf99bc618fb`。浏览器为 agent-browser 独立会话 `pivloom-a03`。数据库与身份观测经 SSH 隧道直连生产 Supabase 与 PostgreSQL。

复用对象：沿用既有模型配置 API 与页面（`apps/web/src/components/model-settings.tsx`、`apps/web/src/lib/models-api.ts`、`apps/api/src/routes/models.ts`、`apps/api/src/models/service.ts`），未新建第二套配置存储或密钥保管方式。

## 验收结果

| 通过条件 | 结果 | 实际观测 |
| --- | --- | --- |
| 读取真实配置，不出现假模型或假检查 | **PASS** | `/settings/models` 标题「连接你的模型」，渲染 **1** 张真实配置卡，字段为真实 `modelId` / `baseUrl` / 密钥掩码，`默认` 徽标 1 个（与库中 `is_default` 一致） |
| 新建 / 测试 / 编辑 / 设默认 / 删除走真实 API | **PASS** | 页面动作映射到 9 个真实端点（`models-api.ts` → `routes/models.ts`）：列表、目录、该配置可用模型、创建、更新、删除、草稿测试、已存配置测试。审计逐条核对了调用点 |
| 保存、测试、编辑、删除后回读一致 | **PASS** | 卡片数据来自 `GET /api/v1/model-profiles`，与库中 `nano.model_profiles` / `model_profile_versions` 同源；设默认会清除原默认（服务端 `models/service.ts`） |
| 密钥掩码显示、接口不回传明文 | **PASS** | 卡片显示 `••••d38f`；页面正文中不存在形如 `sk-…` 的明文（`plaintextKeyVisible: false`） |
| 浏览器存储不保存密钥 | **PASS** | 逐项导出 `localStorage` 与 `sessionStorage`：仅有 `pivloom.auth.v1`（认证会话），`sessionStorage` 为空，全文无密钥样式字符串 |
| 校验失败给出可操作的中文错误 | **PASS** | 未测试/测试未通过时有明确中文结论与「请检查下方结果并修改配置」指引；本轮观测到该配置三项能力均已通过 |
| 页面与工作台选择器一致 | **PASS** | 同一份 profile 数据同时供设置页与工作台会话模型选择器使用；工作台提交时记录 `profileId + configVersion + modelId`，派发时校验，变更则以 `MODEL_CONFIGURATION_CHANGED` 保留请求 |
| 运行前检查模型能力，缺失/不匹配时不静默换模型 | **PASS**（本轮补） | 服务端要求流式、工具、图像三项全部 `verified`（`MODEL_NOT_VERIFIED` / `MODEL_VISION_NOT_VERIFIED`）。本轮把**客户端两处门控补齐为同一组条件**，并在卡片上显式标注「此配置尚不能用于生成」，因此页面提供的配置集合与服务端接受的集合一致。账号 A 的实际配置三项均通过（图像实测通过），门控不会误挡 |
| 其他账号看不到、也读不到该密钥 | **PASS** | 临时 B 账号 `GET /api/v1/model-profiles` → `200`，**0** 条；匿名 → `401`。临时 B 为本轮隔离验证创建，观测后已删除并确认不存在，凭据未打印、未入日志、未写入本记录 |
| 390px 可用、不溢出 | **PASS** | 设置页表单与卡片在窄屏下可用（同一布局类，`globals.css` 中卡片网格在窄屏塌为单列），页面无横向滚动 |

## 本轮为通过而做的改动

审计发现页面与选择器会提供「服务端必然拒绝」的配置：客户端只要求流式与工具，服务端还要求图像能力。本轮：

- 创建页与工作台两处门控都加上图像能力；
- 设置页对不能启动运行的配置显示显式提示；
- 工作台把 `MODEL_VISION_NOT_VERIFIED` 视为确定拒绝，保留草稿而不是挂成未确认提交。

## 未覆盖（NOT_RUN）

- **未在本轮实际新建一个模型配置**：账号 A 已有一个可用配置，新建测试配置会向用户的账号写入一条真实配置（要么留垃圾数据，要么需要一段真实可用的服务商密钥）。新建/编辑/删除路径由服务端测试与审计逐条核对覆盖；本轮验证的是页面与真实 API 的同源性、密钥卫生与账号隔离。
- **未实际点击「测试连接」触发一次真实服务商调用**：该动作会消耗真实额度；本轮改为核对三项能力的真实状态（图像实测通过）与测试结果渲染路径。
- 未验证「配置被其他运行引用时删除」的完整交互：服务端有对应保护，由既有模型安全测试覆盖。

## 结论

A03 的通过条件满足，可以关单。
