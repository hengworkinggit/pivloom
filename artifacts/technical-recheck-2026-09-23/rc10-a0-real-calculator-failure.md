# RC-10 A0：真实计算器首轮验收结果（失败）

测试时间：2026-09-23 21:21–21:36 UTC。生产 Web/API 均为 `55845117176f706b14e1c3f9e23ec8f97e11905e`。独立 QA 使用 `agent-browser 0.36.0` 的专用会话 `pivloom-rc10-calc-20260924`；产品内 Reviewer 使用独立 OpenSandbox 浏览器。全程使用测试账号 A 已保存且图像实测通过的 profile `ea2e0acf-4277-4670-8280-1e6635e7b363`，配置 v2、实际默认模型 `kimi-k2.7-code`，未使用 fixture、模板产物或手工改库。

## 首轮执行

- 新建空项目 `bfbbe5cc-4207-4d3e-9620-84df5035e1bc`；提交前 `currentRevisionId=null`，工作台为空态。首页创建项目只保存 A0 原始 Prompt 为草稿，随后在工作台点击“发送需求”一次。
- A0 Run：`ee9a158f-b06a-46b1-8416-ed6696ca731c`。21:21:19 UTC 创建，21:51:19 UTC deadline；运行中刷新工作台后仍显示同一 Run 和单条用户需求，未再次 POST。协调者和工程师分别于 21:24:33、21:28:43 成功；事件包含真实模型流式内容及远程 `edit`、TypeScript typecheck、Vite build。
- 21:28:43 保存 v1 candidate Revision `610ad910-53dd-4fef-84fa-8606de06d6a7`，`sourceHash=bc1523f49a59bcffc0ca4e6b8a4d0d51a86f023f0693b68044dce2806641ce18`，build passed。8 个文件的完整 manifest 已通过每个源码下载重新计算 SHA-256，全部匹配。`src/calculate.ts` 包含通用词法分析与递归下降表达式计算，并非固定测试答案映射。
- 候选私有 Preview 曾为 `ready`，同 Run/Revision/sourceHash；工作台 iframe 和“新标签页打开预览”均可操作。21:34:57 UTC Run 失败并完成清理后 Preview `expired`，符合临时沙箱生命周期；源码快照和 candidate 保留。

## 独立 QA 对候选的实际操作

在候选 Preview 上通过真实按钮/键盘获得：`2+3×4=14`、`(2+3)×4=20`、`0.1+0.2=0.3`、`1-1=0`、`12` 退格为 `1`、`8÷0` 显示“除数不能为零”、清空后 `5×6=30`、`(1+2` 显示“表达式无效”、键盘 `Escape` 后 `7*8` + `Enter` 得 `56`。移动工作台 390×844 的 document 宽 390；新标签直开 Preview 390×844 的 document 宽 390，20 个按钮均未超出视口，最小按钮约 78×64 px，实际触控式点击 `2+3=5`。这证明候选的上述业务子集可用，**不能代替产品 Reviewer Check 或 A0 全部 required 的通过**。

## 产品验收失败及设计矛盾

- 原始 Planner 为 schema v2、5 组、21 个 required：G1“界面与初始状态”(B01–B03)、G2“按钮输入与表达式显示”(B04–B07)、G3“计算、清空与退格”(B08–B12)、G4“键盘操作”(B13–B17)、G5“错误处理”(B18–B21)。并未按 `docs/E2E.md` §2.4.1 固定的“数值运算、输入编辑与键盘、错误恢复、结果状态/历史、视觉布局”五组分组。原计划未显式列出 `(2+3)×4`、`0.1+0.2`、四则完整回归；视觉只有 ≤375px 按键可点，没有独立布局组和 390px 横向溢出子项。原计划保留在 `rc10-a0-plan.json`，未修改。
- Reviewer 从 21:28:43 至 21:34:57 共启动 63 个检查工具：`browser_click` 54、`browser_press` 2、`source_read` 4、`browser_open`/`browser_resize`/`browser_screenshot` 各 1；**`record_behavior` 0、`submit_review` 0**。SSE 不含动作参数，不能从此声称具体哪项重复点击。没有落库 Check。
- 代码约束存在确定性冲突：`apps/api/src/runtime/reviewer.ts:252–261` 要求每个 passed 子项引用动作后且确实交给模型的截图，而同文件 `:437` 最多允许 6 张截图；本次 21 个 required 多数是独立交互，按行为 ID 绑定的动作观察无法凭 6 张图覆盖。`reviewer.ts:296` 指示每项立即 `record_behavior`，实际未执行；`:164` 最多 80 工具。即使候选业务可用，不能据此算 5/5。
- 最终 Run `failed`、phase `cleanup`、error `AGENT_OUTPUT_INVALID`（retryable），`cleanupState=confirmed`；project `currentRevisionId=null`，latest candidate 为 v1，`latestCheck=null`。UI 只给“检查结果未通过格式或证据校验，请稍后重试”和“以新任务重试”，未给具体逐项缺口。未点重试，避免未经修复重复消耗并产生另一失败 Run。

## 判定与下一步

E04 的真实生成/构建子链通过，但成功交付门槛失败；E05 的独立 QA 已执行上述子集，产品 Check 缺失。E06/E07/E10/E26 有候选级证据，不能记为最终版本通过；E08/E09/E11/E21/E39 仍未完成。**#26 当前 FAIL，A1/A2 未提交**。应先消除截图/工具预算与逐项记录的冲突，部署同一新 Web/API SHA 后，通过页面“以新任务重试”创建关联 Run，保留本次失败记录，再继续 A1/A2。

脱敏原始证据：[`rc10-a0-run-summary.json`](rc10-a0-run-summary.json)、[`rc10-a0-plan.json`](rc10-a0-plan.json)、[`rc10-a0-manifest.json`](rc10-a0-manifest.json)。图像：[`空项目`](rc10-a0-empty.png)、[`候选预览`](rc10-a0-candidate.png)、[`14`](rc10-a0-14.png)、[`移动工作台`](rc10-a0-mobile-workbench.png)、[`390px 预览`](rc10-a0-mobile-direct.png)、[`失败桌面`](rc10-a0-failure-desktop.png)、[`失败移动`](rc10-a0-failure-mobile.png)。
