import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import { createRollbackRepository } from "../../src/data/rollback.js";
import { createPreviewGateway } from "../../src/generation/preview.js";
import { createRollbackExecutor } from "../../src/generation/rollback.js";
import { createGenerationService } from "../../src/generation/service.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";
import type { SandboxConnector } from "../../src/runtime/workspace.js";
import { createSourceStore, prepareSourceSnapshot } from "../../src/storage/source.js";

// Runs only against the disposable PostgreSQL service prepared by CI or an
// explicitly named local test DB. No live owner, model or remote sandbox exists.
describe.skipIf(process.env.PIVLOOM_ROLLBACK_INTEGRATION !== "1")("atomic rollback persistence", () => {
  const owner = randomUUID(), stranger = randomUUID(), profile = randomUUID();
  let admin: Pool, database: PivloomDatabase;
  let repo: ReturnType<typeof createRollbackRepository>;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)
      throw Error("Explicit isolated database required");
    const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
    if (!/^pivloom_rollback_test_[a-z0-9_]+$/.test(dbName)
      || new URL(process.env.MIGRATION_DATABASE_URL).pathname !== `/${dbName}`)
      throw Error("Dedicated rollback database required");
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
    expect((await admin.query("SELECT current_database() AS name")).rows[0].name).toBe(dbName);
    expect((await admin.query("SELECT id FROM nano.runs LIMIT 1")).rowCount).toBe(0);
    database = new PivloomDatabase(process.env.DATABASE_URL);
    repo = createRollbackRepository(database);
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, stranger]);
      await admin.query("INSERT INTO nano.model_profiles(id,owner_id,current_version) VALUES($1,$2,1)", [profile, owner]);
      await admin.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask)
        VALUES($1,$2,1,'Rollback fixture','openai-completions','https://fixture.invalid/v1','not-called','fixture')`, [profile, owner]);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
  }, 30_000);

  afterAll(async () => {
    await database?.close();
    if (admin) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_kind=NULL,operation_id=NULL WHERE owner_id=$1", [owner]);
        for (const table of ["messages", "rollbacks", "preview_restores", "checks", "run_events", "sandboxes", "role_runs", "revisions", "runs", "model_credential_leases", "projects", "model_profile_versions", "model_profiles"])
          await admin.query(`DELETE FROM nano.${table} WHERE owner_id=$1`, [owner]);
        await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[owner, stranger]]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      await admin.end();
    }
  }, 30_000);

  async function fixture() {
    const projectId = randomUUID();
    const sourceTrees = [
      [{ path: "src/App.tsx", content: "export default function App(){return <p>one</p>}\n" }],
      [{ path: "src/App.tsx", content: "export default function App(){return <p>two</p>}\n" },
        { path: "src/extra.ts", content: "export const extra=2;\n" }],
      [{ path: "src/App.tsx", content: "export default function App(){return <p>three</p>}\n" },
        { path: "src/界面.tsx", content: "export const moved=3;\n" }],
      [{ path: "src/App.tsx", content: "export default function App(){return <p>candidate</p>}\n" }],
    ];
    const sources = sourceTrees.map((files) => prepareSourceSnapshot("react-v1", files));
    const revisions = sourceTrees.map(() => randomUUID());
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO nano.projects(id,owner_id,title) VALUES($1,$2,'rollback-fixture')", [projectId, owner]);
      for (let index = 0; index < revisions.length; index++) {
        const runId = randomUUID(), roleId = randomUUID(), leaseId = randomUUID(), revisionId = revisions[index];
        const accepted = index < 3, snapshot = sources[index];
        await admin.query("INSERT INTO nano.model_credential_leases(id,owner_id,profile_id,config_version,reference_id,released_at) VALUES($1,$2,$3,1,$4,now())", [leaseId, owner, profile, runId]);
        await admin.query(`INSERT INTO nano.runs(id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,
          model_profile_id,model_config_version,credential_lease_id,coordinator_role_run_id,state,phase,budget_json,deadline_at,executor_boot_id,finished_at)
          VALUES($1,$2,$3,$4,repeat('a',64),'Fixture','generate',$5,1,$6,$7,$8,'persist','{}',now()+interval '30 minutes',$9,now())`,
        [runId, owner, projectId, randomUUID(), profile, leaseId, roleId, accepted ? "completed" : "needs_changes", randomUUID()]);
        await admin.query(`INSERT INTO nano.role_runs(id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json)
          VALUES($1,$2,$3,$4,'reviewer',0,$5,'succeeded','{}')`, [roleId, owner, projectId, runId, randomUUID()]);
        await admin.query(`INSERT INTO nano.revisions(id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,
          template_version,manifest_json,source_bytes,compressed_bytes,build_status,build_json,status)
          VALUES($1,$2,$3,$4,$5,0,$6,$7,'react-v1',$8,$9,$10,'passed','{}',$11)`,
        [revisionId, owner, projectId, runId, index + 1,
          `${owner}/${projectId}/${revisionId}/${snapshot.sourceHash}.json.gz`, snapshot.sourceHash,
          JSON.stringify(snapshot.manifest), snapshot.sourceBytes, snapshot.compressed.byteLength,
          accepted ? "accepted" : "candidate"]);
        await admin.query(`INSERT INTO nano.checks(id,owner_id,project_id,run_id,role_run_id,attempt,revision_id,source_hash,
          sandbox_id,browser_session_id,verdict,items_json,artifacts_json,evidence_json,summary)
          VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,'[]','[]','[]','Fixture check')`,
        [randomUUID(), owner, projectId, runId, roleId, revisionId, snapshot.sourceHash,
          randomUUID(), randomUUID(), accepted ? "passed" : "failed"]);
      }
      await admin.query("UPDATE nano.projects SET current_revision_id=$2,next_revision_no=5 WHERE id=$1", [projectId, revisions[2]]);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    return { projectId, revisions, sources };
  }
  const request = (targetRevisionId: string, expectedCurrentRevisionId: string, idempotencyKey = randomUUID()) =>
    ({ targetRevisionId, expectedCurrentRevisionId, idempotencyKey });
  const binding = () => ({ sandboxId: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString() });

  test("owner, accepted check, CAS, idempotency and shared project lock reject unsafe starts", async () => {
    const { projectId, revisions } = await fixture();
    await expect(repo.begin(stranger, projectId, request(revisions[0], revisions[2]))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.begin(owner, projectId, request(revisions[3], revisions[2]))).rejects.toMatchObject({ code: "ROLLBACK_TARGET_NOT_ACCEPTED" });
    await expect(repo.begin(owner, projectId, request(revisions[0], revisions[1]))).rejects.toMatchObject({ code: "STALE_BASE" });
    const input = request(revisions[0], revisions[2]);
    const first = await repo.begin(owner, projectId, input);
    expect(first.replayed).toBe(false);
    expect((await repo.begin(owner, projectId, input)).operation.id).toBe(first.operation.id);
    await expect(repo.begin(owner, projectId, { ...input, targetRevisionId: revisions[1] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(repo.begin(owner, projectId, request(revisions[1], revisions[2]))).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    await repo.fail(owner, projectId, first.operation.id, { code: "FIXTURE_FAIL", message: "No sandbox created" });
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [projectId])).rows[0].operation_id).toBeNull();
  });

  test("prepare and commit switch exact old version once; retained history and conversation remain separate from Runs", async () => {
    const { projectId, revisions, sources } = await fixture();
    const input = request(revisions[0], revisions[2]);
    const started = await repo.begin(owner, projectId, input);
    const remote = binding();
    await repo.registerSandbox(owner, projectId, started.operation.id, remote);
    expect((await admin.query("SELECT current_revision_id FROM nano.projects WHERE id=$1", [projectId])).rows[0].current_revision_id).toBe(revisions[2]);
    await repo.markPrepared(owner, projectId, started.operation.id, {
      sandboxId: remote.sandboxId, sourceHash: sources[0].sourceHash,
      markerVerified: true, filesVerified: true, writeRevoked: true,
    });
    const committed = await repo.commit(owner, projectId, started.operation.id);
    expect(committed.status).toBe("committed");
    expect((await repo.commit(owner, projectId, started.operation.id)).status).toBe("committed");
    expect((await repo.begin(owner, projectId, input)).operation.status).toBe("committed");
    const state = (await admin.query("SELECT current_revision_id,next_revision_no,operation_id FROM nano.projects WHERE id=$1", [projectId])).rows[0];
    expect(state).toMatchObject({ current_revision_id: revisions[0], next_revision_no: 5, operation_id: null });
    const history = (await admin.query("SELECT id,revision_no,manifest_json FROM nano.revisions WHERE project_id=$1 ORDER BY revision_no", [projectId])).rows;
    expect(history.map((row) => row.id)).toEqual(revisions);
    expect(history[0].manifest_json).toEqual(sources[0].manifest);
    expect((await admin.query("SELECT count(*)::int AS n FROM nano.messages WHERE rollback_id=$1", [started.operation.id])).rows[0].n).toBe(1);
    const message = (await admin.query("SELECT run_id,kind,content FROM nano.messages WHERE rollback_id=$1", [started.operation.id])).rows[0];
    expect(message.run_id).toBeNull();
    expect(message.kind).toBe("rollback");
    expect(message.content).toContain("v3 回滚到 v1");
    expect((await admin.query("SELECT count(*)::int AS n FROM nano.runs WHERE project_id=$1", [projectId])).rows[0].n).toBe(4);
    expect((await repo.committedActivePreviews()).some((row) => row.id === started.operation.id)).toBe(true);
    await repo.markCommittedSandboxDestroyed(owner, projectId, started.operation.id, remote.sandboxId);
    expect((await admin.query("SELECT current_revision_id FROM nano.projects WHERE id=$1", [projectId])).rows[0].current_revision_id).toBe(revisions[0]);
    expect((await repo.committedActivePreviews()).some((row) => row.id === started.operation.id)).toBe(false);
    const service = createGenerationService({ database,
      models: createModelProfileService(database, createCredentialVault(randomBytes(32).toString("base64"))),
      identity: { appOrigin: "http://localhost:45231", supabaseUrl: "http://localhost:55434",
        supabaseSecretKey: "unused-fixture", databaseUrl: process.env.DATABASE_URL! },
      previewOrigin: "http://localhost:45311",
      sandbox: { baseUrl: "http://localhost:55434", apiKey: "unused-fixture", image: "not-created" },
      bootId: randomUUID(), maxSandboxes: 2,
    });
    try {
      const detail = await service.projectDetail(owner, projectId);
      expect(detail.currentRevision?.id).toBe(revisions[0]);
      expect(detail.latestCandidate).toBeNull();
      expect(detail.latestRun).toBeNull();
      expect(detail.activeRun).toBeNull();
      expect(detail.preview?.revisionId).toBe(revisions[0]);
      expect(detail.latestCheck?.revisionId).toBe(revisions[0]);
      expect(detail.latestCheckHistorical).toBe(true);
      expect(detail.messages.at(-1)?.kind).toBe("rollback");
      expect(detail.messages.at(-1)?.runId).toBeNull();
    } finally { await service.close(); }
  });

  test("failed preparation holds lock until exact remote cleanup, preserving old current", async () => {
    const { projectId, revisions, sources } = await fixture();
    const started = await repo.begin(owner, projectId, request(revisions[0], revisions[2]));
    const remote = binding();
    await repo.registerSandbox(owner, projectId, started.operation.id, remote);
    await expect(repo.markPrepared(owner, projectId, started.operation.id, {
      sandboxId: remote.sandboxId, sourceHash: sources[1].sourceHash,
      markerVerified: true, filesVerified: true, writeRevoked: true,
    })).rejects.toMatchObject({ code: "ROLLBACK_BINDING_MISMATCH" });
    const failed = await repo.fail(owner, projectId, started.operation.id, { code: "RESTORE_FAILED", message: "Build failed" });
    expect(failed.status).toBe("cleanup_pending");
    await expect(repo.begin(owner, projectId, request(revisions[1], revisions[2]))).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    await expect(repo.markSandboxDestroyed(owner, projectId, started.operation.id, randomUUID())).rejects.toMatchObject({ code: "ROLLBACK_BINDING_MISMATCH" });
    expect((await repo.markSandboxDestroyed(owner, projectId, started.operation.id, remote.sandboxId)).status).toBe("failed");
    expect((await admin.query("SELECT current_revision_id,operation_id FROM nano.projects WHERE id=$1", [projectId])).rows[0])
      .toMatchObject({ current_revision_id: revisions[2], operation_id: null });
    const later = await repo.begin(owner, projectId, request(revisions[1], revisions[2]));
    await repo.fail(owner, projectId, later.operation.id, { code: "FIXTURE_DONE", message: "No sandbox" });
  });

  test("boot recovery destroys a pending sandbox through the injected connector and unlocks the project", async () => {
    const { projectId, revisions } = await fixture();
    const started = await repo.begin(owner, projectId, request(revisions[0], revisions[2]));
    const remote = binding();
    await repo.registerSandbox(owner, projectId, started.operation.id, remote);
    expect((await repo.fail(owner, projectId, started.operation.id,
      { code: "RESTORE_FAILED", message: "Fixture preparation failed" })).status).toBe("cleanup_pending");

    let remoteAlive = true;
    let killCount = 0;
    const connector: SandboxConnector = {
      async create() { throw Error("Recovery must not create a sandbox"); },
      async connect(_config, sandboxId) {
        expect(sandboxId).toBe(remote.sandboxId);
        return {
          sandboxId,
          async kill() { killCount++; remoteAlive = false; },
          async isRunning() { return remoteAlive; },
          async renew() { throw Error("Recovery must not renew a sandbox"); },
          async close() {},
          async endpoint() { throw Error("Recovery must not open a preview"); },
          async run() { throw Error("Recovery must not execute commands"); },
          async read() { throw Error("Recovery must not read files"); },
          async write() { throw Error("Recovery must not write files"); },
        };
      },
    };
    const models = createModelProfileService(database, createCredentialVault(randomBytes(32).toString("base64")));
    const previews = createPreviewGateway({ publicOrigin: "http://localhost:45311", appOrigin: "http://localhost:45231",
      sandboxOrigin: "http://localhost:55448", async isSessionActive() { return false; } });
    const executor = createRollbackExecutor({ repository: repo,
      generation: createGenerationRepository(database, models, { executorBootId: randomUUID() }),
      sources: createSourceStore({ url: "http://localhost:55448", secret: "fixture",
        objects: { async upload() { throw Error("Recovery must not upload"); },
          async download() { throw Error("Recovery must not download"); }, async list() { return []; } } }),
      previews, sandbox: { baseUrl: "http://127.0.0.1:55448", apiKey: "fixture", image: "fixture" },
    }, { sandboxConnector: connector });
    try {
      expect(await executor.recoverAtBoot()).toBe(1);
      expect(killCount).toBe(1);
      expect(remoteAlive).toBe(false);
      expect((await repo.get(owner, projectId, started.operation.id)).status).toBe("failed");
      expect((await admin.query("SELECT state FROM nano.sandboxes WHERE owner_id=$1 AND project_id=$2 AND remote_id=$3",
        [owner, projectId, remote.sandboxId])).rows[0].state).toBe("destroyed");
      expect((await admin.query("SELECT current_revision_id, operation_id FROM nano.projects WHERE id=$1", [projectId])).rows[0])
        .toMatchObject({ current_revision_id: revisions[2], operation_id: null });
    } finally { await executor.close(); await previews.close(); }
  });

  test("cancel wins before commit; boot claim distinguishes prepared and unfinished work", async () => {
    const cancelCase = await fixture();
    const first = await repo.begin(owner, cancelCase.projectId, request(cancelCase.revisions[0], cancelCase.revisions[2]));
    const remote = binding();
    await repo.registerSandbox(owner, cancelCase.projectId, first.operation.id, remote);
    await repo.markPrepared(owner, cancelCase.projectId, first.operation.id, {
      sandboxId: remote.sandboxId, sourceHash: cancelCase.sources[0].sourceHash,
      markerVerified: true, filesVerified: true, writeRevoked: true,
    });
    expect((await repo.cancel(owner, cancelCase.projectId, first.operation.id)).status).toBe("cancel_requested");
    await expect(repo.commit(owner, cancelCase.projectId, first.operation.id)).rejects.toMatchObject({ code: "ROLLBACK_NOT_ACTIVE" });
    await repo.fail(owner, cancelCase.projectId, first.operation.id, { code: "CANCELLED", message: "Cancelled" });
    expect((await repo.markSandboxDestroyed(owner, cancelCase.projectId, first.operation.id, remote.sandboxId)).status).toBe("cancelled");
    expect((await admin.query("SELECT current_revision_id FROM nano.projects WHERE id=$1", [cancelCase.projectId])).rows[0].current_revision_id).toBe(cancelCase.revisions[2]);

    const preparedCase = await fixture();
    const second = await repo.begin(owner, preparedCase.projectId, request(preparedCase.revisions[0], preparedCase.revisions[2]));
    const preparedRemote = binding();
    await repo.registerSandbox(owner, preparedCase.projectId, second.operation.id, preparedRemote);
    await repo.markPrepared(owner, preparedCase.projectId, second.operation.id, {
      sandboxId: preparedRemote.sandboxId, sourceHash: preparedCase.sources[0].sourceHash,
      markerVerified: true, filesVerified: true, writeRevoked: true,
    });
    const unfinishedCase = await fixture();
    const third = await repo.begin(owner, unfinishedCase.projectId, request(unfinishedCase.revisions[0], unfinishedCase.revisions[2]));
    const unfinishedRemote = binding();
    await repo.registerSandbox(owner, unfinishedCase.projectId, third.operation.id, unfinishedRemote);
    const claims = await repo.claimStale();
    expect(claims.find((item) => item.id === second.operation.id)?.status).toBe("prepared");
    expect(claims.find((item) => item.id === third.operation.id)?.status).toBe("cleanup_pending");
    expect((await repo.commit(owner, preparedCase.projectId, second.operation.id)).status).toBe("committed");
    expect((await admin.query("SELECT current_revision_id FROM nano.projects WHERE id=$1", [unfinishedCase.projectId])).rows[0].current_revision_id).toBe(unfinishedCase.revisions[2]);
    await repo.markSandboxDestroyed(owner, unfinishedCase.projectId, third.operation.id, unfinishedRemote.sandboxId);
  });

  test("two concurrent rollback keys acquire only one project operation", async () => {
    const { projectId, revisions } = await fixture();
    const results = await Promise.allSettled([
      repo.begin(owner, projectId, request(revisions[0], revisions[2])),
      repo.begin(owner, projectId, request(revisions[1], revisions[2])),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const accepted = results.find((result) => result.status === "fulfilled");
    if (!accepted || accepted.status !== "fulfilled") throw Error("No rollback accepted");
    await repo.fail(owner, projectId, accepted.value.operation.id, { code: "FIXTURE_DONE", message: "No sandbox" });
  });

  test("a late sandbox ID after cancel is still registered and must be destroyed", async () => {
    const { projectId, revisions } = await fixture();
    const started = await repo.begin(owner, projectId, request(revisions[0], revisions[2]));
    expect((await repo.cancel(owner, projectId, started.operation.id)).status).toBe("cancel_requested");
    const late = binding();
    expect((await repo.registerSandbox(owner, projectId, started.operation.id, late)).sandboxId).toBe(late.sandboxId);
    expect((await repo.fail(owner, projectId, started.operation.id, { code: "ROLLBACK_FAILED", message: "Late create" })).status).toBe("cleanup_pending");
    expect((await repo.markSandboxDestroyed(owner, projectId, started.operation.id, late.sandboxId)).status).toBe("cancelled");
    expect((await admin.query("SELECT current_revision_id,operation_id FROM nano.projects WHERE id=$1", [projectId])).rows[0])
      .toMatchObject({ current_revision_id: revisions[2], operation_id: null });
  });
});
