# M3 移动应用模块：Expo / Android / 原生验证决策

日期：2026-09-21。以根侧已核实的 Atoms 移动生成、扫码预览、Android build 为范围，不额外承诺 iOS 商店发布。本轮只读官方 docs/README/CHANGELOG/package metadata，没有安装Android工具链、构建APK或跑原生设备，下面为待集成验证的架构决策。

## 8 条架构建议

1. **新增独立 `expo-mobile` 多文件模板家族，复用同一个 Pi coding runtime。** Expo + React Native + Expo Router + TypeScript；目录包含 `app/`路由、`components/`、`features/`、`lib/`、`assets/`、`app.config.ts`、`eas.json`、`.maestro/`。React Native组件不能直接用Web的DOM/shadcn模板，视觉标注与编辑也需要原生路径；业务schema、API client、设计token可共享。Expo Router是原生/Web通用的文件路由，不能拿“Web页面套手机尺寸”冒充Native。[Expo Router官方](https://docs.expo.dev/router/introduction/)

2. **预览分为明确的两个运行配置：Expo Go兼容原型、完整development build。** 正式移动模板默认SDK57 + `expo-dev-client`；只依赖Expo Go已有原生库的轻量项目可选Go配置，显示扫码/运行时版本/限制。Go不能动态加入新native module、完整验证自身App图标/启动配置、远程push或App/Universal Links；原生依赖变化需要重建development build，纯JS变更通常可Fast Refresh。[官方FAQ](https://docs.expo.dev/develop/development-builds/faq/)、[development build](https://docs.expo.dev/develop/development-builds/introduction/)

   **当前版本不能省略的细节**：官方create-a-project和Router两页均写“最新SDK57”，但商店Expo Go对应SDK54。故不能宣称“SDK57扫商店Go即可运行”。Go配置的当前候选是SDK54，必须在真实Android/iPhone设备验证下载渠道及兼容性后启用；用户创建时选配置，不在现有项目里静默降级SDK。SDK版本矩阵作为可更新模板元数据；超出Go能力时引导生成development build。[官方创建页](https://docs.expo.dev/get-started/create-a-project/)

3. **E2B承载编辑、依赖和Metro/Web预览，不承担Android模拟器。** E2B用来执行Pi远程文件/命令工具、启动Metro、保存代码版本。手机扫码访问可达的Metro入口：先用Expo官方`--tunnel`做连接验证，长期再以受控网关支持manifest/bundle/assets/WebSocket及设备深链。不能假设普通Web iframe反代自动支持Expo协议。公网开发入口用短时会话URL、明确项目归属和关闭机制；Metro源码并非可随意公开的生产发布物。[开发/扫码/tunnel](https://docs.expo.dev/get-started/start-developing/)

   浏览器内可提供标明“Web预览”的RN Web快速布局视图；真实原生预览由development build/Expo Go手机或独立Android runner提供。原生runner采用有合适虚拟化能力的专用Linux主机/托管服务；Android官方对Linux硬件加速要求KVM，不把E2B嵌套虚拟化当已获支持能力。[Android加速要求](https://developer.android.com/studio/run/emulator-acceleration)

4. **Android首发构建选择EAS Build托管，先交付可安装APK，AAB另设发布profile。** `preview` profile配置`distribution: internal`/`android.buildType: apk`，获得签名APK、构建日志与下载链接；development profile带dev-client用于迭代；production AAB用于未来Play发布。默认AAB不能直接装手机，不能把“构建成功AAB”当用户可安装预览。模型只能请求构建，可信submitter持Expo token并负责权限、预算、签名配置及产物回执；不把组织级EXPO_TOKEN注入E2B任意bash。[APK官方说明](https://docs.expo.dev/build-reference/apk/)

   后续需要自托管构建再新增Android SDK/NDK/JDK专用build runner，可用Expo prebuild + Gradle或`eas build --local`。后者**并非完全离线**：官方要求Expo鉴权，会校验项目并可能下载托管credentials；并且本地不支持与云端相同的缓存/secret环境机制。真正完全自托管要自己负责工具链、签名、制品及升级，不只加`--local`。[local builds](https://docs.expo.dev/build-reference/local-builds/)

5. **原生验收选Maestro CLI；浏览器测试不能替代。** Maestro在Android/iOS原生可访问性层上操作，可运行YAML的launch/tap/input/assert流程，不要求往React Native项目植入测试npm依赖。先做“启动→导航→登录/表单→提交→重新打开仍有数据”的APK烟测；保存截图、hierarchy、录屏/设备日志、flow与报告，绑定同一sourceVersion/buildId/deviceProfile。Expo Go测试用开发URL `openLink`，独立APK用真实package `appId`启动；不能对Go容器假称启动了自己的App ID。[Maestro React Native](https://docs.maestro.dev/get-started/supported-platform/react-native)

6. **让Pi调用Maestro能力做探索，再沉淀确定性回归流程。** 官方`maestro mcp`提供屏幕层级、截图、运行flows和Viewer；Pi默认无内置MCP，因此由我们受控MCP client/薄工具adapter接入，不再开一套移动agent loop。为原生QA runner固定deviceId、appId、workspace、timeout，禁止模型触达其他租户设备。当前文档列出的`inspect_screen/take_screenshot/run/open_maestro_viewer`等工具，以所锁CLI实际`tools/list`为准；不把可能随版本变化的完整schema写死。[Maestro MCP官方](https://docs.maestro.dev/get-started/maestro-mcp)

   Viewer是可嵌入的原生设备观察/交互页面，可用于Builder的“原生预览”面板；需要网关鉴权、会话绑定、网络转发和失效回收spike，不能仅凭官方有Viewer便承诺SaaS多租户即插即用。固定2.10.0 changelog已确认2.6加入Viewer、更早加入MCP；当前README明确物理iOS设备暂不支持，iOS测试只作为后续macOS Simulator队列扩展。[固定changelog](https://github.com/mobile-dev-inc/Maestro/blob/14a408335e17a090df1e26bdbeaf80d8122a8fd8/CHANGELOG.md)、[当前README](https://github.com/mobile-dev-inc/Maestro/blob/c436d39f2ba07c4241b7712f85aa5e889d90d62b/README.md)

7. **原生CI初期采用EAS Workflows的Maestro job，实时原生画面按需用独立设备runner。** 官方工作流支持先生成APK，再以buildId运行`.maestro` flows；这避免为了M3首版自建完整设备农场。Maestro Cloud是另一项付费托管服务，第一版不同时引入两家测试云；以后如需设备矩阵再比较。自托管Maestro CLI不依赖购买Maestro Cloud，但我们自己承担模拟器机器和隔离运维。[EAS官方Maestro工作流](https://docs.expo.dev/eas/workflows/examples/e2e-tests/)

8. **复用现有Run/Version/Check，增加MobileBuild与NativeCheck，不新造任务系统。** MobileBuild保存sourceVersion/templateVersion/runtimeProfile/packageId/buildProvider/buildId/status/artifactHash/signingProfileRef；NativeCheck保存buildId/device+OS/flowHash/reportRefs；二维码关联PreviewSession（运行配置、URL、过期时间），不是永久部署链接。分队列限制Android构建/原生设备并发，断线继续任务，取消调用provider/runner取消并追踪终态，失败不自动发布。Supabase后端仍按生成项目隔离；native OAuth/deep link、权限、push必须在development/standalone build实测，Web预览/Expo Go通过不能替代正式配置验收。

## 版本、许可与服务边界

| 层 | 建议版本/固定证据 | 许可/边界 |
|---|---|---|
| 正式移动模板 | `expo 57.0.24`、`expo-router 57.0.22`、RN `0.86.3`、React `19.2.3`；官方`sdk-57`分支`58c5c700ad3ac1eff3488c758a7844d7dcefb7ff` | Expo/Router MIT；不要单独升RN到其最新0.87.1破坏Expo矩阵 |
| Expo Go兼容profile | 当前官方商店说明对应SDK54；候选expo `54.0.37`、Router `6.0.24`、RN `0.81.5`、React `19.1.0`；分支`b26166dcfece76b91a682aead1838282df4a1318` | 必须实机验证与生命周期管理；不保证永远支持旧Go版本 |
| EAS CLI | `24.7.0`，`4a109648a6c59d4d897c6a3a880f77a6e49a4632` | CLI MIT；EAS Build/Workflows为独立托管服务，不因CLI开源而免费或可直接自托管整个平台 |
| Maestro CLI | `2.10.0`，`14a408335e17a090df1e26bdbeaf80d8122a8fd8` | Apache-2.0；CLI/MCP/本地flows为OSS，Cloud托管独立；CLI要求Java17+ |
| Android SDK/模拟器/签名/商店 | 配合锁定Expo构建image和目标Android版本 | 独立工具许可/服务规则；本轮不作商店审核或发布保证 |

核验入口：[Expo稳定package](https://github.com/expo/expo/blob/58c5c700ad3ac1eff3488c758a7844d7dcefb7ff/packages/expo/package.json)、[稳定原生依赖矩阵](https://github.com/expo/expo/blob/58c5c700ad3ac1eff3488c758a7844d7dcefb7ff/packages/expo/bundledNativeModules.json)、[SDK57 changelog](https://expo.dev/changelog/sdk-57)、[SDK参考矩阵](https://docs.expo.dev/versions/latest/)、[SDK54package](https://github.com/expo/expo/blob/b26166dcfece76b91a682aead1838282df4a1318/packages/expo/package.json)、[EAS CLI release](https://github.com/expo/eas-cli/releases/tag/v24.7.0)、[Maestro release](https://github.com/mobile-dev-inc/Maestro/releases/tag/cli-2.10.0)、[Maestro LICENSE](https://github.com/mobile-dev-inc/Maestro/blob/14a408335e17a090df1e26bdbeaf80d8122a8fd8/LICENSE)。

Expo main本轮为`58.0.0-preview.4`，不能当SDK57生产模板来源。安装模板时用官方SDK版本选择和`expo install`对齐依赖，提交lockfile，构建image再固定digest。上述分支package版本已读到，不等于已在本机安装验证。

最小验收：真实手机扫Go配置二维码；dev-client扫码加载同一版本；Android APK冷启动/离线启动；Maestro完成一条真实持久化交互；worker重启后构建回执和APK可找回；添加不兼容native库后能识别并转development build；Viewer只显示授权设备；iOS商店发布明确不在此次承诺内。
