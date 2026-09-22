import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Plan, RoleUsage, RunEvent } from "@pivloom/contracts";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationRepository } from "../../src/data/generation.js";
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
  let manifestPath: string;
  const prefix = `planning-fixture-${randomUUID()}`;
  const projectIds: string[] = [];
  const runIds: string[] = [];
  const leaseIds: string[] = [];
  let cleanupVerifiedAt: string | null = null;
  const save = () => writeFile(manifestPath, JSON.stringify({ prefix, ownerA, ownerB, projectIds, runIds, leaseIds, cleanupVerifiedAt }, null, 2), { mode: 0o600 });

  beforeAll(async () => {
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environmentId || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY) throw Error("Explicit integration target required");
    const identity = JSON.parse(await readFile(resolve("../../.cache/identity", environmentId, "manifest.json"), "utf8"));
    if (identity.environmentId !== environmentId) throw Error("Identity manifest mismatch");
    ownerA = identity.users.find((user: { label: string }) => user.label === "A").id;
    ownerB = identity.users.find((user: { label: string }) => user.label === "B").id;
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
    if ((await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true")).rows[0]?.environment_id !== environmentId) throw Error("Database target mismatch");
    database = new PivloomDatabase(process.env.DATABASE_URL);
    models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY));
    const verified = (await models.list(ownerA)).find((profile) => profile.isDefault && profile.capabilities.streaming === "verified" && profile.capabilities.tools === "verified");
    if (!verified) throw Error("A verified existing model is required; this fixture never changes a profile or calls a model");
    model = verified;
    generation = createGenerationRepository(database, models, { executorBootId: randomUUID() });
    const directory = resolve("../../.cache/planning", environmentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    manifestPath = resolve(directory, `${prefix}.json`);
    await save();
  }, 30_000);

  async function project() {
    const created = await createProjectRepository(database).create(ownerA, prefix);
    projectIds.push(created.id);
    await save();
    return created.id;
  }
  const request = (text = "生成活动报名页") => ({ text, idempotencyKey: randomUUID(), expectedCurrentRevisionId: null, modelProfileId: model.id, modelConfigVersion: model.configVersion });
  const plan: Plan = { schemaVersion: 1, goal: "收集活动报名", changeSummary: "增加报名表与明确提交反馈", assumptions: ["演示数据仅保存在当前浏览器"],
    outOfScope: ["真实支付与跨用户数据库"], behaviors: [{ id: "B01", title: "提交报名", precondition: "报名表已打开", action: "填写姓名后点击报名", expected: "显示报名成功和填写的姓名", required: true }] };

  afterAll(async () => {
    if (admin && projectIds.length) {
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
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      const remaining = await admin.query(`SELECT
        (SELECT count(*)::int FROM nano.projects WHERE id=ANY($1::uuid[])) AS projects,
        (SELECT count(*)::int FROM nano.runs WHERE id=ANY($2::uuid[])) AS runs,
        (SELECT count(*)::int FROM nano.model_credential_leases WHERE id=ANY($3::uuid[])) AS leases`, [projectIds, runIds, leaseIds]);
      expect(remaining.rows[0]).toEqual({ projects: 0, runs: 0, leases: 0 });
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
    expect(accepted.run).toMatchObject({ state: "accepted", phase: "plan", requestText: input.text.trim(), builderRoleRunId: null });
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
      { ...plan, behaviors: Array.from({ length: 5 }, (_value, index) => ({ ...plan.behaviors[0], id: `B0${index + 1}`, precondition: "字".repeat(500), action: "字".repeat(500), expected: "字".repeat(500) })) },
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
    await generation.finishFailed(ownerA, independent.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
    const reply = { ...request(" 所有人均可参加，最多 20 人。 "), parentRunId: original.run.id };
    const child = await generation.accept(ownerA, projectId, reply);
    expect(child.run).toMatchObject({ parentRunId: original.run.id, requestText: reply.text.trim(), state: "accepted" });
    expect(child.run.id).not.toBe(original.run.id);
    expect((await generation.accept(ownerA, projectId, reply)).run.id).toBe(child.run.id);
    const context = await generation.getPlanningContext(ownerA, child.run.id);
    expect(context).toMatchObject({ originalRequest: original.run.requestText, requestText: reply.text.trim(), clarificationTurns: [{ parentRunId: original.run.id, question: input.question, answer: reply.text.trim() }] });
    const childCoordinator = await generation.startCoordinator(ownerA, child.run.id);
    const handed = await generation.submitPlan(ownerA, child.run.id, { roleRunId: childCoordinator.id, attempt: 0, plan });
    for (const acceptedText of [original.run.requestText, input.question, reply.text.trim()]) expect(handed.handoff.task).toContain(acceptedText);
    expect((await generation.getRun(ownerA, original.run.id)).state).toBe("needs_input");
    await generation.finishFailed(ownerA, child.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
    await expect(generation.accept(ownerA, projectId, { ...request("错误父任务"), parentRunId: child.run.id })).rejects.toMatchObject({ code: "INVALID_CLARIFICATION_PARENT" });
    await expect(generation.accept(ownerA, otherProject, { ...request("其它项目的父任务"), parentRunId: original.run.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.accept(ownerA, projectId, { ...request("暂不开放retry"), retryOfRunId: child.run.id })).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect((await createProjectRepository(database).get(ownerA, projectId)).currentRevisionId).toBeNull();
  }, 240_000);

  test("a modification must preserve an existing observable behavior from its exact current revision", async () => {
    const projectId = await project();
    const prior = await generation.accept(ownerA, projectId, request());
    const coordinator = await generation.startCoordinator(ownerA, prior.run.id);
    await generation.submitPlan(ownerA, prior.run.id, { roleRunId: coordinator.id, attempt: 0, plan });
    await generation.finishFailed(ownerA, prior.run.id, { code: "FIXTURE_COMPLETE", message: "Contract fixture; no model or source build", retryable: false, cleanupState: "confirmed" });
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
    expect((await generation.getPlanningContext(ownerA, next.run.id)).previousPlan).toEqual(plan);
    const nextCoordinator = await generation.startCoordinator(ownerA, next.run.id);
    const reference = { roleRunId: nextCoordinator.id, attempt: 0 };
    const search = { id: "B02", title: "搜索姓名", precondition: "已有报名记录", action: "输入一个姓名", expected: "仅显示匹配姓名的报名记录", required: true };
    await expect(generation.submitPlan(ownerA, next.run.id, { ...reference, plan: { ...plan, behaviors: [search] } })).rejects.toMatchObject({ code: "PLAN_PREVIOUS_BEHAVIOR_REQUIRED" });
    await expect(generation.submitPlan(ownerA, next.run.id, { ...reference, plan: { ...plan, behaviors: [{ ...plan.behaviors[0], expected: "显示完全不同的结果" }, search] } })).rejects.toMatchObject({ code: "PLAN_PREVIOUS_BEHAVIOR_REQUIRED" });
    const saved = await generation.submitPlan(ownerA, next.run.id, { ...reference, plan: { ...plan, behaviors: [{ ...plan.behaviors[0], title: "保留原报名行为" }, search] } });
    expect(saved.handoff).toMatchObject({ baseRevisionId: revisionId, sourceHash: "1".repeat(64) });
    expect(saved.run.plan?.behaviors).toHaveLength(2);
    expect((await generation.startBuilder(ownerA, next.run.id)).input).toEqual(saved.handoff);
    await generation.finishFailed(ownerA, next.run.id, { code: "FIXTURE_COMPLETE", message: "No model invoked", retryable: false, cleanupState: "confirmed" });
    expect((await createProjectRepository(database).get(ownerA, projectId)).currentRevisionId).toBe(revisionId);
  }, 180_000);

  test("failure preserves observed running-role usage without overwriting completed or foreign roles", async () => {
    const previous = await generation.accept(ownerA, await project(), request("已完成协调者用量"));
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
