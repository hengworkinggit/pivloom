# Atoms 浏览器与视觉修改技术定稿

日期：2026-09-21。目标已调整为较完整 Atoms 产品，不再按 8h Demo 缩减。结论经过官方版本/源码核对和轻量本地 smoke；云端 E2B 联调尚未执行。

## 1. 唯一默认方案

**Pi 负责规划；agent-browser@0.38.1 作为唯一浏览器动作/观察工具层；E2B 内部署独立 Chrome 与 daemon；产品自建受鉴权 Browser Gateway 和实时画面/接管 UI。视觉检查使用同一目标页面上的 Midscene Insight（aiAssert/aiQuery），不启用第二套 aiAct 行动循环。视觉源码映射采用 Dyad Apache tagger@0.9.0 + 自建点选覆盖层/结构化补丁。**

不采用 agent-browser main，不把整个 Dashboard 嵌成最终产品，不默认使用个人浏览器，不叠加 Stagehand/Browser Use 第二浏览器 Agent。所有工具调用、截图、日志、验收结果绑定 tenant/project/run/revision/browserSession/target。

### 版本与选择依据

| 组件 | 现场核实版本/许可 | 定位与决定 |
|---|---|---|
| agent-browser | npm **0.38.1**，GitHub release v0.38.1，2026-09-16；Apache-2.0；42,975★；commit `aff6125c023b810ea3f2e5deec5379e9a4270bdc` | 默认工具层，正式包已含 Dashboard、stream、console/network、CDP；已本地实跑 |
| Stagehand | npm latest **4.1.0**，MIT；24,713★；tag `@browserbasehq/stagehand@4.1.0` commit `cd7b230778cf92269e4cb90e80d97f5113781c51` | 可选替代，不装入默认架构。GitHub releases/latest 仍返回 3.7.3，必须与 npm dist-tags 区分 |
| Stagehand Pi extension | 4.1.0 tag 已有 `packages/integrations/pi/README.md`；但其 `@browserbasehq/stagehand-integrations` npm 查询 E404，README要求整个仓库构建 | 真实可参考 native Pi run/snapshot/screenshot，但不是一条已验证的独立 npm 即装接入；Browserbase默认，可配local |
| pi-browser-use | npm **0.11.8**，MIT；源仓库 `0xPlayerOne/pi-browser-use`，2★ | 社区 Pi extension，基于 chrome-devtools-mcp；不等同于 browser-use/browser-use 官方项目。README明确排除 screencast，不适合本次主实时体验层 |
| browser-use/browser-use | MIT；115,681★；当前 README 的 Rust beta 与既有 Python Agent 并存 | 适合独立浏览器 Agent；本架构已有 Pi 编码编排，不再引入第二完整 Agent loop |
| Midscene | `@midscene/web` npm **1.13.0**，MIT；前轮源码固定 `fee029c37b0e0393a7d495585cce7e8e04ee5c0e` | 只做视觉断言/抽取，绑定现有 Chrome target；具体 1.13.0 与此项目联调待做，不声称本轮已运行 |
| Dyad tagger | npm **@dyad-sh/react-vite-component-tagger@0.9.0**，Apache-2.0；源码 commit `2fc642bc84513a87b99361a9b399634fffa3cdb4` | 默认源码映射组件，已与 Vite 8.3.0 + React19 轻量转换 smoke通过 |

证据：[agent-browser v0.38.1 README](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/README.md)、[发布](https://github.com/vercel-labs/agent-browser/releases/tag/v0.38.1)、[Stagehand Pi 4.1.0](https://github.com/browserbase/stagehand/blob/cd7b230778cf92269e4cb90e80d97f5113781c51/packages/integrations/pi/README.md)、[Pi browser use](https://github.com/0xPlayerOne/pi-browser-use)、[官方 Browser Use](https://github.com/browser-use/browser-use)、[Dyad tagger](https://github.com/dyad-sh/dyad/tree/2fc642bc84513a87b99361a9b399634fffa3cdb4/packages/%40dyad-sh/react-vite-component-tagger)。Stars是查询时点，不作为质量保证。

## 2. Dashboard / stream 已正式发布，不需要押 main

v0.38.1 README、已安装二进制和实际命令一致支持：

- `dashboard start --port <n>`：live viewport、命令活动、console。默认本地端口4848；reverse proxy支持严格allowed origins与access token cookie。
- 每个 session 的 WS stream：`stream status/enable/disable`；JPEG frame带seq、viewport元数据；客户端可发mouse/keyboard/touch。
- `snapshot -i`、截图/标注截图、console、errors、network requests、request details/HAR、a11y、stable targetId、`--cdp`。

**源码核对**：先 MCP graph 建图、search_graph/trace_path，再 get_code_snippet；没有 codegraph server，因此用图工具自身完整源码替代。`StreamServer.start_inner` 确认只绑定127.0.0.1；`dispatch_input` 将WS输入送往相应CDP session的 `Input.dispatchMouseEvent/KeyEvent/TouchEvent`。

[loopback stream源码](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/native/stream/mod.rs#L308)、[输入转发源码](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/native/stream/websocket.rs#L616)。

## 3. 实际验证结果与边界

仅在 `/tmp` 安装0.38.1，用空配置、独立namespace `atoms-research-0381`、新建headless Chrome和本地测试HTTP服务。没有连接个人浏览器、读取用户profile或凭证。

| 测试 | 真实结果 |
|---|---|
| npm安装二进制 | `agent-browser --version` = 0.38.1；本机原全局0.36.0未改动 |
| 创建A浏览器与snapshot | 新建localhost页面，拿到heading/button/input refs及targetId |
| WS实时流 | `stream status`返回动态端口51394；WS收到2帧JPEG及status/tabs/console，截图保存 `/tmp/atoms-browser-smoke/frame.jpg` |
| 流输入→同一页面 | WS发送mousePressed/mouseReleased；CLI读取页面count从0变1，证明不是独立iframe的假同步 |
| A/B隔离 | 分别新建session a/b；console仅各自smoke-/a、smoke-/b，B网络仅观察到自己的/probe/b |
| Dashboard | 独立45124端口启动，HTTP GET返回200；未做整套前端交互测评 |
| 外部CDP连接 | C通过A的CDP URL附着成功。**首次落到about:blank**；明确切到保存的targetId后读到A既有count=1。只知道CDP URL不等于已锁定正确页面 |
| tagger + Vite8 | 安装tagger0.9.0、Vite8.3.0、React19；Vite `transformRequest('/src/App.tsx')`成功注入`src/App.tsx:2:<column>`和source map。最初测试夹具缺React而失败，补齐后通过 |

**尚未验证**：E2B内Chrome资源开销、remote WS鉴权/代理/断线恢复、跨地域帧延迟、WebSocket多客户端输入竞态、中文IME/拖拽/剪贴板完整接管、复杂React HMR源码映射、Midscene视觉模型真实误判率、移动端真实浏览器。禁止把上述本地smoke扩大成“全功能生产可用”。

## 4. 产品边界：同一个浏览器、同一个目标页面

建议会话记录：`browserSessionId, tenantId, projectId, runId, revisionId, sandboxId, targetId, viewport, controlOwner, generation, expiresAt`。其中generation用于浏览器重建后让旧refs、帧、lease失效；element refs只在当前快照有效。

**主画面采用该Chrome的stream。** 普通iframe直接打开Vite URL，会产生用户本机的另一套cookie/localStorage和导航状态；可提供“独立打开应用”作为明确次入口，但不能用它冒充Agent当前浏览器。人和AI共享的是同一browserSessionId+targetId，移动端切换也是改变这一session viewport并重新截图，而非只给iframe改宽度。

**接管由产品控制器实现**：`agent → paused → human → resuming → agent`，单writer lease。用户点接管后，停止派发新的Agent动作、等当前原子动作settle、把controlOwner改为human并开放输入；返回Agent时清空旧refs、截图+snapshot+读取当前URL，注入“用户刚做了什么”的事件。native stream可接收人类输入，但并未替我们完成业务级互斥与恢复；“两个客户端同时点”不是接管实现。

## 5. E2B与工具接口

**默认把 Vite、Chrome、agent-browser daemon 放进同一个项目E2B sandbox**，减少跨网络CDP配置；Pi端注册少数typed tools，通过我们的worker执行固定argv，返回JSON和图片，不让模型决定任意shell拼接：

`browser.open / snapshot / click / fill / press / scroll / screenshot / readConsole / readNetwork / inspectElement / reset`。复杂操作可由Pi组合，模型看到的是一致事件契约。每个结果包括session/target/revision与时间；日志按run范围裁剪。

agent-browser native stream绑定127.0.0.1，**不能简单宣称E2B getHost(streamPort)就能远端访问**。我们在sandbox提供受控WS relay，只连本地daemon；控制面Browser Gateway认证当前用户与会话、校验一次性ticket/lease、代理frame与input，并对输入节流、处理背压/最新帧。产品Web只持短期browser ticket，永不持裸CDP endpoint或E2B API key。原Dashboard作为开发诊断工具，不作为租户控制平面。

远端CDP保留为替换provider的接口：`--cdp <ws-url>`可以附着，但必须绑定保存的targetId。远端endpoint、认证header与网络代理兼容仍是E2B/浏览器供应商的集成门槛。v0.38.1的`--allowed-domains`与CDP/auto-connect等模式有互斥限制，不能承诺“外部CDP + CLI域名限制”天然组合；主路径在受控sandbox使用自己的egress策略。

## 6. Console / Network / Vision验收

- 每项目/租户真正独立sandbox或browser process。namespace/session是工具隔离标识，不能替代云租户权限边界。
- 进入一次检查时记起始时间并清空或设cursor；page errors、console、requestId/response status、a11y分别记录。多tab按targetId筛选；不要把上一轮错误判给新revision。
- 默认网络记录metadata/status；回传前剔除Cookie/Authorization/token字段，body按需取并限大小。fixture测试未含敏感信息，不等于upstream自动完成全部业务脱敏。
- **Midscene只暴露Insight入口**：当检查需要语义视觉判断时，验证worker通过CDP接入该Chrome并选相同targetId，仅调用`aiAssert/aiQuery`，不创建第二浏览器、不调用aiAct。持verification lease禁止同时改UI；将实际截图和模型原因保存。该“现有CDP页面+Midscene1.13”组合尚待联调，接口失败时仍能使用agent-browser截图交给固定VLM检查器，控制层无需替换。
- 确定性规则（无runtime异常、请求成功、刷新后数据仍在、金额等式、精确状态）由代码执行判断；视觉规则（遮挡、按钮可见、错误反馈/布局）可用AI判断。分开展示pass/fail/inconclusive，AI不可自己修改评分标准。

前轮Midscene证据与边界见 `/tmp/nano-browser-midscene.md`；本轮不重复把未实跑的模型调用写作验证通过。

## 7. 视觉点选→源码：Dyad Apache tagger为默认，不复制Pro

tagger是Vite `apply:'serve', enforce:'pre'`插件，用Babel AST遍历JSXOpeningElement，注入`data-dyad-id="relative/file.tsx:line:column"`与name，用MagicString生成source map。位置line从1开始、column从0开始（直接取Babel loc），不是任意runtime实例的永久ID。

graph精读：[源码12–90行](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/packages/%40dyad-sh/react-vite-component-tagger/src/index.ts#L12)。插件已发布0.9.0，peer支持Vite3–8，本地Vite8.3转换已通过。

实现链：

1. 开“选择元素”模式，停止普通页面点击；将显示帧坐标按实际viewport/缩放/letterbox映射回远端Chrome坐标。
2. 对**同一target**做elementFromPoint/祖先查找，返回最近tagged节点、bounding box、文本、样式摘要、截图局部、sourceId、当前revision/file hash。无tag的iframe/第三方节点明确提示不可直接编辑。
3. 服务端校验path属于workspace，sourceId存在于当前trusted transform manifest，revision/hash未过期；从对应文件重新解析AST定位节点。**DOM返回的属性只是线索，不是可信文件写入权限**。
4. 用户输入修改意图（如按钮主色、间距、文字）；对简单结构/样式用受限AST补丁，对复杂要求把选中源码与截图交Pi，提出patch；应用后HMR、截图、recheck、保存新revision。
5. 用户选中的旧行号在任何代码更新后失效；必须重新tag/reselect。列表重复渲染可能多个DOM对应同一源码节点，UI明确“修改该组件的所有实例/仅当前数据内容”的差别。

边界：tagger自身不是完整可视化编辑器；只处理JSXIdentifier（例如Foo.Bar成员表达式不直接标记）；custom component可能不透传属性；source坐标随插行变化；源码映射、选中覆盖层、属性面板、AST改写、回退与重验都由我们完成。生产build不注入（apply serve），需单独验收避免泄露开发源码路径。

**许可边界已核实**：Dyad根LICENSE明确`src/pro/**`适用另行FSL；其余Apache-2.0。本次仅复用`packages/@dyad-sh/react-vite-component-tagger/**`与许可证说明，自建视觉编辑控制逻辑；不读取/复制Pro视觉编辑代码。Onlook可作为以后完整视觉编辑交互参考（Apache-2.0），不是本轮必要依赖。[Dyad许可](https://github.com/dyad-sh/dyad/blob/2fc642bc84513a87b99361a9b399634fffa3cdb4/LICENSE)

## 8. 实施顺序与验收门槛

P0（基础浏览器）：锁agent-browser0.38.1，建立typed Pi adapter、单session writer、target/revision绑定、console/network与artifact schema。验收本地与E2B同一点击链路、两租户无状态混串、取消/超时能收敛。

P1（实时体验）：E2B预构建Chrome镜像 + authenticated WS relay/gateway + stream画面 + 人类接管/返回AI；验收刷新重连、proxy/WSS、backpressure、迟到帧丢弃、输入viewport映射。上线前不通过此门槛，不声称与AI同屏接管完成。

P2（视觉点选修改）：tagger0.9、trusted manifest、选中上下文、受限AST补丁、revision事务/回退；验收嵌套组件、重复列表、中文文本、HMR后重新定位、生产build无tag。

P3（体验闭环）：固定业务断言 + Midscene视觉规则 + 报告artifact + 有界修复；建立包括故意遮挡/空白页/假按钮/刷新丢数据的失败夹具，测出真实误报漏报再决定自动阻断阈值。

默认决策已确定，未验证项是上述实现的准入门槛，不是继续无止境选框架的理由。

### Smoke复现入口（仅使用独立临时环境）

现场文件：`/tmp/atoms-browser-smoke/server.mjs`、`stream-smoke.mjs`、`frame.jpg`、`dashboard.html`；`/tmp/atoms-tagger-smoke/smoke.mjs`、`src/App.tsx`。以下为等价复现顺序，stream端口每次从status读，不能写死51394：

```sh
npm install --prefix /tmp/atoms-browser-smoke --no-save --ignore-scripts agent-browser@0.38.1 ws
node /tmp/atoms-browser-smoke/server.mjs
# 在另一终端，仅以新建会话打开隔离测试页：
/tmp/atoms-browser-smoke/node_modules/.bin/agent-browser --config /tmp/atoms-browser-smoke/empty-config.json --namespace atoms-research-0381 --session a --no-webmcp --json open http://127.0.0.1:45123/a
/tmp/atoms-browser-smoke/node_modules/.bin/agent-browser --namespace atoms-research-0381 --session a stream status --json
# 更新stream-smoke.mjs中的返回端口，再运行；它保存帧并发出测试按钮点击：
node /tmp/atoms-browser-smoke/stream-smoke.mjs
/tmp/atoms-browser-smoke/node_modules/.bin/agent-browser --namespace atoms-research-0381 --session a get text '#count' --json
# tagger smoke必须在这个工作目录，确保相对sourceId一致：
cd /tmp/atoms-tagger-smoke
node smoke.mjs
```

现场结果：stream脚本输出 `{"frames":2,"types":["status","tabs","frame","console"],"clicked":true}`；count返回`1`；tagger脚本输出 `{"vite":"8.3.0","tagger":"0.9.0","transform":"passed","sourceMapping":"src/App.tsx:2:<column>","sourceMap":true}`。运行后关闭本轮a/b/c临时session与独立dashboard/server，保留产物供审阅。
