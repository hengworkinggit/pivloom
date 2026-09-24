# RC-10 calculator A0 → A1 → A2: accepted version chain

The original A0/A1/A2 Prompts from `docs/E2E.md` were submitted through test account A's authenticated production workbench in one project, `bfbbe5cc-4207-4d3e-9620-84df5035e1bc`. Each prompt had its own user submission and durable Run. Production used actual provider/roles, OpenSandbox, trusted TypeScript/Vite builds and product Reviewer checks; no calculator business template or fixture replaced these calls.

| Step | Run → accepted revision | Source hash | Product Check |
| --- | --- | --- | --- |
| A0 calculator | `a29976b8-af1f-4a2b-82b4-a6250487abdf` → v6 `786423f9-0886-47fe-b764-996b073ee79a` | `c968aff7950cccabe9fa7c2eaa058c2a023174ce5ecce311dda32401d94b0be6` | [5/5 groups, 12/12 items](check-a0.json) |
| A1 history | `f656427a-7273-4450-b7fc-7985b670bf11` → v7 `6bf92d83-d30e-44cf-a021-4e928bc73016` | `659e72f69cdd3a38f770579b4c5f7c2f278e7db217d461d9b4abe7b0c1ad3503` | [5/5 groups, 17/17 items](check-a1.json) |
| A2 visual | `0b6fe637-740a-466f-bcb1-835788e11121` → v8 `36b6a2eb-4852-4cc0-8292-a24a63456cba` | `424bd83f1d55475c0a6acc038e69e6a2e59b121328575dcc199b84d2ee872e2d` | [5/5 groups, 21/21 items](../rc10-a2-v8-qa/check-summary.json) |

A0's accepted v6 came from a **real model-generated** v5 candidate using the new saved-candidate linked retry path: Coordinator/Builder model calls were zero in the recheck itself, source hash stayed exactly the same, trusted rebuild and a new real Reviewer passed. The originating v5 Run and its failed evidence remain visible; they are not counted as an extra user increment. Independent browser tests of the same source hash covered arithmetic precedence, parentheses, decimal display, backspace, divide-by-zero/invalid-expression recovery, keyboard and narrow preview ([A0 report](../rc10-a0-v5-qa/report.md)).

A1 was a fresh real `modify` from v6, with a new Coordinator/Builder/Reviewer and saved current v7. Downloaded all seven files of both revisions via the authenticated source API: [v6 manifest](manifest-v6.json), [v7 manifest](../rc10-a2-v8-qa/manifest-v7.json). The [full changed-file diff](a1-source.diff) changes only `src/App.tsx` and `src/style.css`; the other five files are byte-identical. Independent browser operations created `2+3 = 5` history, reused the result, reloaded and found the history, then cleared it ([live round-trip report and screenshot](../rc09-live-roundtrip/report.md)).

After a live UI rollback v7→v6→v7, A2's Run recorded both `baseRevisionId` and `expectedCurrentRevisionId` as v7, proving the next modification used the restored accepted base. A2 changed only `src/style.css`; application code stayed byte-identical ([v8 manifest, complete CSS diff, 390px screenshots and QA](../rc10-a2-v8-qa/report.md)). Database current revision is v8, and all three Checks are independently persisted with passing child results. The rollback performed two real accepted-version transitions; it is not described as a third-version→first-version rollback.

Unrelated failed A0 candidates and retries remain historical records. Temporary Preview leases can expire independently of saved projects, conversations, source versions and Checks. Generated calculator history uses browser localStorage, not cross-device cloud persistence.
