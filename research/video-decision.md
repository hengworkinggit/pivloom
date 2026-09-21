# Atoms 视频模块：M3 技术定案

核验日期：2026-09-21。范围：异步生成视频片段 → 预览 → 选择/分割/裁剪/排序 → 导出可下载视频。与主方案 Pi + Vite + E2B 共用项目、版本、任务与工件模型；视频不是另一个完整视频工作站。本轮只读官方仓库 README、依赖元数据、许可和文档，没有安装渲染服务或运行视频编码。

## 1. 默认方案

**采用自有轻量 React 时间线 + 原生 FFmpeg 异步导出 worker。** 预览先用浏览器 `<video>`，编辑操作修改非破坏性的 timeline JSON；视频生成通过独立 provider adapter 调模型服务。浏览器编辑状态可持久化，最终输出由服务器 worker 规范化、裁剪、拼接、编码、校验后落入工件存储。

OpenCut 只作为时间线选择、播放头、分割交互的源码参考或小范围 MIT 代码移植来源；不把整个项目作为底座，也不依赖尚未发布成熟度的 Editor API。WebAV 可作为 P2 浏览器端加速/本地渲染适配器。Remotion 不进入默认依赖。

“本地导出”默认定义为**生成完成后下载 MP4 到用户设备**，服务器完成编码；不能宣称全程在设备上渲染。如果验收明确要求不上传素材、断网可导出，需另设 WebAV 客户端导出路径及支持浏览器范围。

## 2. 复用与许可选择

| 候选 | 核验版本 / 状态 | 许可 | 采用方式 |
|---|---|---|---|
| OpenCut 主仓 | 90,219 stars；HEAD `400f097becba5db0fbc305d5a65348cb81c20356`；README 明确从零重写，Editor API、插件、Rust core、headless 为后续方向 | MIT | 跟踪产品交互，不能把未来能力写成现成 SDK |
| OpenCut-classic | 原版本另仓，255 stars；HEAD `cf5e79e919144200294fb9fed22a222592a0aeea`；明确 archived/no longer maintained；web 包0.1.0、Next16.1.3/React19、mediabunny1.29.1 | MIT | 选取时间线选择/分割交互参考；有来源记录的窄范围代码移植，自行维护 |
| FFmpeg | 默认版本目标 **9.0.1**；最终集成时固定镜像 digest 与 configure flags | 默认 LGPL2.1+；启用 x264 等 GPL 组件会改变构建许可；`--enable-nonfree` 构建不能当成可自由分发 | 唯一权威导出引擎，原生 CLI 异步 worker |
| WebAV | canonical repo `WebAV-Tech/WebAV`，2,088 stars；HEAD `42dd6fd65ccbda39c729265c14aab56ac4d28235`；npm `@webav/av-cliper` / `@webav/av-canvas` 均1.2.8 | MIT；Pro 能力另算 | P2 可选浏览器处理层，不作为默认跨浏览器导出保证 |
| Remotion | 以当前官方 v5 license terms 为准 | 自定义许可，不能写作“MIT，商业任意免费”；Free 与 Company License 适用条件不同 | 暂不使用；以后如做 React 模板动画、字幕包装，再评估许可和渲染成本 |

Stars 是本次 GitHub 快照；主仓90k不能转写成 classic 仓90k。OpenCut-classic README 同时提醒 preview/effects/export 正在迁移重构，因此尤其不适合直接搬它的整条导出链。主仓与 classic 的依赖体系也不是可直接插入本方案 Vite 编辑面的现成组件库。

默认导出格式是 MP4/H.264/AAC。最可预测的实现是 **FFmpeg + libx264 的明确 GPL 构建**，不要以“FFmpeg 默认 LGPL”为由将这个特定构建也标成 LGPL。渲染 worker 与应用隔离，记录二进制来源、配置、版本、许可证和分发要求；若分发包含二进制的镜像，落实该构建的源码/通知义务。禁止混入 `--enable-nonfree`。将 FFmpeg 放独立进程不等于自动消除许可义务。

Remotion 官方把 video editor、prompt-to-video、自动生成管线列入 Automators 场景；是否需要付费还取决于团队/组织是否满足 Free License 条件，不能绝对说“任何商业使用都付费”。本方案只是 clip 裁剪和拼接，不值得为此引入 React composition 渲染及额外许可证决策。

## 3. 数据、任务与终态工件

```text
Prompt
  → GenerationJob → providerTaskId → 下载/校验模型结果 → ClipAsset
  → TimelineRevision（选择、分割、裁剪、排序）
  → 冻结 ExportSpec → RenderJob
  → ffprobe → FFmpeg 规范化/trim/concat/encode → 成品校验
  → Artifact + Manifest → 浏览器播放 / 下载到本地
```

### 编辑模型

第一版只承诺一个主视频轨、片段原声、播放/暂停/seek、选中 clip、split、trim、reorder、delete；转场、多轨混音、字幕动画和特效另排迭代。选择与分割无需先重新渲染整条视频。

`TimelineRevision` 保存 `projectId/videoId/revisionId/parentRevisionId`、输出宽高、帧率分数、音频策略，以及 clip 列表。每段保存 `clipAssetId/sourceInUs/sourceOutUs/timelineStartUs`，统一整数微秒，边界取整规则明确。split 是将同一个源素材的引用拆成两段，不改写原始文件。导出固定引用一个 immutable revision，不能在导出期间跟随“最新时间线”变化。

剪辑预览可先通过同一个 video 元素顺序载入素材并限制播放范围；M3 不承诺不同源文件之间无缝音画播放。需要严格无缝时增加低分辨率 preview render 或之后接 WebAV，而不是把浏览器切源结果当作最终编码正确性的证明。

### 队列

- **GenerationJob 与 RenderJob 分开。** 前者按模型提供商回调或轮询推进，后者是本地可重试计算；任务记录和状态事件写数据库，不靠内存 Promise 或 E2B 会话存活。
- 生成任务先保存请求和幂等键；获得 `providerTaskId` 后持久化并复用。超时重试先查原任务，不能自动重复付费提交。provider succeeded 后还需 ingest：复制视频到自有持久化存储、校验大小/时长/格式，才形成可引用的 ClipAsset。
- 渲染任务幂等键由 `revisionId + exportSettings + engineVersion` 计算。采用租约、心跳、有限重试、取消信号、项目并发与资源限制，退出时保留失败日志；取消和失败不伪装成已导出。
- worker 通过 argv 调用受限的 ffprobe/ffmpeg，不执行用户或模型提供的 shell 字符串。输入是自有素材文件及验证过的裁剪/尺寸参数。限定总时长、分辨率、素材数与磁盘占用，避免编辑面请求阻塞应用服务器。

### 两层持久化与终态

数据库保存 prompt、providerTaskId、素材元数据、timeline revision、export spec、任务状态和 artifact 引用；对象存储保存原片、海报、成片及日志/manifest。E2B/worker 的文件系统只是运行与缓存层，不能充当唯一保存位置。

工作目录示意：`/workspaces/<projectId>/artifacts/video/<videoId>/<revisionId>/`；保存 `timeline.json`、`export-spec.json`、`render.log`、`probe.json`、`poster.jpg`、`output.mp4`、`manifest.json`。manifest 包含来源 clip hash、revision、FFmpeg版本/配置摘要、输出 SHA-256、字节数、codec、时长、宽高和生成时间。

`RenderJob.succeeded` 的条件是成品存在且可解码，时长和流信息符合 spec，并已写入持久化工件存储、提交 artifact manifest。稳定评审页按 artifactId 解析当前有效下载 URL；签名 URL 可以刷新，不能把模型临时 URL、sandbox TTL 或一次性下载 URL 当成永久视频。

## 4. SSR、浏览器与 API 边界

- React 时间线的纯 JSON 状态可以服务端加载；视频解码、Canvas、WebCodecs、拖动和文件下载在客户端初始化。WebAV 放在 client-only 动态加载边界，不能在普通 Node SSR 中初始化。
- WebAV 官方支持说明是 Chrome102+、Edge、Electron；其 WebCodecs 功能不应被写成所有浏览器均可用。接入时同时检查浏览器 API 与目标编解码器支持，不支持即保留服务器 FFmpeg 导出路径。
- WebAV 的 `IClip` → `Sprite` → `Combinator.output()` 适合后续浏览器合成；原素材读取仍需 CORS/有效授权，移动端内存与长视频负载另测。MIT WebAV 与其 Pro 仓库能力不要混用。
- 服务端 FFmpeg 不依赖 Chromium 或 Remotion，部署为独立异步 worker；不要塞入有短请求时限的 API route。E2B 可以做开发验证环境，但持续重编码应有明确 CPU、磁盘和超时配额。
- 视频生成模型的 API Key、模型用量费、内容能力、任务回调、授权和供应商临时文件保存期均属于独立 provider 层；MIT 编辑器/FFmpeg 开源不提供视频生成模型托管。API Key 只在服务端。

## 5. 实施优先级与验收门槛

**M3 P0：** 单 provider 异步生成与状态恢复、自有素材入库、HTML video 预览、单轨 split/trim/reorder、持久化 timeline、固定 revision 导出队列、MP4 校验/下载、失败日志与取消。

**M3 P1：** 低清全片预览、任务进度/估算、音轨规则、缩略图 strip、导出历史与重试 UI。**P2：** WebAV 客户端渲染、字幕/转场/多轨、Remotion 模板动画；不阻塞最小视频闭环。

首个集成验收必须使用受控的不同颜色/数字/音频频率素材，验证 split 边界、拼接顺序、最终时长、音轨和首尾帧；不能仅让生成 agent 看海报并宣称通过。至少覆盖：两个异步生成片段 → 分割/排序 → 刷新恢复 → 导出 MP4 → 下载并播放；模型失败、导出失败、取消、worker重启和重复回调不得形成错误成功状态或重复扣费请求。

本轮没有做运行 smoke：未安装 FFmpeg、未做真实模型视频生成、未验证浏览器无缝预览、WebAV跨设备编码、FFmpeg生产镜像或E2B大文件性能。因此上述是可实施的默认架构，**运行兼容性仍须在M3开工时通过小型fixture gate**：固定镜像编码5–10秒样例，验证文件/时长/解码与Chrome/Safari播放，再进入实际供应商素材集成。不能把 README 和许可核验写成已跑通产品功能。

## 官方依据

1. [OpenCut 主仓固定 README](https://github.com/OpenCut-app/OpenCut/blob/400f097becba5db0fbc305d5a65348cb81c20356/README.md)：重写中、未来API/headless、MIT；[classic 固定 README](https://github.com/OpenCut-app/opencut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/README.md)：原版本、归档、渲染迁移边界。
2. [WebAV 固定 README](https://github.com/WebAV-Tech/WebAV/blob/42dd6fd65ccbda39c729265c14aab56ac4d28235/README.md)：MIT、WebCodecs、支持浏览器、IClip/Sprite/Combinator与Pro边界。
3. [FFmpeg 许可](https://www.ffmpeg.org/legal.html)、[当前发布](https://ffmpeg.org/download.html)、[过滤器文档](https://ffmpeg.org/ffmpeg-filters.html)：构建许可、版本、trim/atrim/setpts/concat等处理能力。
4. [Remotion 许可 FAQ](https://www.remotion.dev/docs/license/faq)、[现行条款](https://www.remotion.dev/docs/terms)：Free/Company 条件与 Automators 应用场景。

本轮未检查函数体，无需用字符串搜索替代调用图；如进入具体代码移植，继续遵循先 codebase-memory-mcp 结构图、后精确 snippet 的约束。
