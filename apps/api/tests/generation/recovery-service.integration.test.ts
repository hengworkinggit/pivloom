import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationService, type GenerationService } from "../../src/generation/service.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";

/**
 * The boot scan is global, so this suite must never use the shared application
 * database. The dedicated database must already have the real migrations.
 * Only the remote OpenSandbox HTTP boundary is a fixture; the service, SDK,
 * repository and PostgreSQL recovery functions all run unchanged.
 */
describe.skipIf(!process.env.PIVLOOM_RECOVERY_DATABASE_URL)("generation service restart recovery", () => {
  let admin: Pool;
  let database: PivloomDatabase;
  let service: GenerationService;
  let remoteUrl: string;
  const extraServices: GenerationService[] = [];
  const ownerId = randomUUID();
  const profileId = randomUUID();
  const projectIds: string[] = [];
  const requests: string[] = [];
  const unavailable = new Set<string>();
  const remote = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const id = request.url?.split("/").at(-1) ?? "";
    response.writeHead(unavailable.has(id) ? 503 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: unavailable.has(id) ? "UNAVAILABLE" : "SANDBOX_NOT_FOUND", message: "Recovery HTTP fixture" }));
  });

  beforeAll(async () => {
    const databaseUrl = process.env.PIVLOOM_RECOVERY_DATABASE_URL!;
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    if (!/^pivloom_recovery_test_[a-z0-9_]+$/.test(databaseName))
      throw new Error("Recovery tests require a dedicated pivloom_recovery_test_* database");
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    const current = await admin.query<{ database: string }>("SELECT current_database() AS database");
    expect(current.rows[0].database).toBe(databaseName);
    // No recovery call can touch a run belonging to another test or user.
    expect((await admin.query("SELECT id FROM nano.runs LIMIT 1")).rowCount).toBe(0);
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Recovery HTTP fixture unavailable");
    remoteUrl = `http://127.0.0.1:${address.port}`;
    database = new PivloomDatabase(databaseUrl);
    service = createGenerationService({
      database,
      models: createModelProfileService(database, createCredentialVault(randomBytes(32).toString("base64"))),
      identity: { appOrigin: "http://localhost:45231", supabaseUrl: remoteUrl,
        supabaseSecretKey: "unused-recovery-fixture", databaseUrl },
      sandbox: { baseUrl: remoteUrl, apiKey: "unused-recovery-fixture", image: "never-created" },
      previewOrigin: "http://localhost:45311", bootId: randomUUID(), maxSandboxes: 2, recoverySweepMs: 3_600_000,
    });
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO auth.users(id) VALUES($1)", [ownerId]);
      await client.query("INSERT INTO nano.model_profiles(id,owner_id,current_version) VALUES($1,$2,1)", [profileId, ownerId]);
      await client.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask)
        VALUES($1,$2,1,'Recovery fixture','openai-completions',$3,'never-called','fixture')`, [profileId, ownerId, remoteUrl]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    for (const extra of extraServices) await extra.close();
    await service?.close();
    await database?.close();
    if (admin) {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM nano.run_events WHERE project_id = ANY($1::uuid[])", [projectIds]);
        await client.query("DELETE FROM nano.sandboxes WHERE project_id = ANY($1::uuid[])", [projectIds]);
        await client.query("DELETE FROM nano.role_runs WHERE project_id = ANY($1::uuid[])", [projectIds]);
        await client.query("DELETE FROM nano.runs WHERE project_id = ANY($1::uuid[])", [projectIds]);
        await client.query("DELETE FROM nano.model_credential_leases WHERE owner_id=$1", [ownerId]);
        await client.query("DELETE FROM nano.projects WHERE id = ANY($1::uuid[])", [projectIds]);
        await client.query("DELETE FROM nano.model_profile_versions WHERE profile_id=$1", [profileId]);
        await client.query("DELETE FROM nano.model_profiles WHERE id=$1", [profileId]);
        await client.query("DELETE FROM auth.users WHERE id=$1", [ownerId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
        await admin.end();
      }
    }
    remote.closeAllConnections();
    if (remote.listening) await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()));
  }, 30_000);

  async function previousRun(state: "building" | "interrupted" = "building") {
    const projectId = randomUUID(), runId = randomUUID(), roleId = randomUUID(), leaseId = randomUUID();
    const sandboxId = randomUUID();
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO nano.projects(id,owner_id,title,operation_kind,operation_id,operation_started_at) VALUES($1,$2,'Recovery fixture','generate',$3,now())",
        [projectId, ownerId, runId]);
      await client.query("INSERT INTO nano.model_credential_leases(id,owner_id,profile_id,config_version,reference_id) VALUES($1,$2,$3,1,$4)",
        [leaseId, ownerId, profileId, runId]);
      await client.query(`INSERT INTO nano.runs(id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,
        model_profile_id,model_config_version,credential_lease_id,coordinator_role_run_id,state,phase,cleanup_state,
        budget_json,deadline_at,executor_boot_id,error_code,error_message,error_retryable)
        VALUES($1,$2,$3,$4,repeat('a',64),'Preserve this accepted request','generate',$5,1,$6,$7,$8,'cleanup',$9,
          '{}'::jsonb,now()+interval '30 minutes',$10,$11,$12,true)`,
        [runId, ownerId, projectId, randomUUID(), profileId, leaseId, roleId, state,
          state === "interrupted" ? "pending" : "clear", randomUUID(),
          state === "interrupted" ? "SERVICE_RESTARTED" : null, state === "interrupted" ? "Original restart failure" : null]);
      await client.query("INSERT INTO nano.role_runs(id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json) VALUES($1,$2,$3,$4,'coordinator',0,$5,'running','{}')",
        [roleId, ownerId, projectId, runId, randomUUID()]);
      await client.query(`INSERT INTO nano.sandboxes(owner_id,project_id,run_id,attempt,remote_id,purpose,state,expires_at)
        VALUES($1,$2,$3,0,$4,'candidate','active',now()+interval '30 minutes')`, [ownerId, projectId, runId, sandboxId]);
      await client.query("COMMIT");
      projectIds.push(projectId);
      return { projectId, runId, sandboxId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  test("boot recovery destroys the claimed sandbox and releases the interrupted run's project", async () => {
    const previous = await previousRun();
    expect(await service.recover()).toBe(1);
    expect(requests).toEqual([`DELETE /v1/sandboxes/${previous.sandboxId}`, `GET /v1/sandboxes/${previous.sandboxId}`]);
    const detail = await service.runDetail(ownerId, previous.runId);
    expect(detail.run).toMatchObject({ state: "interrupted", cleanupState: "confirmed",
      requestText: "Preserve this accepted request", error: { code: "SERVICE_RESTARTED" } });
    expect(detail.roles).toHaveLength(1);
    expect(detail.roles[0].state).toBe("interrupted");
    expect(detail.events.filter((event) => event.type === "run.finished")).toHaveLength(1);
    expect((await service.projectDetail(ownerId, previous.projectId)).activeRun).toBeNull();
    const project = await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [previous.projectId]);
    expect(project.rows[0].operation_id).toBeNull();
    expect(await service.recover()).toBe(0);
    expect(requests).toHaveLength(2);
  }, 30_000);

  test("an unconfirmed cleanup stays blocked, then a later recovery settles it without rewriting its terminal result", async () => {
    const previous = await previousRun("interrupted");
    unavailable.add(previous.sandboxId);
    const start = requests.length;
    expect(await service.recover()).toBe(1);
    expect(requests.slice(start)).toEqual([`DELETE /v1/sandboxes/${previous.sandboxId}`]);
    const blocked = await service.runDetail(ownerId, previous.runId);
    expect(blocked.run).toMatchObject({ state: "interrupted", cleanupState: "pending",
      error: { message: "Original restart failure" } });
    expect(blocked.events.filter((event) => event.type === "run.finished")).toHaveLength(0);
    expect((await service.projectDetail(ownerId, previous.projectId)).activeRun?.id).toBe(previous.runId);
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [previous.projectId])).rows[0].operation_id).toBe(previous.runId);

    unavailable.delete(previous.sandboxId);
    expect(await service.recover()).toBe(1);
    expect(requests.slice(start + 1)).toEqual([`DELETE /v1/sandboxes/${previous.sandboxId}`, `GET /v1/sandboxes/${previous.sandboxId}`]);
    const settled = await service.runDetail(ownerId, previous.runId);
    expect(settled.run).toMatchObject({ state: "interrupted", cleanupState: "confirmed",
      error: { message: "Original restart failure" } });
    expect(settled.events.filter((event) => event.type === "run.finished")).toHaveLength(0);
    expect((await service.projectDetail(ownerId, previous.projectId)).activeRun).toBeNull();
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [previous.projectId])).rows[0].operation_id).toBeNull();
  }, 60_000);

  test("background reconciliation retries a recovered pending cleanup without another API restart", async () => {
    const previous = await previousRun("interrupted");
    unavailable.add(previous.sandboxId);
    const restarted = createGenerationService({
      database,
      models: createModelProfileService(database, createCredentialVault(randomBytes(32).toString("base64"))),
      identity: { appOrigin: "http://localhost:45231", supabaseUrl: remoteUrl,
        supabaseSecretKey: "unused-recovery-fixture", databaseUrl: process.env.PIVLOOM_RECOVERY_DATABASE_URL! },
      sandbox: { baseUrl: remoteUrl, apiKey: "unused-recovery-fixture", image: "never-created" },
      previewOrigin: "http://localhost:45311", bootId: randomUUID(), maxSandboxes: 2, recoverySweepMs: 50,
    });
    extraServices.push(restarted);
    const deadline = Date.now() + 30_000;
    while (!requests.some((request) => request === `DELETE /v1/sandboxes/${previous.sandboxId}`) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await admin.query("SELECT cleanup_state FROM nano.runs WHERE id=$1", [previous.runId])).rows[0].cleanup_state).toBe("pending");
    unavailable.delete(previous.sandboxId);
    let cleanup = "pending";
    while (cleanup !== "confirmed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanup = (await admin.query("SELECT cleanup_state FROM nano.runs WHERE id=$1", [previous.runId])).rows[0].cleanup_state;
    }
    expect(cleanup).toBe("confirmed");
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [previous.projectId])).rows[0].operation_id).toBeNull();
    expect((await restarted.runDetail(ownerId, previous.runId)).run.error?.message).toBe("Original restart failure");
  }, 60_000);
});
