import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { GroupedPlan, Plan, RoleUsage, RunEvent } from "@pivloom/contracts";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationRepository, type GenerationRepository } from "../../src/data/generation.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createCredentialVault } from "../../src/models/credentials.js";

describe.skipIf(process.env.PIVLOOM_PLANNING_INTEGRATION !== "1")("planning through the real repository boundary", () => {
  let database: PivloomDatabase;
  let admin: Pool;
  let generation: ReturnType<typeof createGenerationRepository>;
  let ownerA: string;
  let ownerB: string;
  let model: { id: string; configVersion: number };
  let models: ReturnType<typeof createModelProfileService>;
  let targetVerified = false;
  const fixtureProfileId = randomUUID();
  let manifestPath: string;
  const prefix = `planning-fixture-${randomUUID()}`;
  const projectIds: string[] = [];
  const runIds: string[] = [];
  const leaseIds: string[] = [];
  let cleanupVerifiedAt: string | null = null;
  const save = () => writeFile(manifestPath, JSON.stringify({ prefix, ownerA, ownerB, projectIds, runIds, leaseIds, cleanupVerifiedAt }, null, 2), { mode: 0o600 });

  beforeAll(async () => {
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environmentId || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL) throw Error("Explicit integration target required");
    ownerA = randomUUID(); ownerB = randomUUID();
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
    const databaseName = (await admin.query("SELECT current_database() AS name")).rows[0].name as string;
    if (!databaseName.startsWith("pivloom_e2e_test_")) throw Error("Planning fixtures require an isolated e2e database");
    if ((await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true")).rows[0]?.environment_id !== environmentId) throw Error("Database target mismatch");
    targetVerified = true;
    const directory = resolve("../../.cache/planning", environmentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    manifestPath = resolve(directory, `${prefix}.json`);
    await save();
    database = new PivloomDatabase(process.env.DATABASE_URL);
    const vault = createCredentialVault(randomBytes(32).toString("base64"));
    const credential = vault.seal("fixture-only-unused-model-key", { ownerId: ownerA, profileId: fixtureProfileId, version: 1 });
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO auth.users(id) VALUES($1),($2)", [ownerA, ownerB]);
      await admin.query("INSERT INTO nano.model_profiles(id,owner_id,current_version,is_default) VALUES($1,$2,1,true)", [fixtureProfileId, ownerA]);
      await admin.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask,capabilities)
        VALUES($1,$2,1,'Planning fixture','openai-completions','https://fixture.invalid/v1','fixture','masked',
          '{"streaming":"verified","tools":"verified","vision":"verified"}')`, [fixtureProfileId, ownerA]);
      await admin.query("INSERT INTO nano.model_credentials(profile_id,owner_id,config_version,ciphertext,nonce,auth_tag) VALUES($1,$2,1,$3,$4,$5)",
        [fixtureProfileId, ownerA, credential.ciphertext, credential.nonce, credential.authTag]);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    models = createModelProfileService(database, vault);
    model = { id: fixtureProfileId, configVersion: 1 };
    generation = createGenerationRepository(database, models, { executorBootId: randomUUID(),
      maxSandboxes: 5, dailyLimitByOwner: { [ownerA]: 1000 } });
  }, 30_000);

  async function project() {
    const created = await createProjectRepository(database).create(ownerA, prefix);
    projectIds.push(created.id);
    await save();
    return created.id;
  }
  const request = (text = "生成活动报名页") => ({ text, idempotencyKey: randomUUID(), expectedCurrentRevisionId: null, modelProfileId: model.id, modelConfigVersion: model.configVersion });

  /** Claims one specific queued task exactly as the scheduler does, so this suite
   *  can drive the repository directly. Returns null when capacity or the project
   *  is busy. */
  async function claimForTest(repo: GenerationRepository, ownerId: string, runId: string) {
    const claimed = await repo.claimNextQueuedRun(runId);
    if (!claimed) return null;
    const prepared = await repo.prepareDispatch(ownerId, claimed.id);
    if (prepared.outcome !== "ready") throw Error(`fixture task parked: ${prepared.run.error?.code ?? "unknown"}`);
    return prepared.run;
  }
  const plan: GroupedPlan = { schemaVersion: 2, goal: "收集活动报名", changeSummary: "增加报名表与明确提交反馈", assumptions: ["演示数据仅保存在当前浏览器"],
    outOfScope: ["真实支付与跨用户数据库"], behaviors: [
      { id: "B01", title: "提交报名", precondition: "报名表已打开", action: "填写姓名后点击报名", expected: "显示报名成功和填写的姓名", required: true },
      { id: "B02", title: "输入校验", precondition: "姓名为空", action: "点击报名", expected: "提示填写姓名", required: true },
      { id: "B03", title: "重复提交", precondition: "已经报名", action: "再次点击报名", expected: "不会重复新增", required: true },
      { id: "B04", title: "刷新保留", precondition: "已有报名记录", action: "刷新页面", expected: "报名记录仍显示", required: true },
      { id: "B05", title: "窄屏布局", precondition: "视口宽390像素", action: "填写姓名并报名", expected: "页面不溢出且提交可用", required: true },
    ], groups: [
      { id: "G1", title: "报名提交", behaviorIds: ["B01"] },
      { id: "G2", title: "输入编辑", behaviorIds: ["B02"] },
      { id: "G3", title: "错误恢复", behaviorIds: ["B03"] },
      { id: "G4", title: "状态保留", behaviorIds: ["B04"] },
      { id: "G5", title: "视觉布局", behaviorIds: ["B05"] },
    ], replacements: [] };

  afterEach(async () => {
    if (!targetVerified || !generation) return;
    const active = await admin.query(`SELECT id FROM nano.runs WHERE owner_id=$1
      AND state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')`, [ownerA]);
    for (const run of active.rows) await generation.finishFailed(ownerA, run.id, {
      code: "FIXTURE_TEST_ENDED", message: "Planning fixture ended before terminal settlement", retryable: false,
      cleanupState: "confirmed",
    });
  });

  afterAll(async () => {
    if (admin && targetVerified) {
      const found = await admin.query("SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3", [projectIds, ownerA, prefix]);
      if (found.rowCount !== projectIds.length) throw Error("Refusing cleanup outside the planning manifest");
      const recorded = await admin.query("SELECT id,credential_lease_id FROM nano.runs WHERE owner_id=$1 AND project_id=ANY($2::uuid[])", [ownerA, projectIds]);
      runIds.push(...recorded.rows.map((run) => run.id));
      leaseIds.push(...recorded.rows.map((run) => run.credential_lease_id));
      await save();
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_id=NULL,operation_kind=NULL WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.run_events WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.messages WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.sandboxes WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.role_runs WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.revisions WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.runs WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.model_credential_leases WHERE owner_id=$1 AND id=ANY($2::uuid[])", [ownerA, leaseIds]);
        await admin.query("DELETE FROM nano.projects WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.model_credentials WHERE owner_id=$1 AND profile_id=$2", [ownerA, fixtureProfileId]);
        await admin.query("DELETE FROM nano.model_profile_versions WHERE owner_id=$1 AND profile_id=$2", [ownerA, fixtureProfileId]);
        await admin.query("DELETE FROM nano.model_profiles WHERE owner_id=$1 AND id=$2", [ownerA, fixtureProfileId]);
        await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[ownerA, ownerB]]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      const remaining = await admin.query(`SELECT
        (SELECT count(*)::int FROM nano.projects WHERE id=ANY($1::uuid[])) AS projects,
        (SELECT count(*)::int FROM nano.runs WHERE id=ANY($2::uuid[])) AS runs,
        (SELECT count(*)::int FROM nano.model_credential_leases WHERE id=ANY($3::uuid[])) AS leases,
        (SELECT count(*)::int FROM nano.model_profiles WHERE id=$4) AS profiles,
        (SELECT count(*)::int FROM auth.users WHERE id=ANY($5::uuid[])) AS users`, [projectIds, runIds, leaseIds, fixtureProfileId, [ownerA, ownerB]]);
      expect(remaining.rows[0]).toEqual({ projects: 0, runs: 0, leases: 0, profiles: 0, users: 0 });
      cleanupVerifiedAt = new Date().toISOString();
      await save();
    }
    await database?.close();
    await admin?.end();
  }, 30_000);

  test("a new request queues only the coordinator, preserves its normalized text and cannot start a builder without a plan", async () => {
    const projectId = await project();
    const input = request("  请生成活动报名页\n保留我的原文。  ");
    const accepted = await generation.accept(ownerA, projectId, input);
    // Admission persists the request as a queued task; only a claim turns it into
    // a dispatchable run whose coordinator may start.
    expect(accepted.run).toMatchObject({ state: "queued", phase: "plan", requestText: input.text.trim(), builderRoleRunId: null });
    const claimed = await claimForTest(generation, ownerA, accepted.run.id);
    expect(claimed).toMatchObject({ id: accepted.run.id, state: "accepted", phase: "plan" });
    const snapshot = await generation.readRunSnapshot(ownerA, accepted.run.id);
    expect(snapshot.roles).toHaveLength(1);
    expect(snapshot.roles[0]).toMatchObject({ role: "coordinator", state: "queued", predecessorId: null });
    expect((await generation.listProjectMessages(ownerA, projectId))[0].content).toBe(input.text.trim());
    expect((await generation.accept(ownerA, projectId, input)).run.id).toBe(accepted.run.id);
    expect((await generation.accept(ownerA, projectId, { ...input, text: input.text.trim() })).run.id).toBe(accepted.run.id);
    await expect(generation.startBuilder(ownerA, accepted.run.id)).rejects.toMatchObject({ code: "PLAN_REQUIRED" });
    await generation.finishFailed(ownerA, accepted.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
  }, 90_000);

  test("only the current coordinator can atomically save a bounded plan and one durable builder handoff", async () => {
    const projectId = await project();
    const accepted = await generation.accept(ownerA, projectId, request());
    const claimed = await claimForTest(generation, ownerA, accepted.run.id);
    expect(claimed).toMatchObject({ id: accepted.run.id, state: "accepted" });
    const coordinator = await generation.startCoordinator(ownerA, accepted.run.id);
    expect(coordinator).toMatchObject({ role: "coordinator", state: "running", attempt: 0 });
    const reference = { roleRunId: coordinator.id, attempt: coordinator.attempt };
    await generation.assertRoleActive(ownerA, accepted.run.id, { ...reference, role: "coordinator" });
    await expect(generation.getPlanningContext(ownerB, accepted.run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.submitPlan(ownerA, accepted.run.id, { ...reference, attempt: 1, plan })).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    await expect(generation.submitPlan(ownerA, accepted.run.id, { ...reference, roleRunId: randomUUID(), plan })).rejects.toMatchObject({ code: "STALE_ROLE" });
    for (const invalid of [
      { ...plan, behaviors: [] }, { ...plan, behaviors: Array.from({ length: 6 }, (_value, index) => ({ ...plan.behaviors[0], id: `B0${index + 1}` })) },
      { ...plan, behaviors: [plan.behaviors[0], plan.behaviors[0]] }, { ...plan, goal: "x".repeat(1001) }, { ...plan, unauthorizedTool: "bash" },
      { ...plan, behaviors: [{ ...plan.behaviors[0], precondition: "字".repeat(501) }, ...plan.behaviors.slice(1)] },
    ]) await expect(generation.submitPlan(ownerA, accepted.run.id, { ...reference, plan: invalid })).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
    const published: RunEvent[] = [];
    const failedCommit = createGenerationRepository({
      owned: <T>(ownerId: string, operation: (client: PoolClient) => Promise<T>) => database.owned(ownerId, async (client) => {
        await operation(client);
        throw Error("injected planning database commit failure");
      }),
    }, models, { executorBootId: randomUUID(), onCommittedEvent: (_owner, event) => { published.push(event); } });
    await expect(failedCommit.submitPlan(ownerA, accepted.run.id, { ...reference, plan })).rejects.toThrow("injected planning database commit failure");
    expect(published).toEqual([]);
    const rolledBack = await generation.readRunSnapshot(ownerA, accepted.run.id);
    expect(rolledBack.run.plan).toBeNull();
    expect(rolledBack.roles).toHaveLength(1);
    const saved = await generation.submitPlan(ownerA, accepted.run.id, { ...reference, plan, usage: {
      modelCalls: 1, toolCalls: 1, inputTokens: 50, outputTokens: 100, cachedTokens: null, totalTokens: 150, elapsedMs: 20, source: "partial",
    } });
    expect(saved.run.plan).toEqual(plan);
    expect(saved.coordinator.state).toBe("succeeded");
    expect(saved.builder).toMatchObject({ role: "builder", state: "queued", predecessorId: coordinator.id, input: saved.handoff });
    expect(saved.builder.sessionId).not.toBe(coordinator.sessionId);
    expect(saved.handoff).toMatchObject({ runId: accepted.run.id, fromRoleRunId: coordinator.id, toRole: "builder", attempt: 0, baseRevisionId: null, plan });
    expect(saved.handoff.task).toContain(accepted.run.requestText);
    const durable = await generation.readRunSnapshot(ownerA, accepted.run.id);
    expect(durable.run.plan).toEqual(plan);
    expect(durable.roles).toMatchObject([{ id: saved.coordinator.id, role: "coordinator", state: "succeeded" }, { id: saved.builder.id, role: "builder", state: "queued", predecessorId: coordinator.id }]);
    expect(durable.roles.every((role) => !("input" in role))).toBe(true);
    expect(durable.events.slice(-2).map((event) => event.type)).toEqual(["role.completed", "run.phase"]);
    await expect(generation.submitPlan(ownerA, accepted.run.id, { ...reference, plan })).rejects.toMatchObject({ code: "ROLE_NOT_ACTIVE" });
    expect(await generation.startBuilder(ownerA, accepted.run.id)).toMatchObject({ id: saved.builder.id, input: saved.handoff });
    await generation.finishFailed(ownerA, accepted.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
  }, 180_000);

  test("clarification commits one question and releases resources, while the answer creates a new linked run with the full accepted context", async () => {
    const projectId = await project();
    const original = await generation.accept(ownerA, projectId, request("为线下读书会收集报名，需要确认谁可参加"));
    const originalClaim = await claimForTest(generation, ownerA, original.run.id);
    expect(originalClaim).toMatchObject({ id: original.run.id, state: "accepted" });
    const coordinator = await generation.startCoordinator(ownerA, original.run.id);
    const input = { roleRunId: coordinator.id, attempt: 0, question: "哪些人可以报名：所有访客，还是持邀请码的成员？" };
    const published: RunEvent[] = [];
    const failedCommit = createGenerationRepository({
      owned: <T>(ownerId: string, operation: (client: PoolClient) => Promise<T>) => database.owned(ownerId, async (client) => {
        await operation(client);
        throw Error("injected clarification database commit failure");
      }),
    }, models, { executorBootId: randomUUID(), onCommittedEvent: (_owner, event) => { published.push(event); } });
    await expect(failedCommit.requestClarification(ownerA, original.run.id, input)).rejects.toThrow("injected clarification database commit failure");
    expect(published).toEqual([]);
    expect((await generation.getRun(ownerA, original.run.id)).state).toBe("planning");
    expect((await generation.listProjectMessages(ownerA, projectId)).map((message) => message.kind)).toEqual(["user"]);
    expect((await models.freezeForRun(ownerA, model.id, model.configVersion, original.run.id)).id).toBe(original.run.credentialLeaseId);
    const asked = await generation.requestClarification(ownerA, original.run.id, input);
    expect(asked.run).toMatchObject({ state: "needs_input", cleanupState: "confirmed", clarification: { question: input.question }, builderRoleRunId: null });
    expect(asked.coordinator.state).toBe("succeeded");
    await expect(models.freezeForRun(ownerA, model.id, model.configVersion, original.run.id)).rejects.toMatchObject({ code: "MODEL_LEASE_RELEASED" });
    await expect(generation.requestClarification(ownerA, original.run.id, input)).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    expect((await generation.listProjectMessages(ownerA, projectId)).filter((message) => message.kind === "question")).toMatchObject([{ runId: original.run.id, content: input.question }]);
    const otherProject = await project();
    const independent = await generation.accept(ownerA, otherProject, request("资源释放后可接受独立任务"));
    const independentClaim = await claimForTest(generation, ownerA, independent.run.id);
    expect(independentClaim).toMatchObject({ id: independent.run.id, state: "accepted" });
    await generation.finishFailed(ownerA, independent.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
    const reply = { ...request(" 所有人均可参加，最多 20 人。 "), parentRunId: original.run.id };
    const child = await generation.accept(ownerA, projectId, reply);
    expect(child.run).toMatchObject({ parentRunId: original.run.id, requestText: reply.text.trim(), state: "queued" });
    expect(child.run.id).not.toBe(original.run.id);
    expect((await generation.accept(ownerA, projectId, reply)).run.id).toBe(child.run.id);
    const context = await generation.getPlanningContext(ownerA, child.run.id);
    expect(context).toMatchObject({ originalRequest: original.run.requestText, requestText: reply.text.trim(), clarificationTurns: [{ parentRunId: original.run.id, question: input.question, answer: reply.text.trim() }] });
    const childClaim = await claimForTest(generation, ownerA, child.run.id);
    expect(childClaim).toMatchObject({ id: child.run.id, state: "accepted", parentRunId: original.run.id });
    const childCoordinator = await generation.startCoordinator(ownerA, child.run.id);
    const handed = await generation.submitPlan(ownerA, child.run.id, { roleRunId: childCoordinator.id, attempt: 0, plan });
    for (const acceptedText of [original.run.requestText, input.question, reply.text.trim()]) expect(handed.handoff.task).toContain(acceptedText);
    expect((await generation.getRun(ownerA, original.run.id)).state).toBe("needs_input");
    await generation.finishFailed(ownerA, child.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
    await expect(generation.accept(ownerA, projectId, { ...request("错误父任务"), parentRunId: child.run.id })).rejects.toMatchObject({ code: "INVALID_CLARIFICATION_PARENT" });
    await expect(generation.accept(ownerA, otherProject, { ...request("其它项目的父任务"), parentRunId: original.run.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const retry = await generation.accept(ownerA, projectId, { ...request("以新任务重试"), retryOfRunId: child.run.id });
    try {
      expect(retry.run).toMatchObject({ projectId, state: "queued" });
      const retryClaim = await claimForTest(generation, ownerA, retry.run.id);
      expect(retryClaim).toMatchObject({ id: retry.run.id, state: "accepted" });
      expect((await admin.query("SELECT retry_of FROM nano.runs WHERE id=$1", [retry.run.id])).rows[0].retry_of).toBe(child.run.id);
    } finally {
      await generation.finishFailed(ownerA, retry.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
    }
    expect((await createProjectRepository(database).get(ownerA, projectId)).currentRevisionId).toBeNull();
  }, 240_000);

  test("a modification must preserve an existing observable behavior from its exact current revision", async () => {
    const projectId = await project();
    const prior = await generation.accept(ownerA, projectId, request());
    const priorClaim = await claimForTest(generation, ownerA, prior.run.id);
    expect(priorClaim).toMatchObject({ id: prior.run.id, state: "accepted" });
    const coordinator = await generation.startCoordinator(ownerA, prior.run.id);
    await generation.submitPlan(ownerA, prior.run.id, { roleRunId: coordinator.id, attempt: 0, plan });
    await generation.finishFailed(ownerA, prior.run.id, { code: "FIXTURE_COMPLETE", message: "Contract fixture; no model or source build", retryable: false, cleanupState: "confirmed" });
    // This one case deliberately represents a saved legacy v1 project after
    // the service has switched new submissions to grouped v2. It is read-only
    // history, not a fresh v1 submission.
    const legacyPlan: Plan = { schemaVersion: 1, goal: plan.goal, changeSummary: plan.changeSummary,
      assumptions: plan.assumptions, outOfScope: plan.outOfScope, behaviors: [plan.behaviors[0]] };
    await admin.query("UPDATE nano.runs SET plan_json=$3 WHERE owner_id=$1 AND id=$2", [ownerA, prior.run.id, legacyPlan]);
    const revisionId = randomUUID();
    // Explicit pre-existing current revision fixture. It has no Storage object;
    // this case tests plan preservation, not generation/build/source restoration.
    await admin.query("BEGIN");
    try {
      await admin.query(`INSERT INTO nano.revisions(id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,template_version,
        manifest_json,source_bytes,compressed_bytes,build_status,build_json,status)
        VALUES($1,$2,$3,$4,1,0,$5,$6,'planning-contract-fixture','[]',1,1,'passed','{"fixtureOnly":true}','accepted')`,
      [revisionId, ownerA, projectId, prior.run.id, `${ownerA}/${projectId}/${revisionId}/fixture-no-object.json.gz`, "1".repeat(64)]);
      await admin.query("UPDATE nano.projects SET current_revision_id=$3,next_revision_no=2 WHERE owner_id=$1 AND id=$2", [ownerA, projectId, revisionId]);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    const next = await generation.accept(ownerA, projectId, { ...request("增加姓名搜索，保留报名提交"), expectedCurrentRevisionId: revisionId });
    expect((await generation.getPlanningContext(ownerA, next.run.id)).previousPlan).toEqual(legacyPlan);
    const nextClaim = await claimForTest(generation, ownerA, next.run.id);
    expect(nextClaim).toMatchObject({ id: next.run.id, state: "accepted", baseRevisionId: revisionId });
    const nextCoordinator = await generation.startCoordinator(ownerA, next.run.id);
    const reference = { roleRunId: nextCoordinator.id, attempt: 0 };
    const search = { id: "B06", title: "搜索姓名", precondition: "已有报名记录", action: "输入一个姓名", expected: "仅显示匹配姓名的报名记录", required: true };
    const added: GroupedPlan = { ...plan, behaviors: [...plan.behaviors, search],
      groups: plan.groups.map((group) => group.id === "G1" ? { ...group, behaviorIds: [...group.behaviorIds, "B06"] } : group) };
    const omitted = { ...added, behaviors: added.behaviors.filter((behavior) => behavior.id !== "B01"),
      groups: added.groups.map((group) => group.id === "G1" ? { ...group, behaviorIds: group.behaviorIds.filter((id) => id !== "B01") } : group) };
    await expect(generation.submitPlan(ownerA, next.run.id, { ...reference, plan: omitted })).rejects.toMatchObject({ code: "PLAN_PREVIOUS_BEHAVIOR_REQUIRED" });
    await expect(generation.submitPlan(ownerA, next.run.id, { ...reference, plan: { ...added, behaviors: added.behaviors.map((behavior) => behavior.id === "B01" ? { ...behavior, expected: "显示完全不同的结果" } : behavior) } })).rejects.toMatchObject({ code: "PLAN_PREVIOUS_BEHAVIOR_REQUIRED" });
    const saved = await generation.submitPlan(ownerA, next.run.id, { ...reference, plan: { ...added, behaviors: added.behaviors.map((behavior) => behavior.id === "B01" ? { ...behavior, title: "保留原报名行为" } : behavior) } });
    expect(saved.handoff).toMatchObject({ baseRevisionId: revisionId, sourceHash: "1".repeat(64) });
    expect(saved.run.plan?.behaviors).toHaveLength(6);
    expect((await generation.startBuilder(ownerA, next.run.id)).input).toEqual(saved.handoff);
    await generation.finishFailed(ownerA, next.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
    expect((await createProjectRepository(database).get(ownerA, projectId)).currentRevisionId).toBe(revisionId);
  }, 180_000);

  test("failure preserves observed running-role usage without overwriting completed or foreign roles", async () => {
    const previous = await generation.accept(ownerA, await project(), request("已完成协调者用量"));
    const previousClaim = await claimForTest(generation, ownerA, previous.run.id);
    expect(previousClaim).toMatchObject({ id: previous.run.id, state: "accepted" });
    const completed = await generation.startCoordinator(ownerA, previous.run.id);
    const completedUsage: RoleUsage = { modelCalls: 1, toolCalls: 1, inputTokens: 5, outputTokens: 2, cachedTokens: null, totalTokens: 7, elapsedMs: 23, source: "partial" };
    const invalidUsage = { ...completedUsage, rawProviderResponse: { unchecked: true } };
    await expect(generation.submitPlan(ownerA, previous.run.id, { roleRunId: completed.id, attempt: 0, plan, usage: invalidUsage })).rejects.toMatchObject({ code: "INVALID_ROLE_USAGE" });
    await expect(generation.requestClarification(ownerA, previous.run.id, { roleRunId: completed.id, attempt: 0, question: "公式是什么？输入范围是什么？", usage: completedUsage })).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
    await expect(generation.requestClarification(ownerA, previous.run.id, { roleRunId: completed.id, attempt: 0, question: "必须使用哪个公式？", usage: invalidUsage })).rejects.toMatchObject({ code: "INVALID_ROLE_USAGE" });
    await generation.submitPlan(ownerA, previous.run.id, { roleRunId: completed.id, attempt: 0, plan, usage: completedUsage });
    const builder = await generation.startBuilder(ownerA, previous.run.id);
    await expect(generation.completeBuilder(ownerA, previous.run.id, { usage: invalidUsage })).rejects.toMatchObject({ code: "INVALID_ROLE_USAGE" });
    const builderUsage: RoleUsage = { modelCalls: 1, toolCalls: 2, inputTokens: 10, outputTokens: 3, cachedTokens: null, totalTokens: 13, elapsedMs: 40, source: "partial" };
    await generation.completeBuilder(ownerA, previous.run.id, { usage: builderUsage });
    await generation.finishFailed(ownerA, previous.run.id, { code: "FIXTURE_COMPLETE", message: "Preserve completed usage", retryable: false, cleanupState: "confirmed",
      roleUsage: { roleRunId: completed.id, usage: { ...completedUsage, inputTokens: 999, outputTokens: 999, totalTokens: 1998 } } });
    const accepted = await generation.accept(ownerA, await project(), request("模型失败时保留已消耗用量"));
    const acceptedClaim = await claimForTest(generation, ownerA, accepted.run.id);
    expect(acceptedClaim).toMatchObject({ id: accepted.run.id, state: "accepted" });
    const coordinator = await generation.startCoordinator(ownerA, accepted.run.id);
    const usage: RoleUsage = { modelCalls: 1, toolCalls: 0, inputTokens: 37, outputTokens: null, cachedTokens: null, totalTokens: null, elapsedMs: 125, source: "partial" };
    const failure = { code: "TOKEN_BUDGET_EXCEEDED", message: "Fixture budget stop after observed usage", retryable: false, cleanupState: "confirmed" as const,
      roleUsage: { roleRunId: coordinator.id, usage } };
    await expect(generation.finishFailed(ownerB, accepted.run.id, failure)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.finishFailed(ownerA, accepted.run.id, { ...failure, roleUsage: { roleRunId: completed.id, usage } })).rejects.toMatchObject({ code: "STALE_ROLE" });
    await expect(generation.finishFailed(ownerA, accepted.run.id, { ...failure, roleUsage: { roleRunId: coordinator.id, usage: invalidUsage } })).rejects.toMatchObject({ code: "INVALID_ROLE_USAGE" });
    const failedCommit = createGenerationRepository({
      owned: <T>(ownerId: string, operation: (client: PoolClient) => Promise<T>) => database.owned(ownerId, async (client) => {
        await operation(client);
        throw Error("injected failure usage commit rollback");
      }),
    }, models, { executorBootId: randomUUID() });
    await expect(failedCommit.finishFailed(ownerA, accepted.run.id, failure)).rejects.toThrow("injected failure usage commit rollback");
    // Role usage is an internal persisted fact; this explicitly approved real
    // database seam checks the transaction outcome without exposing it in HTTP.
    const rolledBack = await database.owned(ownerA, (client) => client.query("SELECT state,usage_json FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND id=$3", [ownerA, accepted.run.id, coordinator.id]));
    expect(rolledBack.rows).toEqual([{ state: "running", usage_json: {} }]);
    expect((await generation.finishFailed(ownerA, accepted.run.id, failure)).state).toBe("failed");
    const observed = await database.owned(ownerA, (client) => client.query("SELECT id,state,usage_json FROM nano.role_runs WHERE owner_id=$1 AND id=ANY($2::uuid[])", [ownerA, [coordinator.id, completed.id, builder.id]]));
    expect(observed.rows.find((role) => role.id === coordinator.id)).toEqual({ id: coordinator.id, state: "failed", usage_json: usage });
    expect(observed.rows.find((role) => role.id === completed.id)).toEqual({ id: completed.id, state: "succeeded", usage_json: completedUsage });
    expect(observed.rows.find((role) => role.id === builder.id)).toEqual({ id: builder.id, state: "succeeded", usage_json: builderUsage });
  }, 180_000);
});
