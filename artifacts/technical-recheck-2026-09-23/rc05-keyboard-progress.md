# RC-05 · Canvas 键盘适配（进行中）

关联 [#21](https://github.com/hengworkinggit/pivloom/issues/21)。在 [agent-browser 0.38.1 固定源码](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/native/interaction.rs#L1248-L1273)中，四向键和 `Space` 均映射到实际 keyDown/keyUp；[batch](https://github.com/vercel-labs/agent-browser/blob/aff6125c023b810ea3f2e5deec5379e9a4270bdc/cli/src/main.rs#L2133-L2298)从 JSON argv 顺序执行、`--bail` 首错停下。Pivloom 直接调用这些能力，按键只算一次 press，不宣称持续按住。

适配器限制每批 1–8 个方向键/空格动作、单步等待 0–1000ms、总等待不超过 4000ms；结果列每一步的顺序、键名、等待与成功状态，随后取得新的同会话页面观察。Reviewer 把动作批次、观察、当前 Revision/SourceHash/浏览器会话一起返回并写入 Check 证据；某步输入失败时不能报通过，必须重试或标记 `blocked`。浏览器单测 26/26、Reviewer 单测 66/66、API typecheck 通过，其中包括成功批次、首错停下和输入失败不得通过。

**真实远端适配器探针 PASS**：在一次性的真实 OpenSandbox Canvas 页面上，远端 `agent-browser --version` 为 `0.38.1`。`ArrowUp→ArrowRight→ArrowDown→ArrowLeft→Space` 全部成功，最终可见 HUD 为 `DIR:LEFT STATUS:PAUSED TRAIL:START>UP>RIGHT>DOWN>LEFT>PAUSE`，前后 Canvas 截图哈希不同，页面错误为空。浏览器会话与观察 ID、顺序/时间、SourceHash 见[脱敏原始结果](rc05-keyboard.json)，[初始画面](rc05-keyboard-before.png)与[暂停后的画面](rc05-keyboard-after.png)可复查。沙箱销毁 confirmed，独立远端查询 HTTP 404。

该页是受控 Canvas 键盘夹具，不是生成的贪吃蛇；没有验证吃食增长、真实计分、碰撞/重开、空白画布或假计分负例，也尚未在统一部署的 Reviewer 中完成 E34/E42。因此 #21 保持打开，不能把本探针计作完整小游戏验收。
