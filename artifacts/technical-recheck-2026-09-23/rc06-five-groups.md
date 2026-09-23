# RC-06 · 固定五组与完整子检查（隔离环境阶段）

2026-09-24 本地工作树：`9aea161831ce251b2e9f44476223b66b8f9190d5` 加 #22 未提交修改；Node 24.19.0。数据库测试使用 `pivloom_e2e_test_20260923`、真实 PostgreSQL 和 Supabase 私有 Storage；没有调用模型、创建真实沙箱或构建应用。本轮没有同一部署 Web/API SHA，**不记作生产 E39 完成**。

## 已实现与已验证

- 新 Plan `schemaVersion:2` 固定 `G1`–`G5`，每组至少一个必需子检查；全部原子 BehaviorTarget ID 必须且只能归属一组，最多五条平铺叶子的误限已移除。历史 `schemaVersion:1` 仍能读取，但新 Coordinator/数据库提交不再接受旧平铺计划。
- 下一轮必须保留**所有**旧 required ID、前置条件、动作、可观察结果、required 标记及原组归属。缺项、改义、换组、伪造旧 ID 的替代均拒绝；明确替代使用新 ID、用户本轮原话和理由记录，不能借模型声明悄悄覆盖。Coordinator 的 Pi 官方 ToolDefinition 直接使用一份 Zod 派生 schema；Pi 在执行前拒绝的错误也计入原有一次纠正预算和持久化事件屏障。
- Check 的五组 verdict 由服务端根据完整子项计算，模型只提交原子结果。缺项拒绝；失败、blocked 或缺观察的子项不能汇总成 5/5。`nano.checks.group_results_json` 仅保存新格式的服务端结果；旧 Check 此列为空。读取契约会拒绝与原始子项不一致的伪造组计数/结论。
- 工作台新计划逐组展示全部目标与明确替代；新 Check 展示实际 `x/5`、每组完整子项、预期/实际/观察/截图。旧平铺 Plan/Check 分别显示“历史平铺目标”和原始 `N/N`，不倒填为五组。
- [原始隔离数据库验收](rc06-groups-isolated.json)：诊断夹具 Run `c1156e6b-5265-4030-bd07-f48f59e901e2`、Revision `71d52fc0-9081-402a-b8fd-24fdbb415efe`、sourceHash `911639879e07d1f310cfded107dbde3985a315317854c66bc4c5296785c69654`。强制 Preview 版本标记不匹配后，封存的 Reviewer receipt 有五个 blocked 子项，事务持久化五个 blocked 组；Check 仍绑定原 Run/Revision/sourceHash，current 未提升，B 的 Check 读取为 404。夹具完整清理：项目、Run、租约、Storage 对象各 0。

验证：新增五组/旧项/聚合契约测试 3/3，Coordinator 34/34（包括严格工具声明、纠正预算与旧平铺提交拒绝），Web 模块测试 13/13、Web 全套 85/85，API 全套 289 PASS / 59 SKIP，API/Web typecheck 与 lint 通过。初次全套中的旧 `pi-budget` 夹具仍提交 schemaVersion1 导致失败；改成五组夹具后重新完整执行，全部通过。隔离数据库集成测试须显式开启，已另行执行 1/1 PASS；默认全套会跳过它。

U01 直接使用固定 Pi SDK 的 ToolDefinition/prepareArguments；U03 图像结果链和 U04 原生压缩沿用前序模块，本票没有复制或重做该机制。E39 的真实计算器两轮增量、全旧功能回归、相同部署 SHA 的浏览器演示与长上下文真实检查仍待 #26/#28 联动执行，不能用此诊断夹具替代。

## 生产同一 SHA 补证（2026-09-24）

- Web/API 均为 `083c22d1c72664ed61b12508aefd0954b614d65c`，[CI](https://github.com/hengworkinggit/pivloom/actions/runs/35926896205) 的全量构建与独立 PostgreSQL 作业均通过。A 全新计算器项目的关联重试 Run `4d43a018-9ce0-4c16-9b8a-5935a6895d1c` 已从真实模型取得 [原始 schema v2 Plan](rc10-a0-retry-plan.json)：G1–G5 分别有 6/10/3/4/2 项，B01–B25 共 25 项全为 required，25 个 ID 完整且唯一归组。
- 独立生产浏览器在工作台展开五组与子项，逐个核对 B01–B25 均可读，并显示每项的条件、操作、可观察结果及“必需”；没有把 25 项裁成最多 5 条。[首组](rc10-a0-retry-plan-ui-top.png) · [末组 B25](rc10-a0-retry-plan-ui-g5-end.png)。这只是计划与展示子集，Reviewer 与最终 Check 当时仍在执行，不能据此判该计算器已通过。
- A 的既有 v16 历史项目原始 Check `groupResults=null`、5 条旧平铺结果；同一生产浏览器只读展示“历史平铺 5/5”和原始 5 项，没有伪造为五个新组。[摘要](rc06-historical-flat-ui.png) · [明细](rc06-historical-flat-detail-ui.png)。

本票的五组结构、旧 required 保留、服务端聚合与历史只读兼容已由隔离数据库和生产界面分别证明；真实计算器 A1/A2 的需求覆盖、逐轮 Check 与完整回归仍归 #26，不能用本票的模块结果替代。
