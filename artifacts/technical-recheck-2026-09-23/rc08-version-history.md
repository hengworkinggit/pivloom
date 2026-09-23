# RC-08 · 完整版本历史与源码差异（隔离环境阶段）

验证环境：2026-09-24，本地 Web `localhost:45231`、隔离 API `127.0.0.1:45312`、隔离 PostgreSQL 与 Supabase Storage/Auth；Node 24.19.0、agent-browser 0.36.0。源码基线 `260d2c8bca734ce9c9eedb8beecc8f5b8475813d` 加未提交改动，API `/version` 返回 `commit:null`，因此此处**不构成带部署 SHA 的生产验收**。浏览器采用独立 QA 会话，避免并行 E18/E37 操作相互覆盖；未调用模型，也未生成或发布应用。

## 已执行结果

- A 的隔离项目 `e1f19e78-39b4-4aa2-b863-1ae37fd1cc10` 同时列出 v2 当前 `4a9f8f3c-2c15-42f9-81a3-31b5bb224c7c` 与 v1 历史已验收 `6eeb7e9f-12fa-4934-9059-111c209c0784`。选 v1 后，浏览器代码页读出完整 7 文件树和 `src/App.tsx` 旧版实际内容；来源面板列出 Run、完整 sourceHash 和关联对话，历史 Check 仍按所选 revision 读取。[当前视图](rc08-history-current.png) · [旧版源码](rc08-historical-source.png) · [原始只读 API 记录](rc08-before.json)
- 选中 v1 前后，数据库 `current_revision_id` 始终是 v2；版本选择没有切换后续 Run 基线。该项目 v1/v2 的源码内容相同，所以真实比较正确显示 **7 个未变、0 处差异**；不能用这两个版本冒充有效功能增量。另一个独立 A2 浏览器重新登录后仍能看到 v1/v2 和 7 文件源码；有效 B 会话请求新历史和 diff 接口均为 404，未返回源码。
- A2 浏览器选择历史 v1 后，私有 Preview 请求完成时显示“预览已到期”和显式“重新启动预览”按钮，未自动重建、未改变 v2 current。[独立 A2 截图](rc07-a2-v1-expired.png) 请求未完成时曾暂显“预览暂不可用”；最终状态正确，但加载占位文案仍可改进。
- 为实测非空完整树差异，短暂创建了明确标记为 *diagnostic fixture* 的项目 `06a9d28d-e342-4ae9-9011-e4c046b02da6`。v1 是候选，v2 是未通过候选；两份都不是模型产物、未构建、无 Preview/Check。服务端从两份不可变 Storage 快照比较 **5→5 个文件，1 个未变，5 处差异**：`src/App.tsx` 内容修改、`src/added.ts` 新增、`src/old/name.ts → src/new/name.ts` 精确移动、`src/removed.ts` 删除、`src/保留/颜色.css` Unicode 子目录内容修改。浏览器展示可读 patch，点击 v1 可读旧文件树与 `Old` 源码；`current_revision_id` 全程仍为 null。[原始 diff 与完整 manifest](rc08-fixture-diff.json) · [浏览器差异列表和 patch](rc08-fixture-diff-scroll.png) · [旧版源码](rc08-fixture-old-source.png)
- fixture 完成后精确清理：项目 0、Run 0、Revision 0、凭据租约 0、Storage 对象 0。其间没有启动沙箱、模型或公共发布。首次 fixture 插入因脚本参数数目错误回滚，也经过同一精确清理后才重建；没有遗留对象。
- 立即写入的竞态在现有 Candidate 测试边界加测：Builder 返回后最后一刻写入 Unicode 子目录文件，冻结源码树后真实构建/快照，文件出现在完整 manifest 且可信构建 hash 等于快照 hash；没有以异步 UI 事件推断文件集合。

## 验证与边界

- Web 全套：19 文件、81/81 PASS；API 聚焦 `version-diff`、Candidate 与匿名 HTTP：3 文件、26 PASS（4 个需显式集成环境的旧用例 SKIP）；API/Web typecheck、API build 与 lint通过。
- 原有 API 全套曾为 278 PASS、1 FAIL、58 SKIP；失败是同时开发 #20 时误将 DOM-only Reviewer 长上下文用例设成必须图像证据，#20 已修正，需在合并后重跑。旧 HTTP Auth/Postgres/Storage 集成入口的 B 登录夹具已失效，原持久化用例的模型配置也不满足新 vision gate；这两套旧入口**不计 PASS**。新历史/差异端点的 A/B 真实身份隔离由独立 B 请求及 A 浏览器/API 补证。
- 新端点把当前指针和所有 revision 在一条 owner-scoped PostgreSQL 查询中读取；diff 在验证两个 revision 都属于该项目后加载并校验完整不可变 Storage bundle。页面清楚区分“当前”和“正在查看”，历史选择只读，后续生成仍从服务端 current 取基线。U07 Dyad 与 U09 OpenCode 复用的是版本完整性/快照竞态问题集和测试思路；实现适配现有 PostgreSQL/Supabase 快照，没有引入影子 Git 或复制受限制代码。

尚需生产同一 Web/API SHA 部署与正式浏览器复核；#25 回滚后沙箱无多余文件由回滚模块另验，不能把本次历史查看算作回滚 PASS。
