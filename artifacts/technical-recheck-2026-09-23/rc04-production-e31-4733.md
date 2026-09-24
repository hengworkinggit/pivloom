# E31 production model configuration UI — release 4733d3a2

Read-only verification on 2026-09-23T23:59Z using a fresh, isolated agent-browser session and existing test account A. No model test, generation, publish, rollback, or private Preview restoration was performed.

- `GET /version` and `GET /api/v1/version` both returned HTTP 200 and full commit `4733d3a2c860418f6c71a95535c800887d055be2`. The workbench displayed `Web 4733d3a2` and `API 4733d3a2` and exposed full-SHA copy controls.
- Desktop and 390×844 model settings showed the saved default OpenAI-compatible profile with actual model ID `kimi-k2.7-code`. Its UI status was `连接与图像测试通过`: streaming and tool calls `已验证`, image understanding `图片实测通过`. The 390px status card, labels and controls were visible without clipping.
- An authenticated read-only `GET /api/v1/model-profiles` returned exactly one profile. Its ID was `ea2e0acf-4277-4670-8280-1e6635e7b363`, `configVersion: 2`, `modelId: kimi-k2.7-code`, `isDefault: true`; persisted streaming, tools, and vision capabilities were all `verified`, and the last test status was `passed` (2026-09-23T20:36:13.423Z). The request output excluded credentials and tokens.
- Existing project `3c866a6a-26e9-4af4-89d4-d84127b7d430` opened under the same account. At desktop and 390px, its workbench showed the selected `kimi-k2.7-code` with `图像已验证`. Opening the model selector displayed the saved default profile and the actual model ID; the selection was not changed.

The profile's user-visible name still says `火山方舟 · GLM 5.3 Flash` although its actual model ID is `kimi-k2.7-code`. This is a label mismatch, not evidence that the backend called GLM; the API model ID and selector both showed Kimi. This read-only pass confirms the saved verification state and UI rendering on the same release SHA; it does not rerun the provider capability probes.

Screenshots: [model settings desktop](rc04-production-e31-4733-model-desktop.png), [model settings 390px](rc04-production-e31-4733-model-mobile.png), [workbench desktop](rc04-production-e31-4733-workbench-desktop.png), [workbench 390px](rc04-production-e31-4733-workbench-mobile.png), [selector 390px](rc04-production-e31-4733-selector-mobile.png).
