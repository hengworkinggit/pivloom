# RC-09 production rollback UI smoke (read-only)

**Environment:** 2026-09-24 (Asia/Shanghai), independent `agent-browser` session, Pivloom production, existing test account A and its multi-version project `3c866a6a-26e9-4af4-89d4-d84127b7d430`. Web and API `/version` both reported `083c22d1c72664ed61b12508aefd0954b614d65c`.

**Desktop, 1280×850:** The project opened with v16 marked current, 17 saved versions, v15 marked accepted, and the existing permanent publication link. Selecting v15 exposed `回滚到 v15`. Clicking it opened the inline confirmation with `v16 → v15`, an explicit complete-source/Preview rebuild description, a historical-Check warning, and a statement that publication does not update automatically. Both confirmation buttons were enabled and directly hit-testable. Clicking `暂不回滚` closed the confirmation. The UI still marked v16 current and listed 17 versions; the publication link was unchanged.

**Mobile, 390×844:** After switching from Chat to Result, the same accepted v15 entry and confirmation were visible. The from→target text and both buttons fit the viewport; the document scroll width was 390 px. Hit-testing at the center of each button returned that button, with no overlay interception. Clicking `暂不回滚` again closed the confirmation, with v16 still marked current, 17 versions, and the same publication link. No `/rollback` API request appeared in browser resource timing.

The public app URL remained `https://3c866a6a-26e9-4af4-89d4-d84127b7d430.app-69-5-7-187.sslip.io/`; its HTML SHA-256 was `8b98214cf10e925e07be0cfc8e1f18795adbaff918688260db84addf4c2f4d0a` before and after. The old private Preview was expired and was **not** restarted. No final rollback confirmation, generation, model call, publishing, or Preview restoration was performed. The confirmation is an inline `role=group` panel, not a modal `role=dialog`.

Evidence: [desktop before](rc09-production-ui-desktop-before.png), [desktop confirmation](rc09-production-ui-desktop-confirm.png), [mobile entry](rc09-production-ui-mobile-entry.png), [mobile confirmation](rc09-production-ui-mobile-confirm.png), [mobile after cancellation](rc09-production-ui-mobile-cancelled.png).

**Limit:** This confirms production UI discoverability, legibility and safe cancellation only. E35/E36/E38 require a separate real rollback, complete source/Preview/marker comparison, next-run baseline and fault/race tests after the A0 sandbox is available.
