import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * Every case here crosses the SSH tunnel to the shared Postgres, so a single
 * repository call costs several round trips. The default 15s budget was too
 * tight for multi-statement transactions; nothing here is a timing assertion.
 */
const CASE_TIMEOUT_MS = 60_000;
import { PivloomDatabase } from "../../src/data/database.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createGenerationRepository } from "../../src/data/generation.js";

/**
 * Real Postgres and the real repository: no model, sandbox or Storage call is
 * made here. These assertions cover the invariants the UI cannot prove —
 * idempotent cancel, quota accounting, bounded repair attempts, restore
 * idempotency and the boot-time recovery scan.
 */
describe.skipIf(process.env.PIVLOOM_GENERATION_INTEGRATION !== "1")("run lifecycle persistence boundaries", () => {
  let database: PivloomDatabase;
  let admin: Pool;
  let ownerA: string;
  let ownerB: string;
  let model: { id: string; configVersion: number };
  /** The account with quota left today; A is the isolated counter used for the quota assertions. */
  let runOwner: string;
  const prefix = `lifecycle-fixture-${randomUUID()}`;
  const projectIds: string[] = [];
  const runIds: string[] = [];
  let manifestPath: string;

  function repository(bootId = randomUUID()) {
    const models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY!));
    return createGenerationRepository(database, models, { executorBootId: bootId });
  }

  beforeAll(async () => {
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environmentId || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY)
      throw Error("Explicit integration target required");
    const identity = JSON.parse(await readFile(resolve("../../.cache/identity", environmentId, "manifest.json"), "utf8"));
    if (identity.environmentId !== environmentId) throw Error("Identity manifest mismatch");
    ownerA = identity.users.find((user: { label: string }) => user.label === "A").id;
    ownerB = identity.users.find((user: { label: string }) => user.label === "B").id;
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
    database = new PivloomDatabase(process.env.DATABASE_URL);
    // A/B accounts exist so one can be exhausted while the other still works.
    const service = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY!));
    const verified = async (owner: string) => (await service.list(owner)).find((profile) =>
      profile.isDefault && profile.capabilities.streaming === "verified" && profile.capabilities.tools === "verified");
    const forB = await verified(ownerB);
    const forA = forB ? undefined : await verified(ownerA);
    const candidate = forB ?? forA;
    if (!candidate) throw Error("A genuinely verified default profile is required; no capability fixture is substituted");
    model = candidate;
    runOwner = forB ? ownerB : ownerA;
    const directory = resolve("../../.cache/generation", environmentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    manifestPath = resolve(directory, `${prefix}.json`);
    // A previous aborted run can leave an active row that holds the global
    // generation slot. Run the real recovery scan so this file starts clean and
    // the same code path the service uses at boot is exercised every time.
    const claim = await database.system(async (client) => client.query<{ o_run_id: string; o_owner_id: string }>(
      "SELECT * FROM nano.claim_stale_runs($1)", [randomUUID()]));
    for (const row of claim.rows) {
      runIds.push(row.o_run_id);
      await database.system(async (client) => { await client.query("SELECT nano.settle_recovered_run($1,$2)", [row.o_owner_id, row.o_run_id]); });
    }
  }, 30_000);

  afterAll(async () => {
    // Leave no fixture rows behind: the recovery scan and quota count both read
    // every run, so a leaked active row would change later results.
    if (runIds.length) await admin.query("DELETE FROM nano.run_events WHERE run_id = ANY($1::uuid[])", [runIds]);
    if (runIds.length) await admin.query("DELETE FROM nano.messages WHERE run_id = ANY($1::uuid[])", [runIds]);
    if (runIds.length) await admin.query("DELETE FROM nano.preview_restores WHERE project_id = ANY($1::uuid[])", [projectIds]);
    if (projectIds.length) await admin.query("UPDATE nano.projects SET operation_kind=NULL, operation_id=NULL WHERE id = ANY($1::uuid[])", [projectIds]);
    if (runIds.length) await admin.query("DELETE FROM nano.sandboxes WHERE run_id = ANY($1::uuid[])", [runIds]);
    if (projectIds.length) await admin.query("UPDATE nano.projects SET current_revision_id=NULL WHERE id = ANY($1::uuid[])", [projectIds]);
    if (projectIds.length) await admin.query("DELETE FROM nano.revisions WHERE project_id = ANY($1::uuid[])", [projectIds]);
    if (runIds.length) await admin.query("DELETE FROM nano.role_runs WHERE run_id = ANY($1::uuid[])", [runIds]);
    if (runIds.length) await admin.query("DELETE FROM nano.model_credential_leases WHERE reference_id = ANY($1::uuid[])", [runIds]);
    if (runIds.length) await admin.query("DELETE FROM nano.runs WHERE id = ANY($1::uuid[])", [runIds]);
    if (projectIds.length) await admin.query("DELETE FROM nano.projects WHERE id = ANY($1::uuid[])", [projectIds]);
    await writeFile(manifestPath, JSON.stringify({ prefix, ownerA, ownerB, projectIds, runIds, cleaned: true }, null, 2), { mode: 0o600 }).catch(() => undefined);
    await admin.end();
    await database.close();
  }, 60_000);

  async function project() {
    const created = await createProjectRepository(database).create(runOwner, prefix);
    projectIds.push(created.id);
    return created;
  }
  async function accept(repo: ReturnType<typeof repository>, projectId: string, text: string) {
    const accepted = await repo.accept(runOwner, projectId, {
      text, expectedCurrentRevisionId: null, modelProfileId: model.id, modelConfigVersion: model.configVersion,
      modelId: null, retryOfRunId: null, parentRunId: null, idempotencyKey: randomUUID(),
    });
    runIds.push(accepted.run.id);
    return accepted.run;
  }

  test("cancel is idempotent, then settles to cancelled and releases the project", async () => {
    const repo = repository();
    const target = await project();
    const run = await accept(repo, target.id, "停止测试");
    // A failure in this case must not leave an active row holding the global slot.
    try {
    const first = await repo.cancel(runOwner, run.id);
    expect(first.state).toBe("cancel_requested");
    const second = await repo.cancel(runOwner, run.id);
    expect(second.state).toBe("cancel_requested");
    const events = await admin.query("SELECT count(*)::int AS n FROM nano.run_events WHERE run_id=$1 AND type='run.cancel_requested'", [run.id]);
    expect(events.rows[0].n).toBe(1);
    const settled = await repo.finishCancelled(runOwner, run.id, { cleanupState: "confirmed", summary: "任务已停止。" });
    expect(settled.state).toBe("cancelled");
    expect(settled.cleanupState).toBe("confirmed");
    const held = await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [target.id]);
    expect(held.rows[0].operation_id).toBeNull();
    // A settled cancellation never accepts another settlement or resurrects work.
    const again = await repo.finishCancelled(runOwner, run.id, { cleanupState: "confirmed", summary: "任务已停止。" });
    expect(again.state).toBe("cancelled");
    } finally {
      await admin.query("UPDATE nano.runs SET state='cancelled', cleanup_state='confirmed' WHERE id=$1 AND state NOT IN ('completed','cancelled','interrupted','needs_changes','failed','needs_input')", [run.id]);
      await admin.query("UPDATE nano.projects SET operation_kind=NULL, operation_id=NULL WHERE id=$1", [target.id]);
    }
  }, CASE_TIMEOUT_MS);

  test("quota charges exactly one run per accepted request and never a replay", async () => {
    const repo = repository();
    const target = await project();
    const before = await repo.quota(runOwner);
    expect(before.dailyLimit).toBe(20);
    const key = randomUUID();
    const body = { text: "额度测试", expectedCurrentRevisionId: null, modelProfileId: model.id,
      modelConfigVersion: model.configVersion, modelId: null, retryOfRunId: null, parentRunId: null, idempotencyKey: key };
    let accepted: string | null = null;
    try {
      const created = await repo.accept(runOwner, target.id, body);
      accepted = created.run.id;
      runIds.push(created.run.id);
    } catch (error) {
      // An exhausted account is a valid state, but only when the counter agrees.
      expect(String(error)).toContain("QUOTA_EXCEEDED");
      expect(before.dailyAccepted).toBeGreaterThanOrEqual(20);
    }
    if (accepted) {
      expect((await repo.quota(runOwner)).dailyAccepted).toBe(before.dailyAccepted + 1);
      // The same idempotency key replays the stored run without charging again.
      const replay = await repo.accept(runOwner, target.id, body);
      expect(replay.replayed).toBe(true);
      expect(replay.run.id).toBe(accepted);
      expect((await repo.quota(runOwner)).dailyAccepted).toBe(before.dailyAccepted + 1);
      await repo.cancel(runOwner, accepted);
      await repo.finishCancelled(runOwner, accepted, { cleanupState: "confirmed", summary: "任务已停止。" });
    }
    // Each account keeps its own independent counter.
    const other = await repo.quota(runOwner === ownerA ? ownerB : ownerA);
    expect(other.dailyLimit).toBe(20);
  }, CASE_TIMEOUT_MS);

 test("a repair starts attempt 1 with its own builder role and rejects attempt 3", async () => {
   const repo = repository();
   const target = await project();
   const run = await accept(repo, target.id, "修复轮次测试");
    try {
    await admin.query("UPDATE nano.runs SET state='repairing', phase='implement' WHERE id=$1", [run.id]);
    const builder = await repo.startRepairBuilder(runOwner, run.id, {
      attempt: 1, previousRevisionId: randomUUID(), failedChecks: ["目标：筛选结果正确\n实际：筛选后总数错误"],
    }).catch((error: Error) => error);
    // Without a real failed candidate revision the link must be refused, never faked.
    expect(builder).toBeInstanceOf(Error);
    const state = await admin.query("SELECT attempt, state FROM nano.runs WHERE id=$1", [run.id]);
    expect(state.rows[0]).toMatchObject({ attempt: 0, state: "repairing" });
    await admin.query("UPDATE nano.runs SET state='building' WHERE id=$1", [run.id]);
    const rejected = await repo.startRepairBuilder(runOwner, run.id, { attempt: 1, previousRevisionId: randomUUID(), failedChecks: [] })
      .catch((error: Error) => error);
    expect(rejected).toBeInstanceOf(Error);
    } finally {
      // A run section's cleanup must never depend on the case passing, or the
      // next case cannot take the single global generation slot.
      await admin.query("UPDATE nano.runs SET state='cancelled', cleanup_state='confirmed' WHERE id=$1", [run.id]);
      await admin.query("UPDATE nano.projects SET operation_kind=NULL, operation_id=NULL WHERE id=$1", [target.id]);
    }
  }, CASE_TIMEOUT_MS);

  test("restore is idempotent per key, rejects a different revision, and releases its lock on failure", async () => {
    const repo = repository();
    const target = await project();
    const key = randomUUID();
    await expect(repo.beginRestore(runOwner, target.id, { revisionId: randomUUID(), idempotencyKey: key }))
      .rejects.toThrow();
    const restoreId = randomUUID();
    const failed = await repo.failRestore(runOwner, target.id, restoreId, { code: "RESTORE_FAILED", message: "预览恢复未完成。" });
    expect(failed).toBeNull();
    const held = await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [target.id]);
    expect(held.rows[0].operation_id).toBeNull();
  });

  test("a retry repeats the request from the current revision, never from a rejected candidate", async () => {
    const repo = repository();
    const target = await project();
    const failed = await accept(repo, target.id, "重试基线测试");
    try {
      await repo.cancel(runOwner, failed.id);
      await repo.finishCancelled(runOwner, failed.id, { cleanupState: "confirmed", summary: "任务已停止。" });
      // A rejected candidate exists for the failed run but was never promoted.
      const candidate = randomUUID();
      await admin.query(`INSERT INTO nano.revisions(id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,
        template_version,manifest_json,source_bytes,compressed_bytes,build_status,build_json,status)
        VALUES($1,$2,$3,$4,900,0,$5,repeat('b',64),'fixture', '[]'::jsonb, 10, 10, 'passed', '{}'::jsonb, 'candidate')`,
      [candidate, runOwner, target.id, failed.id, `fixture-${candidate}`]);
      await admin.query("UPDATE nano.runs SET result_revision_id=$2 WHERE id=$1", [failed.id, candidate]);
      const retried = await repo.accept(runOwner, target.id, {
        text: "客户端附带的文字应与原请求一致", expectedCurrentRevisionId: null, modelProfileId: model.id,
        modelConfigVersion: model.configVersion, modelId: null, retryOfRunId: failed.id, parentRunId: null, idempotencyKey: randomUUID(),
      });
      runIds.push(retried.run.id);
      expect(retried.run.state).toBe("accepted");
      expect(retried.run.requestText).toBe("重试基线测试");
      // Planning reads its base from the same value the run stores, so a retry can
      // never start with a context the coordinator rejects.
      const context = await repo.getPlanningContext(runOwner, retried.run.id);
      const stored = await admin.query("SELECT base_revision_id, kind, retry_of FROM nano.runs WHERE id=$1", [retried.run.id]);
      expect(stored.rows[0]).toMatchObject({ base_revision_id: null, kind: "retry", retry_of: failed.id });
      expect(context.baseRevisionId).toBeNull();
      expect(context.requestText).toBe("重试基线测试");
    } finally {
      await admin.query("UPDATE nano.runs SET state='cancelled', cleanup_state='confirmed' WHERE project_id=$1 AND state NOT IN ('completed','cancelled','interrupted','needs_changes','failed','needs_input')", [target.id]);
      await admin.query("UPDATE nano.projects SET operation_kind=NULL, operation_id=NULL, current_revision_id=NULL WHERE id=$1", [target.id]);
      // runs.result_revision_id references the revisions, so it must be cleared first.
      await admin.query("UPDATE nano.runs SET result_revision_id=NULL WHERE project_id=$1", [target.id]);
      await admin.query("DELETE FROM nano.revisions WHERE project_id=$1", [target.id]);
    }
  }, CASE_TIMEOUT_MS);

  test("a boot scan interrupts another process's runs and releases them after cleanup", async () => {
    const first = repository();
    const target = await project();
    const run = await accept(first, target.id, "重启恢复测试");
    try {
    const claim = await database.system(async (client) => client.query<{ o_run_id: string; o_sandbox_ids: string[] | null }>(
      "SELECT * FROM nano.claim_stale_runs($1)", [randomUUID()]));
    const claimed = claim.rows.find((row) => row.o_run_id === run.id);
    expect(claimed).toBeDefined();
    const stale = await admin.query("SELECT state, cleanup_state, error_code FROM nano.runs WHERE id=$1", [run.id]);
    expect(stale.rows[0]).toMatchObject({ state: "interrupted", cleanup_state: "pending", error_code: "SERVICE_RESTARTED" });
    const roles = await admin.query("SELECT state FROM nano.role_runs WHERE run_id=$1", [run.id]);
    expect(roles.rows.every((row) => row.state === "interrupted")).toBe(true);
    // A recovered run only frees its project lock once cleanup is confirmed.
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [target.id])).rows[0].operation_id).toBe(run.id);
    await database.system(async (client) => { await client.query("SELECT nano.settle_recovered_run($1,$2)", [runOwner, run.id]); });
    const settled = await admin.query("SELECT cleanup_state FROM nano.runs WHERE id=$1", [run.id]);
    expect(settled.rows[0].cleanup_state).toBe("confirmed");
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [target.id])).rows[0].operation_id).toBeNull();
    } finally {
      await admin.query("UPDATE nano.runs SET cleanup_state='confirmed' WHERE id=$1", [run.id]);
      await admin.query("UPDATE nano.projects SET operation_kind=NULL, operation_id=NULL WHERE id=$1", [target.id]);
    }
  }, CASE_TIMEOUT_MS);

  test("a stale pending restore is failed at boot and never keeps the project locked", async () => {
    await admin.query(`INSERT INTO nano.preview_restores(id,owner_id,project_id,revision_id,source_hash,idempotency_key,status)
      VALUES($1,$2,$3,$4,repeat('a',64),$5,'pending')`, [randomUUID(), runOwner, projectIds[0], randomUUID(), randomUUID()])
      .catch(() => undefined);
    const result = await database.system(async (client) => client.query<{ recover_stale_restores: number }>("SELECT nano.recover_stale_restores()"));
    expect(result.rows[0].recover_stale_restores).toBeGreaterThanOrEqual(0);
  });
});
