# [RC-06] 固定五组验收并完整保留增量子检查

## Parent

[[Spec] Pivloom 技术复核：上游复用、五组验收、Canvas 与版本回滚 · #16](https://github.com/hengworkinggit/pivloom/issues/16)

## What to build

用户每轮看到五个明确验收组及全部子检查；新增功能和视觉修改不会删除旧必需项，组通过由服务端从真实子项结果计算。

## Acceptance criteria

- [ ] 新契约定义五个稳定group及完整原子BehaviorTarget引用；取消平铺叶子最多五项的误限，每个required子项完整且唯一归组。
- [ ] 每组只有所有required子项passed才可通过；failed、blocked、未执行或缺证据子项不能被5/5掩盖；展示真实子项数量和详情。
- [ ] 增量携带全部旧required ID与语义；新增追加，明确需求变更记录替代；删除旧项、仅保留一项或复用ID改义必须拒绝。
- [ ] 计划、handoff、Check入库与界面使用同一版本契约，提交结果校验revision/sourceHash和真实观察，不接受模型自报一个总分。
- [ ] 历史平铺Plan/Check继续只读、按原始N/N与历史格式显示，不倒填更强覆盖或伪造新5/5。
- [ ] 采用现有领域schema/校验和Pi官方单份ToolDefinition，不另造验收DSL、独立服务或第二套Provider工具声明。
- [ ] E39及I06/I08/I20/I21对应子集通过：漏项/改义负例、视觉增量全回归、压缩后要求可回读和五组聚合均可核对。

## Upstream reuse

采用 U01, U03, U04；按[固定源码与许可清单](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/research/reuse-manifest-2026-09-23.json)执行，并在实现记录里标明直接调用、复制或适配及偏差。官方API能解决的能力不另写一套执行机制。

固定五组为用户确认的展示/执行分组，不能将每个组当成一次随便点击或限制为最多五条真实需求。

## Testing and completion gate

- 关联UI/E2E：E39。
- 关联集成：I06, I08, I20, I21。
- 从本票可演示的最小完整流程执行；已有受控项目/测试身份可用于平台模块验收，但须注明fixture来源，不能记成真实新应用生成。复用较大用例时明确已执行子集，不把未来前置项目算作本票已测。
- 涉及UI的改动完成后立即做独立浏览器实测；服务端不变量用API/PostgreSQL/真实沙箱补证。正常、失败/取消或越权路径都按本票标准核对。
- 报告记录环境、Web/API SHA、模型/浏览器/沙箱版本、真实或fixture边界、Run/Revision/sourceHash、预期/实际、截图/原始Check及清理结果；不给未执行项PASS。
- 本票所有必需条件实际通过、问题修复复测后才关闭；BLOCKED/NOT_RUN不算完成，最终RC-12不能代替本票验收。

[详细E2E契约](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/E2E.md) · [技术方案](https://github.com/hengworkinggit/pivloom/blob/0e871a146abfd771edac5725f84480997bd1f1d2/docs/specs/technical-recheck-v2.md)

## Blocked by

None (can start immediately).
