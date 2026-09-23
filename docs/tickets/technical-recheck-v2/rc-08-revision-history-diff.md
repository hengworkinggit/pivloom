# [RC-08] 浏览完整历史版本及真实源码差异

## Parent

[总Spec](../../specs/technical-recheck-github-spec.md)

## What to build

用户在项目内查看全部已保存版本、其状态与对话归属，并比较完整源码；只读查看旧版不会悄悄切换当前版本或后续生成基线。

## Acceptance criteria

- [ ] 提供owner隔离、顺序明确的历史版本读取与UI，区分accepted、candidate、rejected及当前版本；不再只展示current/latestCandidate。
- [ ] 查看任一版本时文件树、内容、revisionNo/sourceHash与对话/Check来源一致；未知或跨owner目标拒绝。
- [ ] 相邻或指定版本diff覆盖完整manifest，包含新增、删除、移动、Unicode子目录及内容变化；hash变化本身不代表有效功能。
- [ ] 只读选择清楚区分正在查看和current；不修改项目current、下次Run的baseRevisionId或公共发布版本。
- [ ] 立即完成的文件写入也能出现在快照/diff中，不能由异步UI事件先后漏掉变化。
- [ ] 重登/新会话后历史与完整源码可读；过期Preview状态准确，需要恢复时显式走已有流程。
- [ ] E07/E11/E38和I05/I09/I18通过，复用OpenCode/Dyad的完整树/竞态测试问题集。

## Upstream reuse

采用 U07, U09；按[固定源码与许可清单](../../../research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不引入第二套影子Git状态、不在此票改变current、不增加手动源码编辑/ZIP/Remix。

## Testing and completion gate

- 关联UI/E2E：E07, E11, E38。
- 关联集成：I05, I09, I18。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](../../E2E.md) · [技术方案](../../specs/technical-recheck-v2.md)

## Blocked by

None (can start immediately).
