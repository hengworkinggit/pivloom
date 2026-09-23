# [RC-09] 原子回滚已验收版本并统一 Preview 与对话基线

## Parent

[[Spec] Pivloom 技术复核：上游复用、五组验收、Canvas 与版本回滚 · #16](https://github.com/hengworkinggit/pivloom/issues/16)

## What to build

用户从历史将第三版回到第一版；目标准备成功后源码、Preview、版本号和当前对话基线一起切换，历史保留，失败不损坏原current。

## Acceptance criteria

- [ ] 仅允许同owner同project的accepted版本；请求携带目标、expected current和幂等键，与生成/恢复共用项目操作互斥。
- [ ] 按Dyad开放流程持久化from/target、已准备binding、phase/error；从完整目标manifest创建干净工作区，核对构建与marker后再事务切current。
- [ ] 准备失败保持旧current；已准备未提交重启、事务已提交响应丢失、重复请求和双标签竞争均产生唯一合法结果，无永久锁/无主沙箱。
- [ ] 真实显示目标旧revisionNo，后续历史仍可浏览；追加回滚事件并明确当前对话上下文，不能把latestRun误当current。
- [ ] 回滚后完整路径集合和逐文件内容等于目标，无新增文件残留；下一轮修改从目标source/plan出发、版本号继续递增。
- [ ] 回滚不调用模型；历史Check标明历史来源，重建后另做真实浏览器操作，不伪造新Check。
- [ ] 私有Preview遵循session授权；公共发布不自动更新，localStorage不承诺业务数据回滚或跨域迁移。
- [ ] E35/E36/E38及I15/I18通过，覆盖越权、未验收目标、恢复失败、取消/重启及提交竞争。

## Upstream reuse

采用 U07, U09, U12, U14；按[固定源码与许可清单](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不复制Dyad的Neon恢复/Electron/Git新commit语义，不把Pi会话树切换当作文件回滚。

## Testing and completion gate

- 关联UI/E2E：E35, E36, E38。
- 关联集成：I15, I18, I09。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/E2E.md) · [技术方案](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/specs/technical-recheck-v2.md)

## Blocked by

- [RC-03 · #19](https://github.com/hengworkinggit/pivloom/issues/19)
- [RC-07 · #23](https://github.com/hengworkinggit/pivloom/issues/23)
- [RC-08 · #24](https://github.com/hengworkinggit/pivloom/issues/24)
