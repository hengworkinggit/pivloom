# RC-12 production account matrix — 2026-09-24

Target: production Web/API `https://pivloom-69-5-7-187.sslip.io`; A's existing published project `3c866a6a-26e9-4af4-89d4-d84127b7d430`, current revision `923781bd-6bcf-4282-b738-9c182c0320ce`. No generation, model call, preview restore, source edit, or A-project mutation was performed.

Two separate named `agent-browser` sessions were used: `rc12-a-fresh` (A) and `rc12-b-temp` (one-time B). A logged in from an initially unauthenticated new session and loaded the existing workbench. Its authenticated API returned HTTP 200 for project detail with 61 messages and the same current revision, 17-version history, seven-file source manifest, `src/App.tsx` source body, passed Check and completed Run. Preview metadata returned HTTP 200 with `state=expired`, matching the workbench's “预览已到期” state. The published workbench was visible after UI logout and re-login; immediately after logout, `pivloom.auth.v1` was absent from localStorage. See `a-after-relogin.png`.

B registered through the normal UI and received an empty project list (`b-empty-projects.png`). Opening A's project directly displayed “暂时无法打开这个项目” (`b-a-project-denied.png`). With B's authenticated session, the same-origin API returned HTTP 404 for each A resource: project detail/dialogue, version history, source manifest, `src/App.tsx` content, Check, Check image artifact, Preview metadata, and Run. B's own `/api/v1/projects` returned HTTP 200 with zero projects. The HTTP requests were GET-only; the bearer token stayed inside each browser evaluation and was never written to a report.

The reusable read-only API seam is a named browser session after normal login: parse `pivloom.auth.v1` **inside** `agent-browser eval`, call same-origin `fetch('/api/v1/...', {headers:{Authorization:'Bearer '+token}, cache:'no-store'})`, and return only `{name,status}` plus nonsecret counts and hashes. It requires no additional backend credentials or second sandbox. The test matrix can be repeated against any owner A project/revision by replacing the IDs above; do not print the token or response bodies containing user data.

The one-time B was logged out, then Supabase Admin deletion was fenced to its exact Auth ID, email and creation time. A subsequent independent Admin `getUserById` returned 404. B owns zero projects, messages, revisions, runs, checks, sandboxes and model profiles. The synthetic email/password were removed from the private `.cache/identity/rc12-ephemeral-b2/manifest.json`; no A identity or project was deleted.

The published project's selected temporary Preview was expired, so its A 200/B 404 metadata comparison alone did not establish live Preview access. While the separate calculator Run `f88973e0-368e-4eb7-af51-70c5295b334e` already had a live candidate revision `09f842ad-1060-4654-9dc8-833bd6ec6193`, four independent named browser sessions tested that existing Preview without starting a sandbox:

| Session | Action | Result |
| --- | --- | --- |
| A session 1 | Open calculator workbench, then direct Preview page and revision marker | Both HTTP 200; calculator buttons visible |
| New anonymous session | Open the same direct Preview URL | HTTP 403, “请从工作台打开预览。” |
| Temporary B session | Open the same direct Preview URL | HTTP 403; B's authenticated `/preview/access` grant request for A's project returned 404 |
| A session 2 | Separately sign in as A, open the workbench and direct Preview | HTTP 200 |
| A session 1 after UI logout | Reload its previously working direct Preview | HTTP 403 |
| A session 2 after session 1 logout | Re-read its direct Preview | Still HTTP 200 |

The screenshots `a-old-preview-after-logout-403.png`, `a-second-preview-200.png`, `anonymous-preview-403.png` and `b-preview-403.png` record the distinct sessions. This comparison proves that the old Preview grant is revoked per logout session while another authorized A session remains valid. The one-time B used for this live check was also UI-logged-out, exact-ID/email/creation-time deleted via Supabase Admin, independently confirmed Auth 404, and its projects/messages/runs/sandboxes/model profiles were all zero. Its credentials were removed from a separate private manifest. No Reviewer session or sandbox process was touched.
