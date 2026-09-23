# [RC-01] 页面展示可核对的 Web/API 部署 SHA

## Parent

[总Spec](../../specs/technical-recheck-github-spec.md)

## What to build

评审者在工作台能复制正在运行的Web/API提交标识，并与版本端点、构建记录及发布产物相互核对；同包重启不变，换包才变化。

## Acceptance criteria

- [ ] 从确定提交干净构建，Web/API元数据由同一次构建输入产生并随产物发布；未提交业务源码或旧dist不能伪装为目标提交。
- [ ] 只读版本接口返回组件、完整commit和构建时间；页面显示各自简写并可复制完整SHA，不用bootId或生成应用sourceHash代替。
- [ ] 采用Next官方build/deployment ID语义，验证deploymentId存在时的优先级；不在运行时从服务器checkout读取HEAD冒充产物版本。
- [ ] 页面、API与manifest三方一致；重启原包后不变，切换新产物后更新，旧缓存不能继续展示错误版本。
- [ ] Web/API独立部署时如实显示两者；正式复核记录冻结的一组SHA，而非假设它们永远相同。
- [ ] E32/I16及相关桌面、窄屏、复制操作通过并附实际截图/响应/产物记录后才关闭。

## Upstream reuse

采用 U15；按[固定源码与许可清单](../../../research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

不重写部署平台，不把本票的版本接口通过算作任何生成应用E2E通过。

## Testing and completion gate

- 关联UI/E2E：E32, E26。
- 关联集成：I16, I11。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](../../E2E.md) · [技术方案](../../specs/technical-recheck-v2.md)

## Blocked by

None (can start immediately).
