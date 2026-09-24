# RC-11 twelfth linked retry: accepted Canvas snake

On production Web/API `887cd4fa1240b2db6b3abf7106804229c8149b05`, Run `3d5e8667-db48-4afb-a724-a59d2b1545d3` explicitly retried failed v10 `2bdbc38e-a170-444c-8ec2-8f1abab17e14`. It started at 2026-09-24 15:00:30.386 UTC and completed at 15:36:10.507 UTC, with no error and `cleanup_state=clear`. The new accepted v12 Revision is `ffa20081-c51c-49b0-8e53-1ca6dbf24e17`, source hash `b1e0f6b997360ba474df59d1594cb1f1580470bb1c3dfd095c912742aeecd9cb`. The seven-file [manifest](manifest.json) and [Plan](plan.json) are JSON-identical to the [original real-model v6 candidate](original-v6-source.json) (Coordinator 2 calls, Builder 10 calls); this linked retry reused them with zero Coordinator/Builder model calls. Its Reviewer made 24 model calls and completed 17 native `browser_key_batch` operations and one browser reload ([role usage](role-usage.json), [tool counts](tool-counts.json)).

The **persisted product Check** [`bb809321-45bb-41ae-b742-423c5bbc785c`](check.json) is `passed`: 15/15 distinct B01–B15 behavior items passed, and each of G1–G5 passed 3/3 with no failed or blocked item. Its Revision ID and source hash equal the accepted v12. The Check's B02 actual describes an atomic start-and-pause; B03 and B06 separately record visible movement and resume. [Run terminal](run-terminal.json) and [authenticated product API](product-api-tuple.json) independently agree on Run `completed`, Check `passed`, and the project's `currentRevisionId=ffa20081-c51c-49b0-8e53-1ca6dbf24e17`; both public deployment-version endpoints reported the same SHA. The Preview API returned `ready` for that exact Revision/hash at 15:45:17 UTC. Its temporary accepted Preview is intentionally retained until 16:06:10 UTC rather than destroyed immediately after success.

The following PNGs are **this Run's own Reviewer browser observations**, retrieved read-only from private Storage. They are not hand-written Check outcomes or injected game state:

| Observation | Evidence |
| --- | --- |
| Native start-and-pause completed before wall collision; current score 0, `已暂停` | [start-paused.png](start-paused.png) |
| First food: score 1, snake length 4, new food | [first-food.png](first-food.png) |
| Second food: score 2, snake length 5, new food | [second-food.png](second-food.png) |
| Five-segment snake folded and ended within board, away from walls; score/high score 2 | [interior-gameover.png](interior-gameover.png) |
| After product browser reload, current score reset to 0 while high score stayed 2 | [highscore-after-reload.png](highscore-after-reload.png) |

Earlier [independent browser QA of original v6](../rc11-sixth/rc11-sixth-qa.md) used normal game inputs on this **same source hash** to verify four directions, reverse-key rejection, pause stability, two foods, wall and self collision, restart, and reload persistence. It also recorded a separate 390 px viewport clipping issue, outside #27's explicit gameplay acceptance. The new v12 Check is the first formally passing Check; earlier failed or provisional results are not counted as passing evidence.

The unrelated accepted calculator remains at v8 `36b6a2eb-4852-4cc0-8292-a24a63456cba`, hash `424bd83f1d55475c0a6acc038e69e6a2e59b121328575dcc199b84d2ee872e2d`, Check `passed`, 8 revisions, and 20 messages ([current comparison](calculator-after.json), [pre-existing v8 baseline](../rc10-a2-v8-qa/report.md)). Its project update time is 11:47:52 UTC, before this snake Run began. The other published project has identical [before](other-project-before.json) and [after](other-project-after.json) current Revision, source hash, update time, revision count, and message count. No extra generation Run or permanent publication was made for this verification.
