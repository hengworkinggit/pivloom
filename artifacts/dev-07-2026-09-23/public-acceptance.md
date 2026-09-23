# Pivloom 公网验收记录（2026-09-23）

本文件记录第 7 轮开发（组 1–4：停止/重试与重启恢复、容量额度、两轮修改与版本一致源码、预览恢复、公网部署）的**真实**验收结果。所有主流程由 Codex 内置浏览器在公网入口实际操作，配合真实模型、真实 OpenSandbox 与真实 Postgres 断言；不包含任何密钥。

## 代码与环境版本

| 项 | 值 |
|---|---|
| 代码版本 | `d9d76d7`（工作树干净，本地 `main` 领先 `origin/main` 14 个提交，未 push） |
| API 发布 | `/opt/pivloom/api-releases/20260922-dev07-16`，boot `64985fae-b187-4596-ade3-d779ba313cad` |
| Web 发布 | `/opt/pivloom/web-releases/web-20260922-dev07-02`（Next.js standalone） |
| 工作台 | https://pivloom-69-5-7-187.sslip.io |
| 预览（每版本独立 origin） | `https://<revisionId>.preview-pivloom-69-5-7-187.sslip.io` |
| 原站点（未改动） | https://beats-steps-69-5-7-187.sslip.io |
| 模型 | 火山方舟 OpenAI 兼容端点，`kimi-k2.7-code`（连接、流式、工具调用均已验证） |
| 沙箱 | 宿主 OpenSandbox + gVisor，镜像 `pivloom-g0:20260922` |
| 身份/数据 | 自托管 Supabase（Auth / Postgres / 私有 Storage），浏览器走同源 `/auth/v1` 路径 |
| 验收项目 | `aff32973-781f-4a2e-8723-7f3526a93518`（读书清单），版本 v1…v14 |

## 用例与结果

| 用例 | 操作 | 预期 | 实际 | 状态 |
|---|---|---|---|---|
| E01 登录/刷新/退出 | 公网登录 → 刷新 → 退出 → 直接访问受保护 URL | 进入列表、刷新保持、退出回登录且无缓存内容、受保护 URL 被重定向 | 全部符合 | PASS |
| E02 错误凭据 | 用错误密码登录，再更正 | 通用提示；不产生 run；更正后恢复 | 「邮箱或密码不正确，或账号暂时无法登录。」，账号计数不变（17/20） | PASS |
| E03 空白输入 | 首页只输入空格 | 不创建项目 | 「创建项目」保持 disabled | PASS |
| E04 真实生成 | 公网提交需求 | 真实三角色完成并产出可操作预览 | run `2ad32c17` 等：协调者/工程师/检查者依次成功，5/5 行为通过 | PASS |
| E05 预览业务行为 | 在预览中添加/标记/筛选/搜索 | 行为按需求生效 | 添加、标记已读、比例、筛选与计数全部生效 | PASS |
| E08/E09 两轮及多轮修改 | 依次追加修改 | 新 revision 与项目关联、旧预览不被破坏 | v7→v8→v9→v11→v12→v14 逐版提升；旧版本仍可查看 | PASS |
| E10 生成中刷新 | 运行中刷新工作台 | 恢复同一 run，不重复 POST | 刷新前后同为 `ce3f5451`，run 总数只 +1，SSE 重连 | PASS |
| E11 重新登录持久化 | 退出后重新登录 | 项目/版本/源码/检查结论一致 | 一致；公网 API 逐版本对照 sha256 | PASS |
| E07 源码一致 | 逐版本读源码 | 内容与 manifest 一致、只读 | 每版 `src/*` sha256 与 manifest 完全一致 | PASS |
| E13/E14 停止 | 运行中点「停止任务」 | 先持久化取消、清理确认后终态、旧预览可用 | `cancel_requested` → `cancelled` + `cleanup_state=confirmed`；旧预览可操作 | PASS |
| E17 预览恢复 | 精确销毁沙箱后点「重新启动预览」 | revision/hash 不变、无模型调用 | 13s 重建，runs/roles/revisions 计数不变 | PASS |
| E26 窄屏 | 390×844 工作台与生成应用 | 无整页横向滚动 | 工作台 390/390；生成应用容器 370px 无溢出，操作可用 | PASS |
| E28 额度 | 额度耗尽账号提交 | 429、草稿保留、不扣额度 | 真实 429；计数 53→53；未创建 run | PASS |
| SSE | 带令牌请求事件流 | 可回放、不缓冲 | HTTP/2 200、`text/event-stream`、`x-accel-buffering: no`、从历史 `id` 回放 | PASS |
| 原站点回归 | 访问既有站点 | 不受影响 | `/`→307→`/beats`→200 | PASS |
| 证书授权边界 | `tls-check` 已知/未知/外部域名 | 只有真实版本可签发 | 200 / 403 / 403 | PASS |
| 跨版本存储隔离 | 两版本同名 localStorage 键 | 互不串用 | v7 与 v9 各自只看到自己的数据 | PASS |

`verify-public.sh` 的完整输出（可复跑）：

```
workbench /login HTTPS                         PASS (200)
same-origin API ready                          PASS (ready)
workbench certificate verifies                 PASS (0)
existing site still served                     PASS (200)
tls-check denies an unknown revision           PASS (403)
tls-check denies a foreign suffix              PASS (403)
tls-check allows a stored revision             PASS (200)
per-revision host answers over TLS             PASS (403, live but no capability cookie)
```

## 自动化测试

| 套件 | 结果 |
|---|---|
| API 单元/契约 | 252 通过（35 skipped 为需显式开关的集成套件） |
| Web | 74 通过（含新增「正式模式禁止降级到 Mock」三条） |
| 真实 Postgres 集成 `PIVLOOM_GENERATION_INTEGRATION=1` | 生命周期 7 通过、持久化 5 通过 |
| lint / typecheck / build | 全部通过 |

## 真实缺陷与修复（本轮）

1. 恢复扫描漏掉 `cleanup_state='pending'` 的滞留行 → 会永久占住全局生成槽位（`migrations/009`）。
2. 沙箱容量按进程内存计数 → 重启后低估、外部回收后高估；改为按登记表计数（`migrations/011`）。
3. 协调者 `submit_plan` 参数形状（模型摊平到顶层）导致整轮失败 → 支持四种形态规整。
4. 修改计划「保留原有行为」按字节比较 → 改为按可观察契约比较，并对纠正信息给出必须原样保留的行为。
5. 检查者证据拒绝不可执行 → `OBSERVATION_NOT_BOUND` 指明下一步与 `behaviorId`。
6. 检查者三种 id 混用（事件 id / observationId / artifactId）→ 截图结果改名 `artifactId`，提示词逐条说明。
7. 重试把 base 指向被拒候选导致协调者 10ms 自毁 → 与普通修改一致从项目当前版本出发。
8. 集成测试清理顺序（先删 lease 再删 run）触发外键，残留 fixture 计入日额度 → 修正顺序。
9. 宿主磁盘 100% 占满导致 Caddy 无法写证书存储、预览子域签发持续失败 → 清理历史发布目录与缓存，释放 17G。

## 未完成 / 阻塞

| 项 | 状态 | 说明 |
|---|---|---|
| #13 真实首个失败 → 修复 → 复查 | **NOT_RUN** | 修复机制与边界已实现并有真实 Postgres 断言；七次刻意构造的需求首轮全部通过（或为基础设施/预算类失败），无法按需制造行为失败 |
| #14 正式域名 | **BLOCKED（等待输入）** | 需工作台主机 + 预览主机（预览需 `<revisionId>.<preview-host>` 泛解析）；切换与验证脚本已就绪 |

## 清理状态

- 测试 fixture 项目/run/revision 已按 id 删除，未残留占用额度；当前项目数据为验收产物（保留）。
- 活动 run = 0；`cleanup_state=pending` = 0；失败候选的沙箱已销毁（预览绑定最多 1 个在线）。
- 移除的 17 个旧 API 发布目录属本任务部署产物，可由 `.cache/development/package-dev07.py` 与本地 tarball 重建；当前与上一版发布目录保留。
