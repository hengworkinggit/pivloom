# 技术复核：真实生成、两轮增量与身份隔离证据

核查日期：2026-09-23。代码基线：`92ffbb940015a2ac9182c26d81d93dc45269d710`。本报告只读核查当前源码和既有验收工件，没有调用模型、创建账号、修改数据库或操作生产。版本回滚、运行生命周期与部署 SHA 由主方案另行处理。

## 结论

| 复核要求 | 现有依据 | 本次仍需完成 |
|---|---|---|
| 全新计算器、贪吃蛇项目，真实模型且非固定业务模板 | 生产 Builder 确实通过 Pi 发模型请求、在远程工作区写源码；已有报名、书单的历史生成记录 | 没有找到计算器和贪吃蛇全新项目的实际验收证据，不能沿用报名/书单的 PASS |
| 同项目功能增量、视觉/字段增量 | 报名项目 v11 与 v15 有 accepted、源码 hash、真实角色用量和浏览器记录 | 新项目逐轮原始源码 diff、完整旧功能回归、统一版本核对；修复“只强制保留一个旧行为”的契约缺口 |
| 新浏览器、退出重登、账号隔离 | 旧公网 UI 报告、HTTP 账号隔离与源码/事件拒绝记录存在 | 同一新项目在干净浏览器和切换身份后的项目/对话/源码/版本/Preview 全矩阵；尤其旧预览 Cookie 与入口能力在退出后是否仍有效 |
| 每轮 5/5 | 真实 Check 会逐项绑定版本、源码和浏览器观察 | 5/5 仅表示本轮五个计划目标通过，不能自动证明全部需求、旧功能或平台隔离通过 |

最应先处理的阻碍：产品 Reviewer 只支持 DOM 文本，方向键缺左右、没有空格键和受控等待。直接开始真实贪吃蛇生成，可能得到能玩的应用却卡在内部复核。这是源码确认的能力限制，不是已证明线上贪吃蛇生成失败。

## 1. 生成不是固定业务模板，但需要新的现场证据

当前调用链为 `executor.execute → runCandidate → initializeReactWorkspace → runBuilder → createServiceModel/streamSimple → buildAndPreview → runReview`。

- 首次构建使用统一 React/Vite **工程脚手架**，其中 App 只是“开始构建你的应用”；没有现成计算器或贪吃蛇业务实现。[template.ts:34](../apps/api/src/runtime/template.ts#L34)、[template.ts:79](../apps/api/src/runtime/template.ts#L79)
- 增量构建从 `baseRevisionId` 的已保存源码加载 seed，并非每轮重置为空模板。[executor.ts:143](../apps/api/src/generation/executor.ts#L143)、[generation.ts:17](../apps/api/src/runtime/generation.ts#L17)
- Candidate 在工作区初始化后调用真实 Builder，再运行可信类型检查、构建、快照；测试 adapter 的 `afterBuilderOutput` 是额外显式边界，验收时必须确认禁用，不能把注入产物当真实生成。[candidate.ts:272](../apps/api/src/generation/candidate.ts#L272)
- Builder 通过 `runtime.streamSimple` 的已配置 transport 获取模型响应，并记录响应状态/实际流式内容；Pi 会话执行受控 read/write/edit/bash，最后调用 `session.prompt(input.prompt)`。[pi.ts:389](../apps/api/src/runtime/pi.ts#L389)、[pi.ts:432](../apps/api/src/runtime/pi.ts#L432)、[pi.ts:500](../apps/api/src/runtime/pi.ts#L500)

历史 A 修改记录含三角色及实际调用用量。例如最终 A 增量：Coordinator 2 次、Builder 7 次、Reviewer 30 次模型调用；源码 hash 为 `b32262c0…a68`。但 Run 顶层 `model_id=null`、`usage_json={}`，只拿 Run 顶层截图无法证明实际选择的模型；报告应关联该 Run 固定的 `model_profile_id/config_version`、角色记录和脱敏传输证据。不要把未知 token 填成 0。[最终运行工件:18](../artifacts/dev-14-2026-09-23/public-a-final-pass.json#L18)、[角色用量:244](../artifacts/dev-14-2026-09-23/public-a-final-pass.json#L244)、[Builder 用量:338](../artifacts/dev-14-2026-09-23/public-a-final-pass.json#L338)

建议新证据包至少记录：空项目 ID、原始 Prompt、Run ID、模型 profile/configVersion 与脱敏后的 provider/model、角色 session/调用次数、Builder 文件写入事件、构建输出、完整源码快照和 sourceHash、Check ID、Preview marker、独立浏览器操作。提供的服务端证据和独立 UI 证据必须指向同一 revision。共同使用脚手架不是模板作弊；两个应用仅换标题/配色而业务实现相同则不能通过。

## 2. “5/5”的真实含义及增量漏洞

当前约束明确是 **1–5 个目标**，不是固定的五项测试框架：

- `PlanSchema.behaviors.min(1).max(5)`；`ReviewResult.items.max(5)`。[planning.ts:24](../packages/contracts/src/planning.ts#L24)、[review.ts:24](../packages/contracts/src/review.ts#L24)
- `preservesPreviousBehavior` 只要求新计划中**存在至少一个**与任一旧行为相同的条目；比较 id、required、precondition、action、expected，不是“所有旧 required 行为”。[planning.ts:40](../packages/contracts/src/planning.ts#L40)
- Coordinator 提示词与工具校验都实施“至少保留一个旧行为”。[coordinator.ts:172](../apps/api/src/runtime/coordinator.ts#L172)、[coordinator.ts:213](../apps/api/src/runtime/coordinator.ts#L213)
- Reviewer 要覆盖本轮计划的全部目标；落库只确认**本轮计划**中的 required 目标通过，检查结果还绑定 sourceHash、revision、sandbox、browser session 和可信构建。[reviewer.ts:226](../apps/api/src/runtime/reviewer.ts#L226)、[generation repository:644](../apps/api/src/data/generation.ts#L644)
- 前端显示实际 `check.items.length` 和真实条目，未硬编码 5/5。[generation-review.tsx:64](../apps/web/src/components/generation-review.tsx#L64)

真实历史已展示这个边界：报名 v11 的目标为 `B01/B02/B03/B04/B05`；v15 为 `B01/B03/B05/B06/B07`，原独立“邮箱格式错误”B02 被移出目标，旧 B05 从“搜索筛选及持久化”变成“确认状态切换并持久化”。因此 v15 的 5/5 不能单独证明邮箱校验仍然正常。历史独立浏览器记录确实补测了非法邮箱，但那是另外的证据。[v11 计划与检查](../artifacts/dev-13-2026-09-23/public-a-mod1-e1e1d3a9.json)、[v15 计划](../artifacts/dev-14-2026-09-23/public-a-final-pass.json#L21)、[独立补验记录](../docs/test-runs/2026-09-23-finalization.md#L71)

建议最小改法与验收口径：

1. 服务端保留完整需求清单和已接受 required 契约，新增不能悄悄挤掉旧要求或重新利用旧 ID 改变含义。明确修改既有要求时记录替代关系；纯视觉修改不得删除功能契约。
2. 用户已确认产品采用五个固定验收组、完整子检查。保留原子BehaviorTarget并增加group引用，由服务端聚合组结果；每个required子项完整唯一归属，未实现该映射前不得把报告分组冒充产品5/5。
3. 新Check显示真实五组及子项明细，原始JSON完整保留；取消平铺叶子最多五项的误限。旧无groups的Check仍按原始N/N显示历史格式，不倒填新覆盖。
4. 确定性测试：旧计划至少三项 required；让新计划保留一项、删除一项、把另一项 ID 改义，必须拒绝。视觉增量后所有旧功能子断言仍运行并通过。新增要求不能仅出现在 changeSummary 而没有可执行验收。

## 3. 贪吃蛇对当前 Reviewer 的具体挑战

| 当前能力 | 源码 | 影响与最小改进 |
|---|---|---|
| `browser_press` 只允许 Enter/Tab/Escape/ArrowDown/ArrowUp | [reviewer.ts:89](../apps/api/src/runtime/reviewer.ts#L89)、[browser.ts:26](../apps/api/src/runtime/browser.ts#L26) | 左右方向键、空格暂停无法操作。两层白名单一起补四向键与 Space；计算器若承诺键盘输入，应同步支持必要的数字/运算/Backspace |
| DOM snapshot + body text | [browser.ts:118](../apps/api/src/runtime/browser.ts#L118) | Canvas 蛇头、食物、路径通常不在 DOM，不能从分数文本推定画布行为正确 |
| 截图保存后只返回 artifactId/mime/hash 文本 | [reviewer.ts:375](../apps/api/src/runtime/reviewer.ts#L375) | 模型未看到截图像素，systemPrompt 也明确说 DOM-only，不得声称视觉理解。[reviewer.ts:262](../apps/api/src/runtime/reviewer.ts#L262) |
| 无 wait/定时动作工具 | [reviewer.ts:73](../apps/api/src/runtime/reviewer.ts#L73) | 蛇持续运动，而模型两轮请求之间可能耗时数秒，无法把随机等待当可靠控制。需受控、有上限的等待后观察，必要时一次有界键序列及各步截图/观察，受同一取消和时间预算约束 |

补测不应要求生成应用提供测试专用加分、跳步、修改蛇坐标按钮。正常开始/暂停/重开、正常键盘控制和可访问分数/状态属于合理游戏 UI；作弊接口不是。

若产品内部 Reviewer 要验收纯 Canvas 动态行为，应让截图作为 image content 进入真实支持图像的模型，且绑定当前 observation/revision；还需要实际按键和时间序列。若本轮不补图像能力，必须如实将相关内部目标记为 blocked，由独立浏览器实操补充视觉证据，不能把源码推断或“有截图文件”伪装成产品 5/5。若正常生成采用 DOM 棋盘，则仍需要真实键盘/时序验证，不能预置棋盘状态替代操作。

## 4. 新浏览器、重登和隔离：旧证据够到哪里

已有证据：

- dev07 公网 UI 报告记录登录/刷新/退出、重登后项目/版本/源码一致、预览恢复以及跨版本 localStorage 隔离。这是历史版本的报告，不能自动覆盖这次新增项目和新代码。[public-acceptance.md:24](../artifacts/dev-07-2026-09-23/public-acceptance.md#L24)
- dev13 公网只读记录验证另一 owner/匿名访问项目、run、源码、Check、SSE、截图被拒；用新 HTTP token 退出重登后 messages/revision/hash 不变。记录自己明确标注 **HTTP_ONLY，不是新浏览器 UI 持久化验收**。[public-readonly.json](../artifacts/dev-13-2026-09-23/public-readonly.json)
- 最终 dev14 只读补证覆盖两份源码与 manifest hash、SSE 及 B 对 manifest/source/SSE 的 404，明确不覆盖 UI 或模型。[最终只读补证:11](../artifacts/dev-14-2026-09-23/public-final-passed-readonly.json#L11)
- 读取项目快照的 SQL 对项目、messages、currentRevision、候选和 sandbox 绑定 owner；这是隔离实现依据，不替代浏览器实测。[data/generation.ts:311](../apps/api/src/data/generation.ts#L311)

需重点复核的 Preview 边界：

- 平台退出清空草稿、终止请求并调用 Supabase signOut；没有在该路径调用预览撤销。[api-workspace.ts:148](../apps/web/src/lib/api-workspace.ts#L148)
- 临时预览的 `/enter/:capability` 不检查平台登录，只校验当前版本的能力值与 TTL，随后设置独立域 Cookie；后续文件请求只检查这个 Cookie。entry 绑定 owner，但 HTTP 服务过程不绑定当前登录 session。[preview.ts:64](../apps/api/src/generation/preview.ts#L64)
- 这是可执行的风险假设：A 打开私有 Preview 后退出、在同一浏览器登录 B，旧预览 Cookie 仍可能在 TTL 内被接受；知道完整 enter URL 的新会话也可能进入。**本报告未实测生产，不将它写成已验证泄漏。** 普通未知 UUID 403/404 并不能证明这条路径安全。

建议最小修复是把私有预览授权绑定 `owner + auth session + revision`，独立生成可撤销的 grant；平台退出或身份切换时服务端撤销该 session 的 grants，下一次 HTML/资源请求拒绝旧 grant；有效 A 会话从工作台重新打开可以获得新 grant。不宜只清 iframe，也不宜把所有 A 用户会话全局下线。授权仍需独立来源，不能把平台 Bearer token 放进 URL 或转发给生成应用。

确定性断言：

| 场景 | 项目/对话/源码/版本 | 临时 Preview | 正式发布 |
|---|---|---|---|
| A 的全新空浏览器会话，先不登录 | 不可读取 | 无 grant 不可读取 | 公共地址可匿名读取 |
| 同一新会话登录 A | 与服务端基线逐项一致 | 从工作台打开正确 revision，过期可从源码恢复 | 已发布版本可访问 |
| A 退出后刷新旧工作台/回退历史页 | 无私有内容，接口拒绝 | 旧入口、Cookie、HTML、JS、marker 的新请求均被拒绝 | 仍可匿名读取，是预期行为 |
| 同浏览器登录 B；另一独立 B 会话 | 列表不含 A；手工直达 A IDs 不返回内容 | 不能继承 A grant；旧 enter URL 不得重新赋予访问 | 公共地址可访问，不判为隔离失败 |
| A 重新登录 | 同项目、完整消息、全部历史版本/源码 hash 不变 | 新 grant 可用，绑定所选版本 | 不因登录切换更改发布版本 |

浏览器已下载的代码和 localStorage 不可能通过退出“远程抹掉”；验收的是退出后的平台私有 UI 和**新的网络访问**。生成应用的 localStorage 是对应浏览器与 origin 的数据；新浏览器为空、新 revision origin 为空不是平台项目/源码丢失。[publication.md:9](../docs/test-runs/2026-09-23-publication.md#L9)

账号资源约束：用户此前要求清理生产，旧 B 账号及其部分项目已经删除。旧工件只能作为历史记录，不能再以旧 B 账号可登录作为补测前提。本次研究没有新建账号。实际补测应在与生产同构的隔离环境准备临时 B，使用精确 manifest 清理；如确需在生产测，同样仅临时 B 和合成数据，结束恢复只保留 A，不能清理 A 的正式提交作品。

## 5. 建议一次完成的补测流程

### 5.1 先固定应用行为与五个复核分组

推荐计算器 Prompt：中文基础计算器，支持数字、小数、加减乘除、清空、退格、等号，除零给明确错误并可恢复；正常按钮交互。若承诺键盘操作，同步加入具体按键测试。明确是否支持运算符优先级，避免把未约定的连续运算规则当失败。

推荐贪吃蛇 Prompt：键盘四向控制、开始、暂停/继续、得分、吃食增长、碰墙结束、重新开始，显示操作说明。不要靠“没有方向键所以测试触屏按钮”绕过四向键盘要求。随机食物只通过实际观察和真实移动吃到，不使用修改 store/注入脚本。

计算器在原项目追加两轮：

1. 功能：增加历史记录，记录算式与结果，能从历史重用结果；保留全部原算术/错误/清空/退格行为。
2. 视觉：改成明确深色主题和 390px 可用布局，保持第 0、1 轮功能；若选择字段修改，记录字段语义和旧输入处理，不仅换标签。

每轮报告使用以下五组，组内每条实际断言通过才能将该组记为 PASS：

| 分组 | 明确验收内容 |
|---|---|
| 1. 真实执行与请求绑定 | 新/同项目约束、原始 Prompt、实际 provider/model 调用与角色事件、无 fixture、正确 baseRevisionId |
| 2. 目标功能与旧功能 | 本轮新增的真实操作结果 + 所有先前必需行为，清晰列出输入和期望；Snake 包括方向/吃食/碰撞/暂停/重开 |
| 3. 源码与构建差异 | 相邻版本全量 manifest/hash 和可读 diff；修改落在实际业务文件；可信 tsc/build；没有只改标题或硬编码输出 |
| 4. Preview 与检查一致 | 当前 revisionId/sourceHash = 所选源码 = Check binding = `pivloom-revision.json`；iframe 和新标签均可操作；原始 Check N/N 不篡改 |
| 5. 持久化、界面与回归 | 平台刷新/干净浏览器/重登后相同项目、消息、源码和版本；视觉轮窄屏/配色实测；账号隔离矩阵另关联具体用例 |

用户后续明确选择固定五组及完整子检查。此表作为复核覆盖维度，产品五组按应用业务分组并由服务端聚合原子检查；具体约定以新版技术方案/E2E为准，不能只改总分显示。

### 5.2 每个版本保存统一核对元组

`projectId / runId / baseRevisionId / revisionId / revisionNo / sourceHash / checkId / previewMarker / modelProfileVersion / deploymentSHA`。

每轮下载所有源文件作真实 diff，至少人工读业务入口及样式；hash 变化本身不证明功能新增。界面截图、source diff、原始 Check、独立浏览器操作结果都引用该元组。运行中刷新要确认同 Run 继续，不新增提交。

### 5.3 顺序与停止条件

1. 先补键盘/Canvas检查能力与旧契约保留机制，先用小型受控浏览器能力探针确认按键、等待、截图链路；探针不计入真实模型生成验收。
2. 计算器与贪吃蛇各从空项目真实生成；在计算器项目完成上述两轮增量，不复用以前的报名和书单作为替代。
3. 对最终三个计算器版本做独立浏览器回归和源码核对；在最终版本跑干净会话、退出重登及 A/B 隔离全矩阵。
4. 一项失败就保存当轮 Run/版本及诊断，不人为修改通过结论；修复后仅重跑受影响模块和最后整条主路径。

整体通过标准：两种新项目真实生成；计算器两轮增量可证明；全部旧功能子断言保持；每轮源码/Preview/Check/版本一致；干净会话与重登恢复平台数据；A/B 私有数据和临时 Preview 隔离；可选正式发布仍公开可访问。源码核查和旧记录不应提前升级为这轮实测 PASS。
