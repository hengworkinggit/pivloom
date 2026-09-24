import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Plan } from "@pivloom/contracts";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationRepository, type GenerationRepository } from "../../src/data/generation.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";

// Repository + real isolated PostgreSQL. Model metadata and failed builds below
// are explicitly persistence fixtures; no model, Storage or sandbox is called.
describe.skipIf(process.env.PIVLOOM_REPAIR_INTEGRATION !== "1")("build failure repair persistence", () => {
  const owner = randomUUID();
  const otherOwner = randomUUID();
  const profile = randomUUID();
  let admin: Pool;
  let database: PivloomDatabase;
  let repo: ReturnType<typeof createGenerationRepository>;
  let models: ReturnType<typeof createModelProfileService>;
  const plan: Plan = { schemaVersion: 2, goal: "生成计数器", changeSummary: "增加计数按钮", assumptions: [], outOfScope: [],
    behaviors: [
      { id: "B01", title: "增加计数", precondition: "初始为0", action: "点击加一", expected: "显示1", required: true },
      { id: "B02", title: "连续计数", precondition: "显示1", action: "再次点击加一", expected: "显示2", required: true },
      { id: "B03", title: "重置计数", precondition: "显示2", action: "点击重置", expected: "显示0", required: true },
      { id: "B04", title: "刷新保留", precondition: "显示2", action: "刷新页面", expected: "计数仍为2", required: true },
      { id: "B05", title: "窄屏点击", precondition: "视口宽390像素", action: "点击加一", expected: "按钮可用且无横向溢出", required: true },
    ],
    groups: [
      { id: "G1", title: "基本运算", behaviorIds: ["B01"] },
      { id: "G2", title: "连续输入", behaviorIds: ["B02"] },
      { id: "G3", title: "错误恢复", behaviorIds: ["B03"] },
      { id: "G4", title: "状态保留", behaviorIds: ["B04"] },
      { id: "G5", title: "视觉布局", behaviorIds: ["B05"] },
    ], replacements: [] };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL) throw Error("Explicit isolated database required");
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
    const name = (await admin.query("SELECT current_database() AS name")).rows[0].name as string;
    if (!name.startsWith("pivloom_repair_test_")) throw Error("Repair fixtures require a pivloom_repair_test_ database, never the live database");
    database = new PivloomDatabase(process.env.DATABASE_URL);
    const vault = createCredentialVault(randomBytes(32).toString("base64"));
    const credential = vault.seal("fixture-unused-model-key", { ownerId: owner, profileId: profile, version: 1 });
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, otherOwner]);
      await admin.query("INSERT INTO nano.model_profiles(id,owner_id,current_version,is_default) VALUES($1,$2,1,true)", [profile, owner]);
      await admin.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask,capabilities)
        VALUES($1,$2,1,'Persistence fixture','openai-completions','https://fixture.invalid/v1','fixture','masked',
        '{"streaming":"verified","tools":"verified","vision":"verified"}')`, [profile, owner]);
      await admin.query("INSERT INTO nano.model_credentials(profile_id,owner_id,config_version,ciphertext,nonce,auth_tag) VALUES($1,$2,1,$3,$4,$5)",
        [profile, owner, credential.ciphertext, credential.nonce, credential.authTag]);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    models = createModelProfileService(database, vault);
    repo = createGenerationRepository(database, models, { executorBootId: randomUUID(), maxSandboxes: 5,
      dailyLimitByOwner: { [owner]: 1000 } });
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_kind=NULL,operation_id=NULL WHERE owner_id=$1", [owner]);
        for (const table of ["run_events", "messages", "preview_restores", "checks", "sandboxes", "role_runs", "revisions", "runs", "model_credential_leases", "projects", "model_credentials", "model_profile_versions", "model_profiles"]) {
          await admin.query(`DELETE FROM nano.${table} WHERE owner_id=$1`, [owner]);
        }
        await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[owner, otherOwner]]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      await admin.end();
    }
    await database?.close();
  }, 60_000);

  /** Claims one specific queued task the way the scheduler does, so a test can
   *  drive the executor directly. Returns null when capacity/project is busy. */
  async function claimForTest(repo: GenerationRepository, ownerId: string, runId: string) {
    const claimed = await repo.claimNextQueuedRun(runId);
    if (!claimed) return null;
    const prepared = await repo.prepareDispatch(ownerId, claimed.id);
    if (prepared.outcome !== "ready") throw Error(`fixture task parked: ${prepared.run.error?.code ?? "unknown"}`);
    return prepared.run;
  }

  async function building() {
    const project = await createProjectRepository(database).create(owner, "build-repair-fixture");
    const { run } = await repo.accept(owner, project.id, { text: "生成计数器", expectedCurrentRevisionId: null,
      modelProfileId: profile, modelConfigVersion: 1, idempotencyKey: randomUUID() });
    // No scheduler runs in this suite, so the test claims this exact queued task
    // the way dispatch would before any role may start on it.
    const claimed = await claimForTest(repo, owner, run.id);
    if (!claimed) throw Error("build-repair fixture task was not claimable");
    try {
      const coordinator = await repo.startCoordinator(owner, claimed.id);
      await repo.submitPlan(owner, claimed.id, { roleRunId: coordinator.id, attempt: 0, plan });
      const builder = await repo.startBuilder(owner, claimed.id);
      return { project, run: claimed, builder };
    } catch (error) {
      // A failed fixture setup must settle the task it claimed, otherwise its
      // capacity slot and project operation lock leak into the next test and
      // that fixture can no longer be dispatched.
      await repo.finishFailed(owner, claimed.id, { code: "FIXTURE_SETUP_FAILED", message: "Fixture setup failed", retryable: false,
        cleanupState: "confirmed" }).catch(() => undefined);
      throw error;
    }
  }

  async function failedCandidate(projectId: string, runId: string, attempt: number) {
    const id = randomUUID();
    await admin.query(`INSERT INTO nano.revisions(id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,
      template_version,manifest_json,source_bytes,compressed_bytes,build_status,build_json,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,repeat('a',64),'fixture','[]',10,10,'failed',$8,'candidate')`,
    [id, owner, projectId, runId, attempt + 1, attempt, `${owner}/${projectId}/${id}`, {
      schemaVersion: 1, sourceHash: "a".repeat(64),
      typecheck: { command: "tsc --noEmit", exitCode: 2, durationMs: 10, stdoutTail: "TypeScript: unknown identifier", stderrTail: "" }, build: null,
    }]);
    await admin.query("UPDATE nano.runs SET result_revision_id=$2 WHERE id=$1", [runId, id]);
    return id;
  }

  test("a saved failed build keeps the run lease and operation, then hands its snapshot to a new Builder", async () => {
    const { project, run, builder } = await building();
    try {
      const revisionId = await failedCandidate(project.id, run.id, 0);
      const completed = await repo.finishBuildFailure(owner, run.id, { revisionId, code: "TYPECHECK_FAILED", message: "TypeScript: unknown identifier" });
      expect(completed).toMatchObject({ run: { state: "repairing", attempt: 0, finishedAt: null }, revision: { id: revisionId, buildStatus: "failed", status: "candidate" }, repairNextAttempt: 1 });
      expect((await repo.readProjectSnapshot(owner, project.id)).project.currentRevisionId).toBeNull();
      const retained = (await admin.query(`SELECT p.operation_id,l.released_at FROM nano.projects p JOIN nano.runs r ON r.project_id=p.id
        JOIN nano.model_credential_leases l ON l.id=r.credential_lease_id WHERE r.id=$1`, [run.id])).rows[0];
      expect(retained).toMatchObject({ operation_id: run.id, released_at: null });
      const repair = await repo.startRepairBuilder(owner, run.id, { attempt: 1, previousRevisionId: revisionId, failedChecks: ["TypeScript: unknown identifier"] });
      expect(repair.predecessorId).toBe(builder.id);
      expect(repair.sessionId).not.toBe(builder.sessionId);
      expect(repair.input).toMatchObject({ fromRoleRunId: builder.id, expectedRevisionId: revisionId, sourceHash: "a".repeat(64), attempt: 1 });
      expect(repair.input?.task).toContain("构建");
    } finally {
      await repo.finishFailed(owner, run.id, { code: "FIXTURE_DONE", message: "No external calls", retryable: false, cleanupState: "confirmed" });
    }
  }, 120_000);

  test("three genuine failed-build transitions stop at attempt 2 and release the lease without promoting a candidate", async () => {
    const { project, run } = await building();
    const revisions: string[] = [];
    try {
      for (const attempt of [0, 1, 2]) {
        const revisionId = await failedCandidate(project.id, run.id, attempt);
        revisions.push(revisionId);
        const result = await repo.finishBuildFailure(owner, run.id, { revisionId, code: "TYPECHECK_FAILED", message: `TypeScript failure ${attempt}` });
        expect(result.run.deadlineAt).toBe(run.deadlineAt);
        expect(result.run.credentialLeaseId).toBe(run.credentialLeaseId);
        expect(result.repairNextAttempt).toBe(attempt < 2 ? attempt + 1 : null);
        if (attempt < 2) {
          await repo.startRepairBuilder(owner, run.id, { attempt: attempt + 1, previousRevisionId: revisionId, failedChecks: [`TypeScript failure ${attempt}`] });
          await repo.startBuilder(owner, run.id);
        } else {
          expect(result).toMatchObject({ run: { state: "needs_changes", attempt: 2 }, revision: { id: revisionId, status: "rejected" } });
          expect(result.run.finishedAt).not.toBeNull();
        }
      }
      await expect(repo.startRepairBuilder(owner, run.id, { attempt: 3, previousRevisionId: revisions[2], failedChecks: ["still broken"] }))
        .rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
      const snapshot = await repo.readRunSnapshot(owner, run.id);
      expect(snapshot.roles.filter((role) => role.role === "builder").map((role) => role.attempt)).toEqual([0, 1, 2]);
      expect(new Set(snapshot.roles.filter((role) => role.role === "builder").map((role) => role.sessionId)).size).toBe(3);
      expect(snapshot.roles.filter((role) => role.role === "reviewer")).toHaveLength(0);
      expect(snapshot.events.filter((event) => event.type === "run.finished")).toHaveLength(1);
      expect((await repo.listProjectRevisions(owner, project.id)).map((revision) => revision.id).sort()).toEqual(revisions.sort());
      const released = (await admin.query(`SELECT p.operation_id,p.current_revision_id,l.released_at FROM nano.projects p
        JOIN nano.runs r ON r.project_id=p.id JOIN nano.model_credential_leases l ON l.id=r.credential_lease_id WHERE r.id=$1`, [run.id])).rows[0];
      expect(released).toMatchObject({ operation_id: null, current_revision_id: null });
      expect(released.released_at).not.toBeNull();
    } finally {
      await repo.finishFailed(owner, run.id, { code: "FIXTURE_DONE", message: "No external calls", retryable: false, cleanupState: "confirmed" });
    }
  }, 180_000);

  test("a stale build record and a cancellation cannot enter repair or replace current", async () => {
    const { project, run } = await building();
    try {
      const revisionId = await failedCandidate(project.id, run.id, 0);
      const input = { revisionId, code: "TYPECHECK_FAILED" as const, message: "failure" };
      await expect(repo.finishBuildFailure(otherOwner, run.id, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await admin.query("UPDATE nano.revisions SET build_json=jsonb_set(build_json,'{sourceHash}',to_jsonb(repeat('b',64))) WHERE id=$1", [revisionId]);
      await expect(repo.finishBuildFailure(owner, run.id, input)).rejects.toMatchObject({ code: "BUILD_NOT_VERIFIED" });
      expect((await repo.getRun(owner, run.id)).state).toBe("building");
      await repo.cancel(owner, run.id);
      await expect(repo.finishBuildFailure(owner, run.id, input)).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
      expect((await repo.readProjectSnapshot(owner, project.id)).project.currentRevisionId).toBeNull();
    } finally {
      await repo.finishCancelled(owner, run.id, { cleanupState: "confirmed", summary: "fixture cleanup" });
    }
  }, 120_000);

  test("an owner-specific daily quota is used consistently by admission and display without changing other owners", async () => {
    const limited = createGenerationRepository(database, models, { executorBootId: randomUUID(), maxSandboxes: 5, dailyLimitByOwner: { [owner]: 1 } });
    const raised = createGenerationRepository(database, models, { executorBootId: randomUUID(), maxSandboxes: 5, dailyLimitByOwner: { [owner]: 100 } });
    const before = await raised.quota(owner);
    expect(before.dailyLimit).toBe(100);
    expect((await raised.quota(otherOwner)).dailyLimit).toBe(20);
    const project = await createProjectRepository(database).create(owner, "quota-override-fixture");
    const input = { text: "生成计数器", expectedCurrentRevisionId: null, modelProfileId: profile, modelConfigVersion: 1, idempotencyKey: randomUUID() };
    const accepted = await raised.accept(owner, project.id, input);
    try {
      expect(accepted.replayed).toBe(false);
      // A replay remains valid even when that owner is now at the configured
      // limit; it neither creates a second Run nor spends quota a second time.
      expect((await limited.accept(owner, project.id, input)).run.id).toBe(accepted.run.id);
      expect((await raised.quota(owner)).dailyAccepted).toBe(before.dailyAccepted + 1);
    } finally {
      // The task never started, so it holds no project operation lock: a queued
      // run settles immediately and terminally through cancel.
      await raised.cancel(owner, accepted.run.id);
    }
    const next = { ...input, idempotencyKey: randomUUID() };
    await expect(limited.accept(owner, project.id, next)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect((await raised.quota(owner)).dailyAccepted).toBe(before.dailyAccepted + 1);
    const admitted = await raised.accept(owner, project.id, next);
    try {
      expect(admitted.replayed).toBe(false);
      expect((await raised.quota(owner)).dailyAccepted).toBe(before.dailyAccepted + 2);
    } finally {
      await raised.cancel(owner, admitted.run.id);
    }
  }, 90_000);
});
