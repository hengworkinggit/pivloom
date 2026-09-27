import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import { createRollbackRepository } from "../../src/data/rollback.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createSourceStore } from "../../src/storage/source.js";
import { REACT_TEMPLATE_VERSION } from "../../src/runtime/snapshot.js";
import { starterPlan } from "../../src/starters/catalog.js";

describe.skipIf(process.env.PIVLOOM_TEMPLATE_INTEGRATION !== "1")("curated template import", () => {
  test("creates one model-free project, survives retries, and records an accepted source baseline", async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!new URL(url).pathname.startsWith("/pivloom_executor_test_")
      || !process.env.PIVLOOM_ENVIRONMENT_ID || !process.env.PIVLOOM_EXECUTOR_OWNER_ID
      || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY) throw new Error("An isolated executor database is required");
    const admin = new Pool({ connectionString: url, max: 1 });
    const identity = (await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true")).rows[0]?.environment_id;
    if (identity !== process.env.PIVLOOM_ENVIRONMENT_ID) throw new Error("Isolated database identity mismatch");
    const database = new PivloomDatabase(url);
    const owner = process.env.PIVLOOM_EXECUTOR_OWNER_ID;
    const models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY));
    const repository = createGenerationRepository(database, models, { executorBootId: randomUUID(), maxSandboxes: 5 });
    const projects = createProjectRepository(database);
    const objects = new Map<string, Uint8Array>();
    const sources = createSourceStore({ url: "http://fixture.invalid", secret: "fixture", objects: {
      upload: async (key, body) => { objects.set(key, body); },
      download: async (key) => objects.get(key)!, list: async () => [],
    } });
    try {
      const input = { slug: "reading-list", title: "读书清单", plan: starterPlan("reading-list"), idempotencyKey: randomUUID() };
      const first = await repository.createTemplateProject(owner, input);
      expect(first.replayed).toBe(false);
      expect(first.run).toMatchObject({ kind: "template", templateSlug: "reading-list", state: "queued",
        modelProfileId: null, modelConfigVersion: null, credentialLeaseId: "" });
      const replay = await repository.createTemplateProject(owner, input);
      expect(replay.replayed).toBe(true);
      expect(replay.project.id).toBe(first.project.id);
      await expect(repository.createTemplateProject(owner, { ...input, slug: "portfolio" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(projects.remove(owner, first.project.id)).rejects.toMatchObject({ code: "PROJECT_BUSY" });

      const claimed = await repository.claimNextQueuedRun(first.run.id);
      expect(claimed?.id).toBe(first.run.id);
      expect((await repository.prepareDispatch(owner, first.run.id)).outcome).toBe("ready");
      await repository.setPhase(owner, first.run.id, { state: "building", phase: "provision" });
      const revisionId = randomUUID();
      const source = await sources.save({ ownerId: owner, projectId: first.project.id, revisionId },
        REACT_TEMPLATE_VERSION, [{ path: "src/App.tsx", content: "export default function App(){return <h1>Book shelf</h1>}\n" }]);
      const build = { schemaVersion: 1, sourceHash: source.sourceHash,
        typecheck: { command: "tsc", exitCode: 0, durationMs: 1, stdoutTail: "", stderrTail: "" },
        build: { command: "vite build", exitCode: 0, durationMs: 1, stdoutTail: "", stderrTail: "" } };
      const revision = await repository.saveCandidate(owner, first.run.id, { source, buildStatus: "passed", build });
      expect(revision.templateSlug).toBe("reading-list");
      const sandboxId = `template-fixture-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      await repository.registerSandbox(owner, first.run.id, { sandboxId, expiresAt });
      await repository.bindPreview(owner, first.run.id, { sandboxId, revisionId, sourceHash: source.sourceHash,
        expiresAt, markerVerified: true, writeRevoked: true, chromeClosed: true });
      const completed = await repository.completeTemplate(owner, first.run.id, { revisionId,
        sourceHash: source.sourceHash, sandboxId, pageVerified: true });
      expect(completed).toMatchObject({ state: "completed", kind: "template", resultRevisionId: revisionId });
      expect(await projects.get(owner, first.project.id)).toMatchObject({
        currentRevisionId: revisionId, thumbnailTemplateSlug: "reading-list",
      });
      expect((await projects.list(owner)).projects[0].thumbnailTemplateSlug).toBe("reading-list");
      expect((await repository.getRevision(owner, revisionId)).status).toBe("accepted");
      expect(await repository.isRevisionEligible(owner, first.project.id, revisionId)).toBe(true);
      expect((await repository.getRun(owner, first.run.id)).plan?.behaviors).toHaveLength(5);
      await repository.markDestroyed(owner, first.run.id, sandboxId);

      // A second accepted version makes v1 a historical rollback target. The
      // fixture only supplies the current pointer; v1 is the real imported Run.
      const secondId = randomUUID(), secondRunId = randomUUID();
      const secondSource = await sources.save({ ownerId: owner, projectId: first.project.id, revisionId: secondId },
        REACT_TEMPLATE_VERSION, [{ path: "src/App.tsx", content: "export default function App(){return <h1>Updated shelf</h1>}\n" }]);
      await database.owned(owner, async (client) => {
        await client.query(`INSERT INTO nano.runs
          (id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,template_slug,
            state,phase,budget_json,deadline_at,executor_boot_id,plan_json,result_revision_id,finished_at)
          VALUES($1,$2,$3,$4,$5,'测试当前版本','template','reading-list',
            'completed','persist','{}',now()+interval '10 minutes',$6,$7,$8,now())`,
        [secondRunId, owner, first.project.id, randomUUID(), "b".repeat(64), randomUUID(), starterPlan("reading-list"), secondId]);
        await client.query(`INSERT INTO nano.revisions
          (id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,template_version,
            manifest_json,source_bytes,compressed_bytes,build_status,build_json,status,template_slug)
          VALUES($1,$2,$3,$4,2,0,$5,$6,$7,$8,$9,$10,'passed',$11,'accepted','reading-list')`,
        [secondId, owner, first.project.id, secondRunId, secondSource.key, secondSource.sourceHash,
          secondSource.templateVersion, JSON.stringify(secondSource.manifest), secondSource.sourceBytes, secondSource.compressedBytes,
          JSON.stringify({ ...build, sourceHash: secondSource.sourceHash })]);
        await client.query("UPDATE nano.projects SET current_revision_id=$3,next_revision_no=3 WHERE owner_id=$1 AND id=$2",
          [owner, first.project.id, secondId]);
      });
      const rollbacks = createRollbackRepository(database, { maxSandboxes: 5 });
      const rollback = await rollbacks.begin(owner, first.project.id, { targetRevisionId: revisionId,
        expectedCurrentRevisionId: secondId, idempotencyKey: randomUUID() });
      expect(rollback.operation.targetRevisionId).toBe(revisionId);
      await rollbacks.fail(owner, first.project.id, rollback.operation.id, { code: "TEST_STOP", message: "测试回滚目标后释放占用" });
      expect((await projects.rename(owner, first.project.id, "我的书架")).title).toBe("我的书架");
      expect((await projects.setArchived(owner, first.project.id, true)).archivedAt).toBeTruthy();
      expect((await projects.list(owner)).projects).toHaveLength(0);
      expect((await projects.list(owner, 20, undefined, true)).projects.map((item) => item.id)).toEqual([first.project.id]);
      expect((await projects.setArchived(owner, first.project.id, false)).archivedAt).toBeNull();
      await expect(projects.remove(randomUUID(), first.project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await projects.remove(owner, first.project.id);
      await expect(projects.get(owner, first.project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { await database.close(); await admin.end(); }
  }, 30_000);
});
