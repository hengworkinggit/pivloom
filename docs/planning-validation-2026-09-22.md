# DEV-05 协调者计划与澄清验收

对应 [#6](https://github.com/hengworkinggit/pivloom/issues/6)，基线 `1d9312ae06d668f39072a5d3f6219b179a874f51` 加本模块修改。**DEV-05 Coordinator → Builder 子集验收通过；下文保留失败与修复过程，最终结果见文末。** 真实 Reviewer 和 current 晋升仍属于 #7；未宣称完整应用验收通过。

## 已执行的公共边界回归

- `npm run test --workspace @pivloom/api -- tests/runtime/candidate.test.ts`：13 PASS。新增澄清交接回归先 RED（供应商请求仅含简短回答，缺原始需求），接入已保存 Handoff 后 GREEN；大于 8000 字的受控交接上下文可传递，但公开用户输入仍限制 1–8000 字。
- 另两项先 RED（其他 Run 或 Coordinator 目标的交接竟进入 candidate），修复后在创建沙箱前返回 INVALID_HANDOFF；外部远端命令和模型请求均为 0。
- 上述测试使用真实 Pi/candidate/build gate/快照代码，供应商响应与远端进程/文件是明确 fixture，不声称真实模型生成或远端编译。
- root 改动的 executor/candidate/service 与 candidate 测试文件 ESLint PASS；最终全仓检查和双轴审查仍待模块实现收口。

## 独立浏览器项目

通过 Codex 内置浏览器创建澄清项目 `ad77eba7-92c6-433a-a267-62eeab61f17a`，需求为奖金计算页面、公式未提供且要求先确认业务规则。页面保存项目后未点击发送；真实 API/Postgres 读回确认 0 Run、0 消息、0 角色、0 版本、0 沙箱。[准备状态](../artifacts/dev-05-2026-09-22/browser-state.json)。

待执行：E29 真模型澄清与回答关联新 Run、范围外能力说明；E21 新建的 Coordinator/Builder 实际独立 session 与持久交接；E26 桌面/390px/键盘回答；I08 非法 schema、重复/旧 attempt、权限拒绝和资源释放的真实集成断言。NOT_RUN 均不计为通过。

## 14:02 回归与复查进度

全量 Web 测试 51 PASS（11 个文件），Web typecheck、lint 与 diff 格式检查通过。此时 API 实例仍运行上一模块，尚未把新模块的编译成功算作在线验收；独立读回本票项目仍为 0 Run / 0 消息 / 0 角色 / 0 版本 / 0 沙箱。

Standards 复查提出 1 个 P2：新增 Coordinator 未与 Builder 共用每 Run 60,000 token 的请求前预留及 usage 结算预算，正在修复。Spec 独立复查 0 项新代码问题；真实 E29 / E21 / E26 仍待执行。这两项复查不替代 E2E，也不表示本票完成。

## 第一轮真实澄清：FAIL，保留失败记录

API boot `7849827c-8ce8-43f8-b403-ab9531b4b33a`，使用已编译的 #6 工作区版本、既有页面模型配置 v1（Ark `glm-5.3-flash`）。实际编译 JS 哈希见 [首次 API 版本](../artifacts/dev-05-2026-09-22/clarification-api-build.json)。此版本已有共享预算，但后续失败用量持久化修正尚未包含；不与最终版本混称。

Codex 内置浏览器在原项目点击发送缺少奖金公式的需求，接受 Run `1c8b5434-9d78-41f7-a302-7e2c9784b8d2`。页面真实显示 Coordinator、project_summary 和 request_clarification 工具活动，随后任务以 `AGENT_OUTPUT_INVALID` 结束，未出现可回答的问题。服务保存了 1 Run / 2 消息 / 1 Coordinator / 12 事件，0 版本、0 沙箱。记录为真实 FAIL，正在排查工具参数契约兼容；没有以 fixture 的通过结果替代，也没有人工补写模型问题。

全量 API 当时 113 PASS / 21 opt-in skipped，lint / typecheck / build 通过；默认跳过不计入真实环境通过数。随后候选失败用量回归为 15 PASS，其中新增共享预算 1 token 的用例先 RED（仍生成 candidate）再 GREEN（0 新模型调用且沙箱清理），超过预算后保留实际已知 usage 的用例通过。这里的预算回归是实际 Pi + 外部 fixture，与本节真实模型失败分别计量。

## 14:25 修正与最终版本复测准备

确认并修复模型侧工具声明未提供 question / plan 实际字段的契约缺口：由同一 Zod schema 生成完整 provider 声明，服务端仍在 execute 内验证并累计最多一次纠正。实际 Pi 的 outbound HTTP fixture 检查完整字段、required / nested schema、合法计划和问题、连续两个空参数即停止均通过。原在线参数没有留存，不能声称已证明当时 Ark 返回空对象。

共享预算覆盖所有角色请求、纠正及缓存 token；失败/中止保留预留，已知用量穿过 RuntimeError → candidate/executor → finishFailed 的同一事务保存。真实 DB RED→GREEN 验证错误 owner/run/attempt 不得写入、事务失败回滚、nullable usage 保留、已成功角色用量不覆盖。[定点真实集成记录](../artifacts/dev-05-2026-09-22/planning-integration.json) 分别记载每个 fixture 的边界、执行命令和精确清理；未将多次定点运行写成整文件一次全通过。

修正后的 API 全量测试 118 PASS / 22 opt-in skipped；API lint、typecheck、build 和 Web 51 tests / lint / typecheck / build 均通过。Standards 原 P2（含失败用量记录）已解决，新增问题 0。该轮复测 boot `0f52dd90-7996-4592-af53-a3acb82e761b`，源码摘要见 [该轮构建源文件哈希](../artifacts/dev-05-2026-09-22/multiple-question-build.json)。真实 E29 复测从内置浏览器再次发送原需求，未以编译或 fixture 成绩替代 UI 结果。

第二次 Run `56681ede-713c-4a38-b7d3-4787c0e0f7e4` 已真实到达 `needs_input`，单 Coordinator succeeded、无 sandbox，问题和回答输入框均显示，操作与凭据租约释放。但问题字符串同时包含公式、输入范围、舍入、历史/导出四项，违反单关键问题要求，因此 E29 仍为 FAIL。保留该问题及历史读取，新提交将使用更严格的单问题契约，再从新项目 `22af7d75-9779-4437-b85b-c43ba1cd60c6` 用同一原需求复测。

独立 Spec 复查新增 1 项 P2：虽然预算与失败用量已保存，usage JSON 缺 TRD 9.1 要求的调用次数、缓存明细、耗时、来源及共享 schema。正在补齐标准存储形状与运行时测量；不会为未知 token 填 0，历史 JSON 不批量重写。

## 单问题真实复测与手机回答

进一步修正后，API 全量 123 PASS / 22 opt-in skipped，API typecheck / lint / build 通过；runtime 66 项、候选 15 项包含在该全量结果中，不叠加计数。新规范用量和四个写入口的真实 DB 定点用例通过（106.45 秒），2 项目 / 2 Run / 2 lease 清理为 0。独立 Spec 增量确认用量 P2 已解决。

当前 API boot `d11551c2-a634-4df6-ae09-ca18fc804e33`，新项目 `22af7d75-9779-4437-b85b-c43ba1cd60c6` 的 Run `24961b5a-1204-4647-bf3b-629501519170` 真实生成了一个关于奖金计算公式的关键问题；没有再问舍入、历史或导出选项。浏览器显示 Coordinator 已完成、任务已结束、回答输入可用。服务端读回 `needs_input` / operation=null / 0 sandbox，模型 lease 在 `2026-09-22T06:42:18.464Z` 释放。

实际持久化规范 usage：modelCalls=2、toolCalls=2、inputTokens=1346、outputTokens=859、totalTokens=3293、cachedTokens=null、source=partial、elapsedMs=73188.666875。部分缓存明细不可确认时保持 null，不能用 total 与输入输出的差额冒充完整 cache 来源。

Codex 内置浏览器视口设为 390×844，DOM 实测 innerWidth=scrollWidth=390，回答框可访问名称为“回答澄清问题”。填写中文销售额整千计奖公式、计算/清空按钮、当前浏览器保存和演示限制后按 Enter，实际接受新的 Run `b36a307d…`；原需求、原问题和回答继续在对话中显示。完整 parent/交接及生成结果读回仍在进行，尚未把回答已接受当作 Builder 已通过。

## 14:55 回答链路结果与基础验证收口

Run `b36a307d-f61b-429b-83f8-d020ae6bd9df` 的 Coordinator 成功保存计划，Builder 使用不同 session 接受包含原需求、问题和回答的持久交接并进入远程沙箱执行。随后触发既定 10 分钟上限，以 `RUN_TIMEOUT` 失败。Codex 内置浏览器实际显示“本次生成超过 10 分钟，已停止”，无候选版本与预览，故完整生成验收为 **FAIL**，不能只以交接成功宣称本票通过。

14:55 真实 API/Postgres 读回：该项目共 2 Run / 3 role / 0 revision，沙箱记录为 destroyed；远端容器列表也无遗留沙箱。原始失败及清理结果保留于 `browser-state.json` 的 `reply-terminal-foundation-check` 记录。没有提高超时、手工补写生成应用或用 fixture 替代结果。

实际计划将用户明确要求的浏览器保存行为误标为可选。Coordinator 源码已补充“明确要求的可观察行为必须 required=true”的规则，现有 Coordinator 24 项回归通过，但此改动尚未进入本次在线 API；语义效果仍待后续真实生成验证。

用户本轮要求收口基础验证后再恢复目标，因此不启动新的生成或后续模块。基础设施已有独立通过记录，足够支持继续开发；#6 仍保持进行中，正常新建流程、回答后的完整生成与行为验收尚未完成。超时的具体耗时原因仍待定位。

## 15:09 恢复目标后的延迟定位与 API 共置

恢复目标后对 R4 的真实事件区间作只读分析：Builder 11 个工具区间累计 200.215 秒，包含持久化等待，不能称为模型或远端命令净耗时。源码链路显示每次工具执行前后都等待多个串行数据库/沙箱请求，详见 [时序分析](../artifacts/dev-05-2026-09-22/runtime-latency-analysis.json)。

只读对照使用完全相同的 `PivloomDatabase.owned → SELECT 1`，保留身份与事务设置：本地 API 到远端 DB 的三个样本为 6355 / 3690 / 2513 ms；同机为 20.02 / 1.67 / 1.09 ms（含各自首连接）。这是连接位置差异的证据，不代表完整生成已成功。分别见 local-db-latency.json / remote-db-latency.json。

因此先部署内部 API 到数据库和沙箱所在服务器，专用非 root 账号、systemd 及未占用的回环 18010/18011；本地前端通过原 45310/45311 SSH 转发继续访问。确认没有活动 Run、R4 已清理后停止旧本地 API，再启动唯一远端 executor。未修改 10 分钟任务上限、90 秒模型请求上限或持久化屏障。模型 Key 仍在数据库密文记录中，运行环境只传基础设施配置及加密主密钥，不传 migration 管理员凭据。

远端 Node 24.13.0，锁定 npm ci 安装 324 个生产包完成；编译包 SHA256 为 `90515b22147e46749b5562983b98f53fc5e224f5a2ba557f47d5893e9205da50`。启动 boot `2af75039-f7ef-4971-9615-1a0019aecd2e`，ready 正常、原网站 200。此构建包含明确请求行为 required=true 提示补充，Coordinator 24 项回归通过。前端浏览器从项目 `9934dbae-035a-45af-a828-64571a3412ef` 提交原范围外报名需求开始实测，结果待后续记录，不能以健康检查替代。

首次共置尝试 `d9f7377a-000e-4f8e-af36-23fd279862d7` 在协调者第二次模型请求期间失败，角色耗时 95.483 秒，公开错误为 GENERATION_FAILED；没有创建沙箱。摘要工具开始/完成的 DB 事件间隔为 9ms。该次原始底层错误未留存，故不能仅凭 90 秒附近的时序断言供应商错误类型。两端 Pi/SDK、锁文件与关键执行代码内容核对一致；缺报汇总为 null 也不表示所有前置请求都没上报 usage。

增加仅输出固定错误代码与 Run/role ID 的临时诊断后，原需求复测 `3c00ec02-d4ef-487a-a4bf-b913f80acbd9` 成功保存计划并由独立 Builder 接受。浏览器明确展示真实收款与跨用户共享属于范围外，模拟流程不会真实扣款。协调者的 schemaVersion 首次无效、一次纠正后通过。后续 Builder 因 TOKEN_BUDGET_EXCEEDED 结束：Coordinator 实报 10130 tokens，Builder 实报 35036 tokens；下一请求的输入估算加最大输出预留不足。0 revision，沙箱 destroyed，不能计为完整生成通过。

该次工具日志暴露宿主临时 cwd 被模型当成沙箱目录访问，随后又花多个轮次探索；工程师还拆出许多很小的类型/校验模块，反复携带上下文。修正只明确真实远程 cwd、既有模板入口、聚合相关小逻辑，并将单轮最大输出从 8192 限到 4096 以对应小步写入；没有提高 60000 总预算。预算缺报/取消回归改为读取真实 outbound 请求上限，断言完整预留不被释放，避免把旧默认数字硬编码成契约。24 项 Pi-budget / candidate 回归通过，构建通过。历次在线编译 JS 指纹见 [部署记录](../artifacts/dev-05-2026-09-22/api-deployments.json)。

boot `03eff461-d35c-446e-a641-24d22c4e0139` 下，同一原始奖金需求在新项目 `50d3e6dd-b6aa-4970-ac74-24706ed33e73` 再次实际生成一个公式问题。Run `af6df6dc-4338-48b4-99cf-be30dd69b057` 为 needs_input、operation=null、0 sandbox，lease 已释放。390px 实测 innerWidth=scrollWidth=390，输入完全相同的销售额规则并点击发送回答，接受新 Run `6243a713-c09d-4588-877f-e799798c80dd`；完整生成与行为测试继续进行。

## 澄清后候选生成及独立行为验证：PASS（DEV-05 子链路）

Run `6243a713-c09d-4588-877f-e799798c80dd` 从 07:24:57.199Z 接受到 07:27:42.641Z 保存候选，共 165.442 秒。Coordinator 与 Builder 独立 session，原需求、单问题、回答包含在持久交接中；本次计划把明确要求的浏览器保存行为列为 required。Coordinator 2 次模型调用、4835 实报总 tokens，Builder 6 次模型调用 / 7 工具、18820 实报总 tokens；不将缓存缺报写成 0。

候选 `0e69a5a3-147f-4d24-ad83-ba217075b192`，sourceHash `a031112d7cef2dcd19276c7fcece19e7b1afae01457c1c5fae7823ff3c29c930`，7 个源文件，可信构建 passed，预览 binding 与 revision/hash 一致。Codex 内置浏览器在真实 iframe 操作 2500→200、999→0、1500→100、清空输入和结果、重新计算 2500 后刷新预览仍恢复 2500/200，均 PASS；代码视图打开该 v1 的 App.tsx，实际展示相同公式和 localStorage 写入/恢复/清空。实际界面截图已在会话输出，逐步记录见 [独立浏览器检查](../artifacts/dev-05-2026-09-22/independent-browser-checks.json)。

这是本票 Coordinator→Builder 与候选行为验收；Run 仍按尚未实现 Reviewer 的约定以 CHECK_BLOCKED 结束，current=null，UI 显示“候选已保存 · 尚未检查”。不冒充完整三角色或正式成功提交。预览保留至既定 TTL，lease 已释放。

## 正常新建范围说明复测：仍未通过

同版 Runtime 在原报名需求再次提交 Run `3c2e736f-5565-4168-80aa-bc45bcd365de`，Coordinator 成功交接但 Builder 第 5 次模型请求以 HTTP 200、接收 4606 字符后 `aborted` 失败，实际该轮 43004ms。当前运行时将包含 abort 的错误映射为 MODEL_REQUEST_TIMEOUT，**这并不能证明请求实际耗满 90 秒**。终态与沙箱/lease 清理均已读回确认，没有候选版本。继续定位，不使用前一奖金场景的通过替代本场景。

移除临时诊断后，API 全量 123 PASS / 22 opt-in skipped，typecheck / lint / build 全通过。源代码无 DEBUG-dev05-role；运行中的服务仍为上述已记录 boot，下一次空闲部署将加载移除诊断的编译版本。

## 收口时的兼容探针与资源清理

使用既有加密配置和短期 lease 的真实 Pi 探针尝试 `thinking: disabled`，首请求 HTTP 400，10.339 秒，无工具调用；因此停止后续请求，未修改生产模型配置或代码。没有记录响应错误正文，不能确定被拒绝的参数，更不能据此认定支持关闭思考或解释前述 43 秒流中断。精确 lease 已释放、活动引用为 0。[脱敏结果](../artifacts/dev-05-2026-09-22/ark-thinking-disabled-probe.json)。

奖金候选预览已按 TTL 销毁，读回 sandbox 状态 destroyed；本次服务复核容器列表无遗留沙箱。30 分钟联合监测 1750 样本、最低可用内存 1347.1 MiB、swap 为 0，原站点 350 次检查无失败，包含 116 个同时保留预览与另一个生成沙箱的样本。[容量摘要](../artifacts/dev-05-2026-09-22/capacity-summary.json)。基础设施达到继续开发门槛，#6 正常新建场景仍未通过，Issue 保持开放。

## 恢复开发：断流分类修复与 R10

真实本机 HTTP socket 在返回 200 和一个 SSE delta 后主动断开，真实 Pi/生产 transport 在仅 56ms 时复现 MODEL_REQUEST_TIMEOUT 误分类。修复将没有触发请求 signal 的提前断流转换为固定 MODEL_RESPONSE_INTERRUPTED，真实 deadline 和外部取消分别维持超时、取消语义；没有自动重试或放宽任何预算。新增四个边界测试覆盖断流、超时、取消和正常完成，模型与远端 sandbox I/O 明确为 fixture。API 全量 127 PASS / 22 opt-in skipped，typecheck/lint/build PASS；Standards 增量 hard 0/smell 0，Spec 增量 0。此修复不证明 R9 的真实断开源头已找到。

原报名需求在移除临时日志后的 boot `02b13653-56f9-4d3b-a204-c48c18544538` 由内置浏览器重新提交 Run `4a6c5ed6-023e-4540-866a-851d350bc3cd`，此 Run 尚未加载上述传输修复。Coordinator 成功、范围限制可见、Builder 独立 session；Builder 第 10 轮 bash 日志显示 TypeScript/Vite build 成功，随后下一模型请求预留触发 TOKEN_BUDGET_EXCEEDED，故无 Revision。Coordinator 实报 total 5042，Builder total 40379，任务创建到终态 215.376 秒。读回所有相关沙箱 destroyed、清理 confirmed。该次仍为 FAIL，不能以模型自行执行 build 成功替代候选保存与浏览器行为检查；后续先定位估算与实际用量差异再继续。

## 实际请求预算修复

真实 Pi 与外部 HTTP fixture 复现：两个最终请求完全相同，仅本地 toolResult.details 等 metadata 不同，旧实现却对第二个请求报预算不足（先 RED）。预留现移到最终 JSON body 发往既有安全 transport 前，保留实际发送的 thinking、工具 schema、结果和输出上限；继续使用原 bytes/3 与 framing 估计，不声称精确分词。没有调整 60,000 总预算或 Builder 4096 输出上限。

预算不足在外部调用前拒绝，typed failure 穿过 Pi；body 不可估算则拒绝，调用方取消仍为取消；每个 stream 单独预留/结算，异常重复 fetch 拒绝，未报告用量与失败/中止保留预留。API 全量 137 PASS / 22 opt-in skipped，typecheck/lint/build PASS；随后只补一项已安装 Anthropic SDK 的 JSON string/max_tokens 兼容 fixture，wire 专项 11 PASS，生产源码不变。此处无真实 Anthropic key 或请求。

确认无活动 Run 后部署三份已测试编译文件，远端 SHA256 与本地一致；boot `b6a4eaf1-dd8e-49b0-a33f-ae506f1cab15` ready。内置浏览器用相同原报名需求提交 Run `f42e002c-fb1b-4006-a93d-8dcb7e2e08e7`，真实结果仍待后续记录。

## Standards

基线 `1d9312a` 的双轴复查继续有效；实际请求预算增量冻结后，Standards 新增 hard 0、smell 0。确认实际发送前预留、非法请求与重复 fetch 拒绝、取消语义、未知用量保留、两角色异常传递与现有安全边界。审查核对冻结源码 hash 与 diff，不冒称运行真实模型。

## Spec

同一冻结增量新增 0 项：最终正文保留 thinking/工具/结果，60,000 总限额与跨角色共享未变；预算拒绝发生在外部调用前，错误码保持准确，每个 stream 独立结算。审查不替代尚在进行的 R11 浏览器 E2E。

## R11 实际预算失败与编写指引调整

R11 仍为 TOKEN_BUDGET_EXCEEDED：Coordinator 实报 4832、Builder 42558，总计 47390 tokens；Builder 9 轮模型、11 个工具，把 types/storage/表单/支付/名单/App/style 分成多次单独读写。无 Revision，相关沙箱均 destroyed。实际请求预留修复已生效，但不能消除真实重复上下文消耗，不把 fixture 的通过当作生成成功。

针对工具轨迹，仅调整 Builder 三句指引：优先在现有 App 与样式入口完成相关行为，小类型/校验/存储辅助留在所属组件；一轮可提交最多三个输入已知的独立小工具，总参数文本仍建议约 4000 字符。移除“每次只能一个工具”与“拆分辅助模块”的相互牵制，未减少用户要求或放宽服务预算。既有四个工具都显式 executionMode=sequential，安装的 Pi 包装保持该字段并逐个 await；三个工具/4000 字符是提示约束，不是新的硬上限。

相关 Pi-budget/candidate/wire 35 项通过，typecheck/build 通过；Standards 增量 hard 0/smell 0，Spec 增量 0。只更新编译 pi.js 并确认远端 hash 一致，boot `ee5dfec1-3521-4f5d-9b66-b56501c505e0` ready，随后从内置浏览器再次提交完全相同的原报名需求。结果待记录，#6 仍未关闭。

## DEV-05 最终验收

R12 `a9d0402c-f989-4980-b6fd-e0259e60fb01` 在 249.551 秒内保存候选 `09d00eb6-661f-4ed7-9e96-a46f4e2c800e`，sourceHash `f96f9722bb25362d37c08548c825304ee04e4ee46265c12cb621ee3c75b06b5a`。Coordinator/Builder 独立 session，持久交接先于 Builder；分别 2/6 次模型调用、实报总 tokens 5596/35767。七个源文件通过可信构建，版本/预览/hash 绑定一致；operation 已释放、模型 lease 已释放。候选预览按 TTL 保留，Run=CHECK_BLOCKED、current=null，符合 Reviewer 未接入前的契约。

内置浏览器独立操作通过：空姓名/非法邮箱校验，99 元支付确认及明确模拟说明，模拟支付后新增独有记录、人数 3→4，刷新预览后仍有四人；390×844 下工作台 width=scrollWidth=390，中文姓名与邮箱输入、Enter 提交和第二次模拟支付成功，人数变为五人。恢复默认视口后从代码页打开同一 v1 App.tsx，看到相同固定金额、localStorage 与模拟流程。[逐步记录](../artifacts/dev-05-2026-09-22/independent-browser-checks.json)。

候选存在一个明确记录的缺陷：成功文案声称“确认邮件将发送至”，实际没有邮件服务，且计划明确排除真实邮件。手机截图已在会话输出，保存的源码包含同一文案。独立 Spec 复核认为这不否定本票协调/交接及支付、共享后端范围说明子集，但必须保留为未检查候选问题交 #7 Reviewer；不得把候选称为完整应用通过或 promote。

| 本票门槛 | 结果 |
| --- | --- |
| E29 澄清与 parent 回答、范围说明 | PASS：R7→R8 单问题/回答，R12 原报名需求的支付/共享后端演示边界可见 |
| E21 Coordinator/Builder 子集 | PASS：两种链路独立 session 与持久交接；没有伪造 Reviewer 活动 |
| E26 增量 | PASS：390px 澄清回答、中文/键盘操作、范围长文与结果切换；无外层横向溢出 |
| I08 计划、权限、旧 attempt、事务与用量 | PASS：前述真实 DB 定点记录及真实 Pi/外部 fixture 边界测试；不混记真实生成 |
| 最终代码检查 | API 全量 138 PASS / 22 opt-in skipped，API lint/typecheck/build PASS；Web 51 PASS、lint/typecheck/build PASS（前端自该轮后未变） |
| 双轴复查 | Standards hard 0/smell 0，Spec 0；历史适用发现均已修复 |

完整三角色、邮件承诺等候选缺陷检查、current 晋升、版本迭代与公网部署继续由后续票实施；本票通过不改变这些未完成状态。
