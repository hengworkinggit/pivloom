# RC-10 A0 v5 independent browser QA and failed product Check

Observed 2026-09-24 16:44–17:01 CST on production Web/API `4dea819c07221811ae22be204c7b3c0a715c2c0a`. Test account A used an independent named `agent-browser` session (`rc10-fast`) to click **以新任务重试** on the existing empty calculator project. No direct generation HTTP request, fixture, or prebuilt answer was used. Run `f88973e0-368e-4eb7-af51-70c5295b334e` is `kind=retry` of the previous failed A0 Run, with `baseRevisionId=null` and `expectedCurrentRevisionId=null`.

Real Coordinator (2 model calls) and Builder (10 model calls, 12 tools) produced revision `09f842ad-1060-4654-9dc8-833bd6ec6193` (v5), source hash `c968aff7950cccabe9fa7c2eaa058c2a023174ce5ecce311dda32401d94b0be6`; trusted build passed. During product Reviewer operation, a separate browser session clicked the bound candidate Preview in the workbench. Its visible results were:

| Actual input | Observed result |
| --- | --- |
| Click `2+3×4=` | `14` |
| Click `(2+3)×4=` | `20` |
| Click `0.1+0.2=` | `0.3` |
| Click `12`, then backspace | `1` |
| Click `8÷0=` | `除数不能为零` |
| Clear, then click `5×6=` | `30` |
| Click `(2+3=` | `表达式无效` |
| Keyboard `1`, `2`, `+`, `3`, Enter | `12+3`, result `15` |
| Keyboard Escape, `7`, `8`, Backspace, Enter | `7`, result `7` |

The workbench narrow-preview iframe measured 390px wide and exposed 20 clickable calculator buttons; [narrow screenshot](narrow-390.png). This is an embedded narrow preview, not a full independent mobile viewport or a horizontal-overflow assertion. [Terminal workbench screenshot](workbench-terminal.png).

**Product result: failed, not A0 acceptance.** Reviewer used 4 successful `browser_steps` calls, 12 model calls and 14 tools. Its first `submit_review` failed `OBSERVATION_NOT_BOUND:B12`; second failed `IMAGE_EVIDENCE_REQUIRED:B12`; third `submit_review` returned success, then persisting the Check failed with `GENERATION_FAILED`. API operator log identified `ZodError invalid_value` at review evidence path `[54,"key"]`: the persistence schema only accepted Enter/Backspace/Tab/Escape/arrow/Space while the browser action schema also accepted calculator digit/operator keys. The Run ended `failed/cleanup`, cleanup `confirmed`, revision remained `candidate`, Check count 0, current revision still null. No A1/A2 was submitted. The code fix to reuse `BrowserPressKeySchema` is pending deployment/retest; a product 5/5 result cannot be inferred from independent browser QA.
