# RC-11 第四次关联重试：Reviewer 20 分钟上限中断

2026-09-24 UTC；生产 Web/API 同 SHA `92246de121f7d42da27ae95aa90e13cfcc30c2f4`。测试账号 A 经产品 UI 发起关联重试，Run `25f86a7e-549a-4cab-a89c-9d655afbcc64` 的 `retry_of` 指向第三次失败 Run `2181c2cc-18f6-440b-b0da-e845a4c09faa`。本轮只读观察服务端记录；未再提交生成、取消、部署或操作沙箱。

| 对象 | 实测 |
| --- | --- |
| 项目 | `b5031ebf-ec85-4c17-9433-3647d7d81a79` |
| 模型 | profile `ea2e0acf-4277-4670-8280-1e6635e7b363` v2，默认 `kimi-k2.7-code` |
| 计划 | G1–G5、19 项完整子检查，见 `plan.json` |
| 候选 | Revision `2e654bc2-dc1f-425c-bd44-69d4b31859de`，v4，build passed，sourceHash `34d810d5a29fe823d525030fbd43097aff5342d8972956daec086ce591dfec06`，源码 39,033 字节，见 `manifest.json` |
| 原始 Check | `0bf2f13e-cf2a-4efc-a23b-8e452966dac1`，`blocked`，**五组 0/5、19 项全 blocked**，16 张截图工件元数据，见 `check.json` |
| Run 终态 | `failed/persist`、`CHECK_BLOCKED`，03:48:04.442，`cleanup_state=clear` |
| 项目 current | `null`；v4 只是候选，没有通过检查或提升为当前版本 |

Coordinator 2 次、Builder 5 次、Reviewer 56 次真实模型请求。Builder 保存源码并完成构建；Reviewer 03:28:03.738 开始，到 03:48:04.442 刚满约 20 分钟。产品 Check 的原始摘要明确为“检查超过本轮 20 分钟时限，候选尚未通过检查”。03:47:59 最后一项 `browser_key_batch` 显示未完成，是 Reviewer 期限中断后的表象；不能归因为浏览器适配器、按键断线、CSP、Preview 到期或 Provider 鉴权失败。

Reviewer 期间有 9 次 `record_behavior` 工具成功、2 次被拒、16 次截图成功，但它们只是未完成报告的草稿活动。超时落库时 `check.items_json` 的 19 项均为 `blocked`，`group_results_json` 五组均 blocked、passedCount 0，`evidence_json` 为空。不能把 9 次草稿成功改写为部分 Check PASS，也不能从工具活动推断全部玩法已实操。失败 Check 没有逐项动作绑定证据，因此先前首屏 `record_behavior` 前后的点击具体属于哪个 behaviorId 无法从持久化结果确认；尤其不能据此认定初始静态 B01 已按原意验收。

沙箱 `a3870fbe-00a4-4da7-93cf-8fc2827e90e2` / 远端 `b0438c99-702b-4b0f-bcc7-cc87e058ea3b` 在失败后仍显示 `active`，到期时间为 03:55:55.888。03:48 后独立 OpenSandbox SDK `getInfo` 确认活体，**未执行外部 kill**。自然到期后，DB 在 03:56:02.410 将该行标为 `destroyed`；03:57:38 复核全局 active 0、独立 SDK `getInfo`/connect 404。资源现已清理，可继续部署工作。

隔离：原已发布作品项目 `3c866a6a-26e9-4af4-89d4-d84127b7d430` 的 current Revision、sourceHash、更新时间、消息数与版本数前后完全一致（`other-project-before.json` / `other-project-after.json`）。未对 v4 做独立浏览器玩法全量 QA，因为产品 Check 未达到 5/5；Codex IAB 本轮的超时由主任务单独记录，不作为产品 Reviewer 失败证据。

判定：真实生成和构建 PASS；Reviewer 超时导致产品 Check FAIL；独立玩法 QA NOT_RUN；#27 不能关闭。完整脱敏 Run/角色/工具序列、Check、计划与 manifest 均在本目录中。下一轮应等预算/租期修复部署后再正常关联重试，并以产品 5/5 和独立玩法同时验收。
