# RC-03 · E18 固定生产源码 SHA 的 API 强杀复核

关联 [#19](https://github.com/hengworkinggit/pivloom/issues/19)。执行于 2026-09-24（Asia/Shanghai）。对照 [E18 原始契约](../../docs/E2E.md)：运行中的任务转为 `interrupted`，旧 accepted 版本/源码保留，未知 Builder shell 未自动重放，清理确认后新建关联 retry Run，页面不再永久显示“生成中”。这些恢复语义已逐项实测，**E18 PASS（旧版与模型均明确为隔离夹具）**。

## 固定构建与隔离边界

从当前生产源码提交 `4733d3a2c860418f6c71a95535c800887d055be2` 的干净独立工作树，用 `infra/release/build.py` 同时构建 Web/API，分别打包。归档记录见 [Web](rc03-e18-4733-web-build.json)和[API](rc03-e18-4733-api-build.json)。本机 standalone Web `/version` 的 `commit` 和 `buildId`、Fastify API `/api/v1/version` 的 `commit` 均为完整 `4733d3a2...`，页面两个部署徽标均显示 `4733d3a2`；同包重启 API 后不变。这是**同源码提交的独立本机构建**，不是读取生产正在运行的包。

工作台/接口分别在本机 `127.0.0.1:55443/55442`；全新 PostgreSQL `pivloom_e2e_test_rc03_e18` 使用迁移 001–017。Auth、Provider 响应、Storage 对象和沙箱管理器为明确的本机夹具，不请求真实 Provider/OpenSandbox。旧 v1 的 7 个源码文件和 current `c320aa36-a95b-4d8a-a007-91c9a9b72a86` 由隔离夹具直接准备，不能称为真实模型生成或已通过 Reviewer 的样本；原始源码哈希为 `5aafea032c70542d9e332d4c2b8407e7aff87d542afd79b451dc394d8f5f076b`。

## 实际强杀与恢复

隔离 API 第一进程 boot ID `3dcb58ae-343c-4caf-8edc-b9d235afee5a` 接受修改 Run `35b70119-6fdc-44e4-88e1-8c3a8808f1c9`。真实 Pi/Repository 路径提交五组计划、登记候选沙箱夹具 `28f95304-294c-49fe-980e-280aa11be10a`，在 Builder 模型等待态；DB 为 `building/implement`、`base_revision_id=c320aa36`，旧 current/哈希不变。[故障前页面](rc03-e18-4733-before.png)与[旧源码页面](rc03-e18-4733-old-source.png)可见同 SHA、活动 Run、v1 只读 `src/App.tsx` 的“旧版计数器”。

对唯一监听本机 API 55442 的进程 PID 37750 执行 `SIGKILL`，Web 与外部沙箱管理夹具没有重启。使用同一份 `4733d3a2...` API `dist` 构建产物启动新进程，boot ID 变为 `62076397-b95b-4d55-be3f-da038e810e3f`。启动对账只销毁该 Run 登记的候选 ID；原始管理事件为 `DELETE 204 → GET 404`。数据库最终 `interrupted / cleanup confirmed / SERVICE_RESTARTED`，项目操作锁为 NULL；v1 current、7 文件 manifest、源码哈希均与强杀前一致。独立浏览器重开项目显示“工程师已中断”“服务重启中断了本次执行”“以新任务重试”，并仍可读旧版源码。[重启后页面](rc03-e18-4733-interrupted.png)。

在页面点击“以新任务重试”得到新 Run `1a5b60da-8890-461a-837b-4e95709095b3`：`kind=retry`、`retry_of=35b70119`、`base_revision_id=c320aa36`、`parent_run_id=NULL`，与产品 retry 语义一致。测试 Provider 对新 Run 明确返回 401，故它以 `MODEL_FAILED / cleanup confirmed` 结束；其新候选沙箱夹具也销毁，旧 current/哈希仍未变化。[点击后页面](rc03-e18-4733-retry.png)。[脱敏版本、DB、对象文件及管理事件原始核对](rc03-e18-4733-state.json)。

## 边界与清理

E18 原始契约只要求重试新建 Run，**不要求该重试再生成 v2**。本轮新 Run 被明确的 Provider 401 夹具终止，因此新 v2/真实 Reviewer/新 Preview 为本例 **NOT_RUN**；它们没有被计入 E18 PASS。旧 v1 是直接准备的 accepted 状态/源码夹具，未运行真实模型或 Reviewer；结论限定为 API 强杀的状态机、资产保留和页面恢复。另一个 [E15 隔离样本](rc03-e15-925-real-provider.md)在不同固定提交 `9255399a...` 下完成真实 Provider 成功重试和 Check/Preview，两份证据不混成同一构建或同一项目。

截图与脱敏状态取完后，独立浏览器和本机 Web/API/Auth/沙箱管理进程关闭；两条候选沙箱记录均为 destroyed、管理器 GET 404，数据库无活动 Run 或项目锁。本机专用数据库离线保留 v1 测试项目以便复核；它不连接生产账号或作品。未推送、部署或关闭 #19。
