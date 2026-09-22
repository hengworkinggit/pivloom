# DEV-06 Reviewer 实施与验收

对应 #7，基线 `964abd5abfebad921ec9fdf7fc737f623c8862f1` 加工作区修改。**实施中，尚未完成模块验收。** 开发 API 已部署本票工作区构建，真实模型与内置浏览器 E2E 正在执行；fixture 与数据库测试单独计数。

## 实施边界

Reviewer 使用独立 Pi session，只获得不可变源码读取、受控浏览器与提交报告工具。计划中的每个行为都必须有对应条目；通过或失败条目引用的观察 UUID 必须由本次工具操作产生，并绑定行为。它们是检查记录中的 observation event ID，不是十进制 SSE cursor。仅打开页面、标题或截图不构成行为通过。

服务端在检查前后核对私有源码对象、远程源码 hash 与预览 marker，关闭 Chrome 后颁发不可由报告 JSON 伪造的内部 receipt。数据库再校验 owner、run、role、attempt、revision、sourceHash、sandbox、browser session 与预期 current，原子保存检查并决定是否切换版本。截图存入原有私有 Storage，经身份鉴权代理读取；不向页面返回对象 key 或控制面凭据。

## 已执行的边界检查

- 实际 Pi 执行循环、外部模型 SSE / 浏览器协议 fixture：15 项通过。覆盖伪造观察、标题不能算通过、禁止写工具、隐藏推理、页面异常、Chrome 关闭确认、错误类型、共享 token 预算、整体 90 秒截止与事件保存结束后不得新发浏览器调用。最后一项先 RED 后 GREEN；不是实际模型自行识别邮件缺陷的证据。
- 截图对象存储 fixture：2 项通过，含 owner/hash 校验和上传期间取消后不再发读回请求。Reviewer / Workspace / Browser / 截图 / orchestration 本轮相关 48 项通过，API typecheck、lint、build 通过。
- 真实 PostgreSQL/Storage 测试覆盖 queued handoff、blocked/failed/passed finalize、7 个绑定字段错配、旧 attempt、取消/截止、current 变化、build 未通过、伪造 receipt、事务回滚、A/B 隔离和真实私有截图存取；4 项完整套件通过（454.25 秒）。补充键盘 Enter 证据从 RED 到 GREEN（116.91 秒）；fixture 项目、Run、lease、对象均精确清理。模型/沙箱传输在这些测试中使用 fixture，不代替真实 E2E。详见 [结构化记录](../artifacts/dev-06-2026-09-22/review-persistence.json)。
- 截止修复后 API 全套 180 PASS / 27 opt-in skipped；Web 65 PASS，类型、lint、build 通过。skipped 不算真实集成通过。
- `006_review.sql` 已应用于开发数据库。Standards 与 Spec 双轴复查的原 deadline、键盘证据、报告大小、错误类型和候选标签问题均已修复；最终代码复查各 0 项剩余问题。真实 E2E 门槛仍独立保留。

## 开发环境部署

2026-09-22 17:57，单一 API 服务切换至 `/opt/pivloom/api-releases/20260922-dev06-01`。构建 archive SHA-256 为 `9b4f0049ab3e8ac82f275a6c12f7a27f487d577747c06268bc9de771026a06d7`，详细编译文件 hash 见 [构建记录](../artifacts/dev-06-2026-09-22/api-build.json)。boot ID `3fb56d98-e906-45cd-8bd1-f48174a80140`，ready 与原网站 200。迁移后仍只有一个常驻 API；未更改 Caddy 或公网站点。

独立 IAB 标签 30 在项目 `3c866a6a-26e9-4af4-89d4-d84127b7d430` 原样输入需求 A，启动 Run `b3418824-1d24-4540-8f15-f0bb1cc967c5`。当前为真实验收执行中，不计 PASS。

## 未完成门槛

真实三角色活动报名/读书清单、Codex 内置浏览器独立行为复测、私有截图 HTTP 隔离、真实资源清理均须按 #7 完成后才提交并关闭 issue。

前票 R12 的不实邮件承诺仍是未检查候选缺陷；本票不能把保存源码、构建成功或生成模型的自述当作它已被修复或验收通过。

## 首次真实三角色验收：FAIL，正在校准

需求 A 第一次 Run `b3418824-1d24-4540-8f15-f0bb1cc967c5` 已结束为 `TOKEN_BUDGET_EXCEEDED`，current 为空、无 Check，沙箱 destroyed / cleanup confirmed。Coordinator 2 次请求 / 5,313 total tokens；Builder 6 次 / 27,511；Reviewer 3 次 / 17,882。在已报告累计 50,706 后，下一请求的保守预留超过原 60,000 限制，因此没有继续调用。Reviewer 实际执行 3 次 source_read、browser_open 和 browser_click，不声称已完成五项行为。

Codex IAB 在独立用户 iframe 的空提交触发“请输入姓名/邮箱”，无记录新增；后续操作因失败任务回收预览而无法继续，E05 不计通过。完整记录见 browser-state.json 的 activity-token-budget-failure。没有调小需求、放宽通过标准或使用 Mock。

依据 TRD 12.4 / PRD 初始预算实测校准条款，下一构建改为每 Run 200,000 token、每 Reviewer attempt 最多 300 秒，保留每次模型请求 90 秒、单浏览器动作 15 秒、Run 600 秒与总工具 80 次硬上限。原始失败与旧构建 hash 保留；新构建及复测结果另行记录。校准值只有复测完成后才能称为适用。

复测构建 `20260922-dev06-02`：archive SHA-256 `0c21eb5d463c21de9146956c22e1d5fb00a826b78ae048eb0125d039471d867d`，boot `431819fe-5893-476b-94a2-67ba586c472d`。18:08 通过 IAB 在原项目再次提交同一需求，Run `c5800e8d-5313-4c98-8c8e-7106c071ea02`，未通过接口代发 UI 操作。预算专项 62 项通过，新增默认硬上限测试先 RED 后 GREEN；检查超时和 typed-error 专项 18 项通过。

第二次 A 仍为 FAIL：Reviewer 17 次模型请求 / 19 次工具调用 / 208.394 秒，报告 total 163,694 tokens；加 Coordinator 4,291 和 Builder 20,804，累计 188,789 后下一请求预留拒绝。独立 IAB 已通过 E05 的空/错邮箱、三条新增、确认、搜索与同来源刷新，但产品 Check 尚无，故整票不通过。390px 尚未验证：浏览器 viewport 调用未改变目标标签的实测 1006px 宽度，随后失败任务回收预览。

下一修复保持 200,000 上限，压缩发给模型的历史观察：保留事件 ID、行为、动作和短文本，只有最新观察携带完整 tree/refs；服务端保存的完整证据不变。新增真实 Pi/外部 HTTP fixture 先 RED 后 GREEN，验证 wire 历史压缩且最终 evidence 不丢失。尚待新构建真实复测。

压缩构建 `20260922-dev06-03`：archive SHA-256 `831234d4837770bd10bb168a7be0b41483bec70dec6f4e8ffbf03d8927acb117`，boot `060fa1a0-f11e-42d5-ab41-fddf6e1aa124`。19 项 Reviewer/orchestration 回归、API typecheck/lint/build 通过；双轴增量复查无新增问题。新读书项目 `87659d66-3557-4d35-b15f-48f54d0862ce` 通过 IAB tab31 原样发送需求 B。该标签实测 390px 且 scrollWidth=390，视口控制可用于此标签的后续窄屏验收；不追认此前 tab30 尺寸测量通过。

第三次（需求 B）Run `e2d72481-79ba-4660-a1d4-0df43aab2dac` 仍为 FAIL：累计 190,231 total tokens 后下一请求预留拒绝；Reviewer 17 次请求 / 19 次工具 / 227.321 秒，没有 Check，current 为空。仅移除旧 tree 不足以限制不断增长的对话开销。最新修复将 provider 工作上下文限制为完整初始交接、最近两轮工具对话和历史观察索引；完整服务端证据不变，并提供只读 observation_read 按事件 ID 回查。新增 HTTP fixture 先 RED 后 GREEN，Reviewer/orchestration 20 项通过。

独立 IAB 同时发现 B 首次预览出现旧读书项目数据：源码使用固定 localStorage key，所有 revision 共用 localhost:45311 导致跨项目污染。已改为每 revision 独立 origin，严格 Host/path/capability 绑定。合成来源夹具在 IAB 中证实两个 *.localhost iframe 的同名 localStorage 相互隔离、刷新持久，host-only None/Secure cookie 可用；这仅为能力探针，不冒充产品 E2E。

新构建 `20260922-dev06-04` archive SHA-256 `d0edf5215797a211fe35ac729ba3de6e8221d025db78dd3b6d6a2cf862f2a14a`，boot `d2786db9-be02-458e-a786-12687bd46db4`。全 API 188 PASS / 27 opt-in skipped，build 通过；切换前活动 run/待回收 sandbox 均为 0，ready 与原网站最终响应 200。IAB tab34 原样输入需求 A，Run `2e761047-f906-4f80-8501-1d1d4df35fb7`。增量 Spec 复查 0 项；Standards 复查发现 Next frame-src 尚未允许 revision 子域，修复中。当前仍不计真实验收通过。

上述 A Run 在保存阶段结束为 `INVALID_SOURCE`，没有新 revision/Check；沙箱已销毁、操作锁已释放。该次未执行 Reviewer，不能证明工作上下文修复效果，也不将其归因于已修复的预算问题。由于旧源码校验只返回总括错误且失败源码未保存，正在补不含内容/路径/凭据的静态拒绝原因，保留原拒绝规则。前端 CSP 子域漏配已 RED→GREEN（3 个配置响应测试），实际 localhost 响应确认为 `frame-src 'self' http://*.localhost:45311`。

诊断构建 `20260922-dev06-05` archive SHA-256 `50555a2cb67f5e6520bf68805cb9f9e694f570035810c3115572b0b0c697232a`，boot `9532c39f-c979-4b69-95ee-d578c12e51a4`。保留 INVALID_SOURCE 和所有拒绝条件，仅增加静态原因标签；不输出源码、路径或凭据。18:53 IAB tab31 在原书单项目原样提交需求 B，Run `89a94525-b34f-487e-bd02-a73cc04ad111`。Web 全套 68 PASS、lint/build 通过，Next 响应级 CSP 3 PASS。

需求 B Run `89a94525-b34f-487e-bd02-a73cc04ad111` 已结束为 CHECK_BLOCKED / check `ab3ba090-4b0e-4e08-93eb-3067be1cb433`，原因是 Reviewer 5 分钟截止（18 次模型请求、22 次工具），不是 token 预算错误。current 仍为空，所有行为诚实标为受阻。独立 IAB 对 revision `78e52067-b882-430a-be2b-da2857f70cf3` 已验证初始为空、书名必填、两条新增、已读/未读/全部筛选、总数2/已读1、同来源刷新持久；外层390/scrollWidth390，应用370/scrollWidth370；index.html与App.tsx实际代码可读。窄屏截图在当前会话 19:00 前后的 IAB screenshot 调用，未编造本地文件。受阻详情可展开，但此轮没有成功 Check 或截图工件，不计模块通过。

修复版 `20260922-dev06-06`：新增已验证行为草稿记忆，所有行为齐备时仍经完整报告、日志、版本与关闭门槛提交；受控 browser_form 最多4字段+显式提交，每步重新观察、唯一具名控件绑定、记录证据、扣动作预算，截断/歧义/取消立即停止，不重放整批。修复错误日志被后续空日志清除的问题。Coordinator 说明实际浏览器能力，初始空态在首开测试、持久化通过刷新测试，不要求未提供的手动清存储等操作。新用例先 RED 后 GREEN，相关52项通过，typecheck/lint/build通过；双轴复查闭合截断引用问题。archive SHA-256 `1dac2413e9aa48be0cb6ee02e853d8bea43774734bf2d368fbce5bb1e7139a32`，boot `a008bd12-3ab1-4b10-87da-9cd87347c1ec`；切换前活动任务/沙箱均为0。开始原样需求A复测。

该构建后全 API 回归 199 PASS / 27 opt-in skipped（23 files通过、5 files跳过）；这些 skipped 不算集成验收。A 新 Run 为 `1ddb533f-4955-4fd7-a14d-a1d2d5a197b4`，19:15 从 IAB tab34 发起。

A Run `1ddb533f-4955-4fd7-a14d-a1d2d5a197b4` 于 19:20 结束为 `AGENT_OUTPUT_INVALID`，current 为空、无 Check；角色活动显示两次 record_behavior 之间仅新增截图，未有业务交互。静态审查发现计划 B01 只有打开/查看初始态，与“仅 open/截图不构成通过”约束不相容；不就地修改已持久化计划、不为通过添加无意义点击。沙箱销毁、lease 释放、operation 清除已由只读采集确认。新规划将初始态合入原需求已有的有意义交互，保留全部要求；26 项 Coordinator/规划契约回归通过。另补受控 reload 的行为证据绑定与可纠正的静态拒绝原因，未降低检查标准。

刷新证据联调先 RED：真实 PostgreSQL 路径拒绝原 evidence action 枚举外的 reload，补枚举后 GREEN（182.05 秒，含真实私有 Storage 和精确清理）。外部模型/浏览器为协议 fixture，详见 review-persistence.json。API 全套 212 PASS / 28 opt-in skipped，typecheck/lint/build 通过；Reviewer 专项38 PASS。Spec 复查发现 reload 丢 URL hash，修复与测试 RED→GREEN，复查闭合。Standards 无新增问题，首开/标题/截图不能算通过的约束保留，错误反馈只包含固定原因码和白名单路径。

07 构建已就绪但尚未发起真实生成，因 hash 路由修正由08替代。实际复测构建 `20260922-dev06-08`：archive SHA-256 `40bee4bfca9fcc0761654a9eab0e66f223f4f9e806184f2fbbfc55ced8f0b084`，boot `af8ab50d-1a1b-44e4-ace5-ab304a4f6ae9`。与07的五个 package/lock 文件逐一相同，部署复制其已安装依赖到独立08目录，编译文件来自08归档；未修改07。切换前活动 Run/沙箱为0，ready、原网站均200。19:38 IAB tab34 原样提交需求A，不通过API代发。

08 真实A Run `c3950836-b862-4060-84dc-114af0836ba4` 在19:43:07结束为 CHECK_BLOCKED，Check记录5项受阻、current为空；不是token或5分钟截止。IAB独立对revision `897dc019-44b7-4a2c-b732-86c022aec159` 验证空/错邮箱、3条新增、确认田禾、姓名/邮箱搜索、清空搜索、刷新保留，读取 index.html/App.tsx；桌面1280无横溢，手机390/iframe370均无横溢且报告可展开。独立业务通过与产品Reviewer受阻分开记录，不计整票通过。

本次原始工具参数和观察未随异常保存，不能追认其具体参数。独立诊断Chrome在同一候选上确定复现兼容缺陷：agent-browser0.38.1返回 `[level=1, ref=e4]`、`[expanded=false, ref=e10]` 等合法引用格式，RemoteBrowser仅检测完整 `[ref=eN]` 子串，因而把这些refs丢弃并标记truncated；完整性保护随后拒绝browser_form。正在修复成员检测并在同一真实候选复验。另将执行前schema错误与动作结果未知的浏览器故障区分，并保存有限静态原因；不回显原参数或秘密。

同一真实候选的独立远端Chrome诊断已完成 RED→GREEN：修复前首开与空提交均错误truncated=true；修复后新独立session，open→空提交→填写姓名/邮箱→选择开发→提交，六次观察均truncated=false，合法refs保留，产生synthetic待确认记录。未部署到旧08 API、未改原Run/Check/current或源码；诊断会话关闭已确认。证据见 activity-form-ref-before.json / activity-form-ref-fix.json。该诊断不冒充真实三角色完整验收。

新修复全API 227 PASS / 28 opt-in skipped，typecheck/lint/build通过；Browser22、Reviewer45、receipt9项通过，相关新用例先RED后GREEN。浏览器工具参数在任何动作前的schema拒绝可按静态字段路径纠正；未知执行结果仍终止且不重放。受阻结果使用白名单中文原因，未知原因不回显原message/args。09构建 archive SHA-256 `dcbc82dceb717dd055865f51c30f203cd74821b480e2e5450f5bd6ed4cabaa15`，等待正式A/B复测。

09 的两次 A Run `877ea6a1-1767-4493-87d6-d6c5b63b5213`、`b4f591ed-03ef-484d-8271-383bc1b82017` 均在 Coordinator 第二次模型请求达到 90 秒截止，未进入 Builder / Reviewer，未创建新 revision / Check / sandbox；current 为空，lease 与 operation 已释放。独立 Coordinator 诊断使用相同持久化规划上下文，三次请求在 84.565 秒内提交有效五行为计划；只保存 SSE 计数和耗时，不保存思考内容。它证实当前模型仍返回 thinking，但不能证明此前超时的唯一原因。见 coordinator-stream-diagnostic.json。

2026-09-22 的严格两请求 wire 对照排除旧 developer-role 混杂：两次均 system role、无 store、maxTokens512，实际请求仅第二次增加 `thinking:{type:'disabled'}`。baseline HTTP200 / 8.278秒，工具参数正确；disabled HTTP400 / 1.266秒，InvalidParameter 明确说明该模型不支持 disabled。没有添加不受支持的生产适配、修改模型配置或提高超时；临时 lease 精确释放且残留0。见 ark-thinking-wire-comparison.json。随后在09原构建通过 IAB 再次原样提交需求A；完整验收仍未通过。
