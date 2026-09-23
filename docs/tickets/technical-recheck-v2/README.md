# Pivloom 技术复核开发任务

总Spec：[[Spec] Pivloom 技术复核：上游复用、五组验收、Canvas 与版本回滚 · #16](https://github.com/hengworkinggit/pivloom/issues/16)。已发布12个子issue和17条原生阻塞关系，均标记ready-for-agent、priority:p0、e2e-required。

每模块实现后立即完成关联E2E、记录失败与复测后才关闭；规格就绪不代表无阻塞、已实现或测试通过。

| 票 | GitHub issue | 直接阻塞 | 模块验收 |
|---|---|---|---|
| RC-01 | [#17 页面展示可核对的 Web/API 部署 SHA](https://github.com/hengworkinggit/pivloom/issues/17) | 无 | E32, E26 |
| RC-02 | [#18 复用 Pi 原生生命周期并可靠停止三个角色](https://github.com/hengworkinggit/pivloom/issues/18) | 无 | E13, E14, E41 |
| RC-03 | [#19 失败终态可靠落库并完成资源清理与重试](https://github.com/hengworkinggit/pivloom/issues/19) | [#18](https://github.com/hengworkinggit/pivloom/issues/18) | E15, E18, E20, E30, E40 |
| RC-04 | [#20 让 Reviewer 真正读取截图并验证模型图像能力](https://github.com/hengworkinggit/pivloom/issues/20) | [#18](https://github.com/hengworkinggit/pivloom/issues/18) | E31, E33 |
| RC-05 | [#21 复用原生批量动作完成 Canvas 游戏观察闭环](https://github.com/hengworkinggit/pivloom/issues/21) | [#20](https://github.com/hengworkinggit/pivloom/issues/20) | E34, E42 |
| RC-06 | [#22 固定五组验收并完整保留增量子检查](https://github.com/hengworkinggit/pivloom/issues/22) | 无 | E39 |
| RC-07 | [#23 退出与切账号后撤销私有 Preview 访问](https://github.com/hengworkinggit/pivloom/issues/23) | 无 | E11, E25, E37 |
| RC-08 | [#24 浏览完整历史版本及真实源码差异](https://github.com/hengworkinggit/pivloom/issues/24) | 无 | E07, E11, E38 |
| RC-09 | [#25 原子回滚已验收版本并统一 Preview 与对话基线](https://github.com/hengworkinggit/pivloom/issues/25) | [#19](https://github.com/hengworkinggit/pivloom/issues/19), [#23](https://github.com/hengworkinggit/pivloom/issues/23), [#24](https://github.com/hengworkinggit/pivloom/issues/24) | E35, E36, E38 |
| RC-10 | [#26 全新计算器完成真实生成及功能和视觉两轮增量](https://github.com/hengworkinggit/pivloom/issues/26) | [#17](https://github.com/hengworkinggit/pivloom/issues/17), [#19](https://github.com/hengworkinggit/pivloom/issues/19), [#21](https://github.com/hengworkinggit/pivloom/issues/21), [#22](https://github.com/hengworkinggit/pivloom/issues/22) | E04, E05, E06, E07, E08, E09, E10, E11, E21, E26, E39 |
| RC-11 | [#27 全新 Canvas 贪吃蛇通过真实模型和浏览器验收](https://github.com/hengworkinggit/pivloom/issues/27) | [#17](https://github.com/hengworkinggit/pivloom/issues/17), [#19](https://github.com/hengworkinggit/pivloom/issues/19), [#21](https://github.com/hengworkinggit/pivloom/issues/21), [#22](https://github.com/hengworkinggit/pivloom/issues/22) | E12, E33, E34, E42 |
| RC-12 | [#28 冻结部署并完成跨会话回滚与故障最终复核](https://github.com/hengworkinggit/pivloom/issues/28) | [#25](https://github.com/hengworkinggit/pivloom/issues/25), [#26](https://github.com/hengworkinggit/pivloom/issues/26), [#27](https://github.com/hengworkinggit/pivloom/issues/27) | E01–E42, D01–D05 |

当前无阻塞的首批任务：[#17](https://github.com/hengworkinggit/pivloom/issues/17), [#18](https://github.com/hengworkinggit/pivloom/issues/18), [#22](https://github.com/hengworkinggit/pivloom/issues/22), [#23](https://github.com/hengworkinggit/pivloom/issues/23), [#24](https://github.com/hengworkinggit/pivloom/issues/24)。后续始终按GitHub实时依赖状态领取前沿任务。

计算器与贪吃蛇没有人为互相阻塞；执行真实生成时仍需遵守单实例的全局生成槽。生产只保留A并保护其正式作品，A/B隔离在同构测试环境用临时身份，按精确manifest清理。定时巡检和飞书评论自动化保持关闭。

[本地总Spec](../../specs/technical-recheck-github-spec.md) · [技术方案](../../specs/technical-recheck-v2.md) · [E2E v2](../../E2E.md)。正文、父子关系与阻塞依赖已经同步；发布后以GitHub实时状态和最新评论为准，不改写旧父Spec或将旧票关闭视作新复核通过。
