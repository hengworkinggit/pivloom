import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationService, type GenerationService } from "../../src/generation/service.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";

// Real isolated PostgreSQL, repository, service and OpenSandbox SDK. The HTTP
// sandbox deletion responses and the saved successful revision are fixtures;
// this does not claim a real model, Chrome or application-generation E2E.
describe.skipIf(process.env.PIVLOOM_RESTORE_CLEANUP_INTEGRATION !== "1")("durable preview restore cleanup", () => {
  const owner = randomUUID(), otherOwner = randomUUID(), profile = randomUUID();
  let admin: Pool, database: PivloomDatabase, service: GenerationService;
  const requests: string[] = [];
  const unavailable = new Set<string>();
  const remote = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const id = request.url?.split("/").at(-1) ?? "";
    response.writeHead(unavailable.has(id) ? 503 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: unavailable.has(id) ? "UNAVAILABLE" : "SANDBOX_NOT_FOUND", message: "Restore cleanup HTTP fixture" }));
  });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL) throw Error("Explicit isolated database required");
    const name = new URL(process.env.DATABASE_URL).pathname.slice(1);
    if (!/^pivloom_repair_test_[a-z0-9_]+$/.test(name)
      || new URL(process.env.MIGRATION_DATABASE_URL).pathname !== `/${name}`) throw Error("Dedicated repair database required");
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
    expect((await admin.query("SELECT current_database() AS name")).rows[0].name).toBe(name);
    expect((await admin.query("SELECT id FROM nano.runs LIMIT 1")).rowCount).toBe(0);
    await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw Error("HTTP fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    database = new PivloomDatabase(process.env.DATABASE_URL);
    service = createGenerationService({ database,
      models: createModelProfileService(database, createCredentialVault(randomBytes(32).toString("base64"))),
      identity: { appOrigin: "http://localhost:45231", supabaseUrl: origin, supabaseSecretKey: "unused-fixture", databaseUrl: process.env.DATABASE_URL },
      previewOrigin: "http://localhost:45311", sandbox: { baseUrl: origin, apiKey: "unused-fixture", image: "not-created" },
      bootId: randomUUID(), maxSandboxes: 2 });
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, otherOwner]);
      await admin.query("INSERT INTO nano.model_profiles(id,owner_id,current_version) VALUES($1,$2,1)", [profile, owner]);
      await admin.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask)
        VALUES($1,$2,1,'Restore cleanup fixture','openai-completions','https://fixture.invalid/v1','not-called','fixture')`, [profile, owner]);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
  }, 30_000);

  afterAll(async () => {
    await service?.close();
    await database?.close();
    if (admin) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_kind=NULL,operation_id=NULL WHERE owner_id=$1", [owner]);
        for (const table of ["preview_restores", "checks", "run_events", "messages", "sandboxes", "role_runs", "revisions", "runs", "model_credential_leases", "projects", "model_profile_versions", "model_profiles"])
          await admin.query(`DELETE FROM nano.${table} WHERE owner_id=$1`, [owner]);
        await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[owner, otherOwner]]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      await admin.end();
    }
    remote.closeAllConnections();
    if (remote.listening) await new Promise<void>(resolve => remote.close(() => resolve()));
  }, 30_000);

  async function successfulProject() {
    const projectId = randomUUID(), runId = randomUUID(), revisionId = randomUUID();
    const roleId = randomUUID(), leaseId = randomUUID(), oldSandboxId = randomUUID();
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO nano.projects(id,owner_id,title) VALUES($1,$2,'restore-cleanup-fixture')", [projectId, owner]);
      await admin.query("INSERT INTO nano.model_credential_leases(id,owner_id,profile_id,config_version,reference_id,released_at) VALUES($1,$2,$3,1,$4,now())", [leaseId, owner, profile, runId]);
      await admin.query(`INSERT INTO nano.runs(id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,
        model_profile_id,model_config_version,credential_lease_id,coordinator_role_run_id,state,phase,budget_json,deadline_at,executor_boot_id,finished_at)
        VALUES($1,$2,$3,$4,repeat('a',64),'Saved successful fixture','generate',$5,1,$6,$7,'completed','persist','{}',now()+interval '30 minutes',$8,now())`,
      [runId, owner, projectId, randomUUID(), profile, leaseId, roleId, randomUUID()]);
      await admin.query("INSERT INTO nano.role_runs(id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json) VALUES($1,$2,$3,$4,'coordinator',0,$5,'succeeded','{}')", [roleId, owner, projectId, runId, randomUUID()]);
      await admin.query(`INSERT INTO nano.revisions(id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,template_version,manifest_json,source_bytes,compressed_bytes,build_status,build_json,status)
        VALUES($1,$2,$3,$4,1,0,$5,repeat('a',64),'fixture','[]',10,10,'passed','{}','accepted')`, [revisionId, owner, projectId, runId, `${owner}/${projectId}/${revisionId}`]);
      await admin.query("UPDATE nano.projects SET current_revision_id=$2,next_revision_no=2 WHERE id=$1", [projectId, revisionId]);
      await admin.query(`INSERT INTO nano.sandboxes(owner_id,project_id,run_id,attempt,remote_id,revision_id,source_hash,purpose,state,expires_at)
        VALUES($1,$2,$3,0,$4,$5,repeat('a',64),'preview','active',now()+interval '30 minutes')`, [owner, projectId, runId, oldSandboxId, revisionId]);
      await admin.query("COMMIT");
      return { projectId, runId, revisionId, oldSandboxId };
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
  }

  test("an unconfirmed restore cleanup remains locked across boot, then only its own sandbox is reclaimed", async () => {
    const saved = await successfulProject();
    const repo = service.repository;
    const { restore } = await repo.beginRestore(owner, saved.projectId, { revisionId: saved.revisionId, idempotencyKey: randomUUID() });
    const sandboxId = randomUUID(), expiresAt = new Date(Date.now() + 600_000).toISOString();
    await expect(repo.registerRestoreSandbox(otherOwner, saved.projectId, restore.id, { sandboxId, expiresAt })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await repo.registerRestoreSandbox(owner, saved.projectId, restore.id, { sandboxId, expiresAt });
    const before = await repo.getRun(owner, saved.runId);
    expect((await repo.getPreviewBinding(owner, saved.projectId, saved.revisionId))?.state).toBe("creating");
    await repo.failRestore(owner, saved.projectId, restore.id, { code: "RESTORE_FAILED", message: "Trusted rebuild failed" });
    expect((await repo.getActiveRestore(owner, saved.projectId, saved.revisionId))?.status).toBe("pending");
    expect((await service.preview(owner, saved.projectId, saved.revisionId))?.error).toContain("清理待确认");
    await expect(repo.beginRestore(owner, saved.projectId, { revisionId: saved.revisionId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "PROJECT_BUSY" });

    unavailable.add(sandboxId);
    const start = requests.length;
    await service.recover();
    expect(requests.slice(start)).toEqual([`DELETE /v1/sandboxes/${sandboxId}`]);
    await expect(repo.beginRestore(owner, saved.projectId, { revisionId: saved.revisionId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    expect(await repo.getRun(owner, saved.runId)).toEqual(before);

    unavailable.delete(sandboxId);
    await service.recover();
    expect(requests.slice(start + 1)).toEqual([`DELETE /v1/sandboxes/${sandboxId}`, `GET /v1/sandboxes/${sandboxId}`]);
    expect((await repo.getActiveRestore(owner, saved.projectId, saved.revisionId))?.status).toBe("failed");
    const project = (await repo.readProjectSnapshot(owner, saved.projectId)).project;
    expect(project.currentRevisionId).toBe(saved.revisionId);
    const next = await repo.beginRestore(owner, saved.projectId, { revisionId: saved.revisionId, idempotencyKey: randomUUID() });
    expect(next.replayed).toBe(false);
    await repo.failRestore(owner, saved.projectId, next.restore.id, { code: "FIXTURE_DONE", message: "No remote created" });
    expect(await repo.getRun(owner, saved.runId)).toEqual(before);
    expect((await admin.query("SELECT state FROM nano.sandboxes WHERE remote_id=$1", [saved.oldSandboxId])).rows[0].state).toBe("active");
    expect((await admin.query("SELECT state FROM nano.sandboxes WHERE remote_id=$1", [sandboxId])).rows[0].state).toBe("destroyed");
  }, 30_000);

  test("only the registered restore sandbox can become ready and its later cleanup cannot alter the successful run", async () => {
    const saved = await successfulProject(), repo = service.repository;
    const { restore } = await repo.beginRestore(owner, saved.projectId, { revisionId: saved.revisionId, idempotencyKey: randomUUID() });
    const input = { sandboxId: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString() };
    await repo.registerRestoreSandbox(owner, saved.projectId, restore.id, input);
    await expect(repo.bindRestore(owner, saved.projectId, restore.id, { ...input, sandboxId: saved.oldSandboxId })).rejects.toMatchObject({ code: "RESTORE_BINDING_MISMATCH" });
    expect((await repo.bindRestore(owner, saved.projectId, restore.id, input)).status).toBe("ready");
    const before = await repo.getRun(owner, saved.runId);
    await repo.markRestoreSandboxDestroyed(owner, saved.projectId, restore.id, input.sandboxId);
    expect(await repo.getRun(owner, saved.runId)).toEqual(before);
    expect((await repo.getActiveRestore(owner, saved.projectId, saved.revisionId))?.status).toBe("ready");
    expect((await repo.readProjectSnapshot(owner, saved.projectId)).project.currentRevisionId).toBe(saved.revisionId);
  }, 30_000);
});
