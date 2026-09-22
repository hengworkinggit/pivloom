# Pivloom Web 工作台

Next.js 16 + React 19 + TypeScript + Tailwind 4。基础按钮沿用 shadcn 的 Slot/cva 组合方式，弹窗、菜单与弹出层使用 Radix，图标使用 Lucide。[开源来源](../../docs/frontend-open-source.md)与[版权声明](../../docs/third-party-ui-notices.md)已保留。

## 启动与页面

默认是 **API 真实模式**：先按 `.env.example` 配置基础服务并运行 `npm run dev:api`。真实页面为 `/login`、`/projects`、`/projects/:id` 和 `/settings/models`，使用 Supabase Auth、服务端项目及加密模型配置；生成按钮仍待正式 Run 模块接入。配置缺失会明确报错，不自动进入演示。

以下预置项目和 Mock 功能说明仅适用于显式 `npm run dev:demo`。真实模式不会预置三个成品、接受演示口令或把 Mock 进度当真实生成。

在仓库根目录运行 `npm ci`、`npm run dev`；访问 `http://localhost:45231/projects`。端口选择避开了本机已有的 3000/3100 服务；需要改端口可运行 `npm run dev --workspace @pivloom/web -- --port 4000`。

在 Codex 内置浏览器中优先使用 `localhost`。本机验证时，`127.0.0.1` 入口曾显示 `ERR_HTTP_RESPONSE_CODE_FAILURE`，而 `localhost` 的首页、项目工作台和内嵌预览均可正常打开。

| 路径                       | 内容                                                |
| -------------------------- | --------------------------------------------------- |
| `/projects`                | 项目首页、需求输入、三个示例、创建与打开            |
| `/projects/event-demo`     | 活动报名项目工作台                                  |
| `/projects/books-demo`     | 读书清单项目工作台                                  |
| `/projects/portfolio-demo` | 作品集项目工作台                                    |
| `/projects/:id`            | 新建项目的持续对话、预览、源码与状态                |
| `/login`                   | Mock 登录；账号 `demo@pivloom.app`，密码 `demo1234` |
| `/preview/events`          | 独立交互报名应用                                    |
| `/preview/books`           | 独立交互读书清单                                    |
| `/preview/portfolio`       | 独立交互作品集                                      |

900px 以下工作台切换为“对话/结果”。桌面手机预览提供390px内容区域；窄屏会按可用空间缩小。首页卡片是无交互的 CSS 缩略图。

## Mock 接口边界

Demo 的界面数据操作通过 `src/lib/mock-api.ts` 的 `demoApi`，类型位于 `src/lib/types.ts`。这是浏览器内 Promise 适配器，不是 HTTP 服务；没有模型、沙箱、Supabase或真实认证请求。API 模式则使用 `src/lib/workspace.ts`、`api-workspace.ts` 和 `models-api.ts`，向真实身份服务与同源 `/api/v1` 发送请求。

| 方法                                        | 模拟行为                      | 后续替换方向       |
| ------------------------------------------- | ----------------------------- | ------------------ |
| `getSession / login / logout`               | 本地演示会话                  | 真实认证接口       |
| `listProjects / getProject / createProject` | 读取和保存项目                | HTTP 项目接口      |
| `startRun`                                  | 规划→构建→检查→结束，定时事件 | 启动真实任务       |
| `subscribe`                                 | 本页状态变更通知              | SSE/流式事件       |
| `stopRun`                                   | 先 stopping，500ms 后 stopped | 服务端停止确认     |
| `expirePreview / restorePreview`            | 模拟休眠与恢复，版本不增加    | 预览健康和恢复接口 |

页面通过 `useDemoQuery` 查询和订阅，已防止过期请求覆盖新结果。单项目不允许同时生成；停止清理计时器；失败保留旧 revision/files/features。真实接口接入时应保留这些 UI 语义，但不能把浏览器计时器当作真实执行进度。

## 假数据和版本

预置三类本地模板；新需求按关键词选择模板。当前不根据任意文本真实写代码。模拟 `features` 决定报名统计/筛选是否出现，预览 URL 携带已保存功能标记。只读代码是对应的示例源码，预览则是打包进前端的示例组件，二者并非浏览器编译源码的关系。

项目、消息、模拟源码和状态保存在版本化 localStorage 中。默认演示账号便于直接评审，退出后保留项目。刷新正在运行的页面会将未完成生成标记为已停止，避免假装有服务端任务继续运行。存储损坏/写入失败会显示错误，不会静默覆盖坏缓存。

预览里的报名记录、书籍状态属于 iframe 组件内存；刷新、版本更新或重新打开预览会重置。此阶段不实现跨设备或跨浏览器数据同步、工作台标签页之间的并发协调。

iframe 加载的是本仓库可信的预置组件，不接收/执行用户代码。接入真实模型代码后必须按 TRD 改为独立来源的隔离预览，不能复用当前同源演示方式。

## 演示异常路径

打开工作台右上角试管图标“演示场景”：勾选“让下一次生成失败”，然后发送任意需求，观察失败和旧版本保留；点击重试会按正常场景运行。也可点击“模拟预览过期”，随后使用“恢复预览”。

## 验证

仓库根目录 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`。详见[实际验证记录](../../docs/frontend-verification.md)。[PRD](../../docs/PRD.md)、[TRD](../../docs/TRD.md)、[E2E](../../docs/E2E.md)仍是后续真实产品的验收规格。
