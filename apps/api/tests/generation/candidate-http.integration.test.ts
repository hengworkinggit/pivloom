import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { GroupedPlan } from "@pivloom/contracts";
import { createApp } from "../../src/app.js";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createSourceStore } from "../../src/storage/source.js";

const plan: GroupedPlan = { schemaVersion: 2, goal: "候选表单", changeSummary: "候选有搜索功能", assumptions: [], outOfScope: [], replacements: [],
  behaviors: Array.from({ length: 5 }, (_, i) => ({ id: `B0${i + 1}`, title: `行为${i + 1}`, precondition: "页面打开", action: "点击提交", expected: "显示结果", required: true })),
  groups: ["G1", "G2", "G3", "G4", "G5"].map((id, i) => ({ id: id as "G1" | "G2" | "G3" | "G4" | "G5", title: `分组${i + 1}`, behaviorIds: [`B0${i + 1}`] })) };

// HTTP routes, service, PostgreSQL owner rules, source snapshots and dispatch are
// real. Auth and object storage are explicit external fixtures; no model is run.
describe.skipIf(process.env.PIVLOOM_CANDIDATE_INTEGRATION !== "1")("candidate continuation HTTP", () => {
  const owner = randomUUID(), other = randomUUID(), profileId = randomUUID();
  const projects: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const sourceObjects = { upload: async (key: string, value: Uint8Array) => { objects.set(key, value); }, download: async (key: string) => objects.get(key)!, list: async () => [] };
  const sources = createSourceStore({ url: "https://fixture.invalid", secret: "fixture", objects: sourceObjects });
  let admin: Pool, database: PivloomDatabase, app: FastifyInstance;
  let appEnv: NodeJS.ProcessEnv;
  let repository: ReturnType<typeof createGenerationRepository>;
  let verified = false;
  const auth = createServer((request, response) => {
    const id = request.headers.authorization === "Bearer candidate-owner" ? owner : request.headers.authorization === "Bearer other-owner" ? other : null;
    response.writeHead(id ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(id ? { id, email: "fixture@example.test", user_metadata: {} } : { message: "unauthorized" }));
  });
  const headers = { authorization: "Bearer candidate-owner" };
  const request = (text = "在候选上增加筛选") => ({ text, expectedCurrentRevisionId: null as string | null, modelProfileId: profileId, modelConfigVersion: 1 });

  beforeAll(async () => {
    const url = process.env.PIVLOOM_EXECUTOR_DATABASE_URL;
    if (!url || !new URL(url).pathname.startsWith("/pivloom_executor_test_") || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY)
      throw Error("Explicit disposable candidate database required");
    admin = new Pool({ connectionString: url, max: 1 });
    const identity = (await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true")).rows[0];
    if (identity?.environment_id !== process.env.PIVLOOM_EXECUTOR_ENVIRONMENT_ID) throw Error("Candidate database identity mismatch");
    verified = true;
    const migration = await readFile(new URL("../../../../migrations/030_explicit_candidate_base.sql", import.meta.url), "utf8");
    if (!(await admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema='nano' AND table_name='runs' AND column_name='selected_base_revision_id'")).rowCount) await admin.query(migration);
    database = new PivloomDatabase(url);
    const vault = createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY);
    const sealed = vault.seal("unused-fixture-key", { ownerId: owner, profileId, version: 1 });
    await admin.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, other]);
    await admin.query("BEGIN");
    await admin.query("INSERT INTO nano.model_profiles(id,owner_id,current_version,is_default) VALUES($1,$2,1,false)", [profileId, owner]);
    await admin.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask,capabilities)
      VALUES($1,$2,1,'candidate fixture','openai-completions','https://fixture.invalid/v1','fixture','masked','{"streaming":"verified","tools":"verified","vision":"verified"}')`, [profileId, owner]);
    await admin.query("INSERT INTO nano.model_credentials(profile_id,owner_id,config_version,ciphertext,nonce,auth_tag) VALUES($1,$2,1,$3,$4,$5)", [profileId, owner, sealed.ciphertext, sealed.nonce, sealed.authTag]);
    await admin.query("COMMIT");
    repository = createGenerationRepository(database, createModelProfileService(database, vault), { executorBootId: randomUUID(), maxSandboxes: 2, dailyLimitByOwner: { [owner]: 1000 } });
    await new Promise<void>((resolve) => auth.listen(0, "127.0.0.1", resolve));
    const address = auth.address(); if (!address || typeof address === "string") throw Error("auth fixture missing");
    const origin = `http://127.0.0.1:${address.port}`;
    appEnv = { NODE_ENV: "test", APP_ORIGIN: "http://localhost:45231", SUPABASE_URL: origin, SUPABASE_SECRET_KEY: "fixture", DATABASE_URL: url,
      MODEL_CREDENTIALS_ENCRYPTION_KEY: process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY, DAILY_RUN_LIMIT_OVERRIDES: JSON.stringify({ [owner]: 1000 }), OPENSANDBOX_BASE_URL: origin, OPENSANDBOX_API_KEY: "fixture", OPENSANDBOX_IMAGE: "fixture", PREVIEW_BASE_URL: "http://localhost:45311", SANDBOX_MAX_ACTIVE: "2" };
    app = createApp({ logger: false, sourceObjects, env: appEnv });
    await app.ready();
  });

  async function fixture() {
    const project = await createProjectRepository(database).create(owner, "candidate HTTP fixture"); projects.push(project.id);
    const revisions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = (await repository.accept(owner, project.id, { ...request("fixture seed"), idempotencyKey: randomUUID() })).run;
      await repository.finishCancelled(owner, run.id, { cleanupState: "confirmed", summary: "fixture" });
      const id = randomUUID();
      const snapshot = await sources.save({ ownerId: owner, projectId: project.id, revisionId: id }, "fixture", [{ path: "src/App.tsx", content: `export const value = '${i === 1 ? "candidate-search" : "accepted"}';` }]);
      await admin.query(`INSERT INTO nano.revisions(id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,template_version,manifest_json,source_bytes,compressed_bytes,build_status,build_json,status)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,'fixture',$8,$9,$10,$11,'{}',$12)`, [id, owner, project.id, run.id, i + 1, snapshot.key, snapshot.sourceHash, JSON.stringify(snapshot.manifest), snapshot.sourceBytes, snapshot.compressedBytes, i === 2 ? "failed" : "passed", i === 0 ? "accepted" : "candidate"]);
      await admin.query("UPDATE nano.runs SET plan_json=$2,result_revision_id=$3 WHERE id=$1", [run.id, { ...plan, goal: i === 1 ? "候选表单" : "旧版表单" }, id]);
      revisions.push(id);
      if (i < 2) await admin.query(`INSERT INTO nano.sandboxes(owner_id,project_id,run_id,attempt,remote_id,purpose,state,expires_at)
        VALUES($1,$2,$3,0,$4,'candidate','active',now()+interval '5 minutes')`, [owner, project.id, run.id, randomUUID()]);
    }
    await admin.query("UPDATE nano.projects SET current_revision_id=$2,next_revision_no=4 WHERE id=$1", [project.id, revisions[0]]);
    return { projectId: project.id, acceptedId: revisions[0], candidateId: revisions[1], failedId: revisions[2] };
  }
  const submit = (projectId: string, payload: unknown, actor = headers, key = randomUUID()) => app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/runs`, headers: { ...actor, "idempotency-key": key, "content-type": "application/json" }, payload: JSON.stringify(payload) });
  async function reopenHttp() {
    // Finish the admission wake while capacity is occupied. A fresh service and
    // Auth verification then read the durable task; this test drives dispatch.
    await app.close();
    app = createApp({ logger: false, sourceObjects, env: appEnv });
    await app.ready();
  }
  afterEach(async () => {
    if (!verified || !projects.length) return;
    await reopenHttp();
    await admin.query("UPDATE nano.runs SET state='cancelled',phase='cleanup',cleanup_state='confirmed',finished_at=now() WHERE project_id=ANY($1::uuid[]) AND state NOT IN ('completed','failed','cancelled','needs_changes','needs_input','interrupted')", [projects]);
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE project_id=ANY($1::uuid[])", [projects]);
    await admin.query("UPDATE nano.preview_restores SET status='failed',finished_at=now() WHERE project_id=ANY($1::uuid[])", [projects]);
    await admin.query("UPDATE nano.projects SET operation_id=NULL,operation_kind=NULL WHERE id=ANY($1::uuid[])", [projects]);
  });
  afterAll(async () => {
    await app?.close();
    if (verified) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_id=NULL,operation_kind=NULL WHERE id=ANY($1::uuid[])", [projects]);
        for (const table of ["preview_restores", "checks", "run_events", "messages", "sandboxes", "role_runs", "revisions", "runs"])
          await admin.query(`DELETE FROM nano.${table} WHERE project_id=ANY($1::uuid[])`, [projects]);
        await admin.query("DELETE FROM nano.model_credential_leases WHERE owner_id=$1", [owner]);
        await admin.query("DELETE FROM nano.projects WHERE owner_id=$1", [owner]);
        for (const table of ["model_credentials", "model_profile_versions", "model_profiles"]) await admin.query(`DELETE FROM nano.${table} WHERE owner_id=$1`, [owner]);
        await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[owner, other]]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
    }
    await database?.close(); await admin?.end();
    auth.closeAllConnections(); await new Promise<void>((resolve) => auth.close(() => resolve()));
  });

  test("freezes candidate source and previous plan separately from accepted current through HTTP and dispatch", async () => {
    const f = await fixture();
    const body = { ...request(), expectedCurrentRevisionId: f.acceptedId, selectedBaseRevisionId: f.candidateId };
    const key = randomUUID();
    const response = await submit(f.projectId, body, headers, key);
    expect(response.statusCode, response.body).toBe(202);
    const runId = response.json().runId;
    expect((await submit(f.projectId, body, headers, key)).json()).toMatchObject({ runId, replayed: true });
    expect((await submit(f.projectId, { ...body, selectedBaseRevisionId: f.failedId }, headers, key)).json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    await reopenHttp();
    const detail = await app.inject({ url: `/api/v1/runs/${runId}`, headers });
    expect(detail.json().run).toMatchObject({ baseRevisionId: f.candidateId, selectedBaseRevisionId: f.candidateId });
    expect(await repository.getPlanningContext(owner, runId)).toMatchObject({ baseRevisionId: f.candidateId, previousPlan: { goal: "候选表单" } });
    const source = await app.inject({ url: `/api/v1/revisions/${f.candidateId}/file?path=src%2FApp.tsx`, headers });
    expect(source.json().content).toContain("candidate-search");
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE project_id=$1", [f.projectId]);
    expect(await repository.claimNextQueuedRun(runId)).not.toBeNull();
    const prepared = await repository.prepareDispatch(owner, runId);
    expect(prepared.outcome).toBe("ready");
    expect(prepared.run).toMatchObject({ baseRevisionId: f.candidateId, expectedCurrentRevisionId: f.acceptedId });
    const coordinator = await repository.startCoordinator(owner, runId);
    await repository.submitPlan(owner, runId, { roleRunId: coordinator.id, attempt: 0, plan });
    const builder = await repository.startBuilder(owner, runId);
    expect(builder.input?.baseRevisionId).toBe(f.candidateId);
    const next = await sources.save({ ownerId: owner, projectId: f.projectId, revisionId: randomUUID() }, "fixture", [{ path: "src/App.tsx", content: "export const value = 'candidate-search-and-filter';" }]);
    const saved = await repository.saveCandidate(owner, runId, { source: next, buildStatus: "passed", build: {} });
    expect(saved.revisionNo).toBe(4);
    const project = await app.inject({ url: `/api/v1/projects/${f.projectId}`, headers });
    expect(project.json().project.currentRevisionId).toBe(f.acceptedId);
    const check = await app.inject({ url: `/api/v1/revisions/${f.candidateId}/check`, headers });
    expect(check.json().check).toBeNull();
  });

  test("rejects foreign, cross-project and failed-build selected bases without admitting a run", async () => {
    const f = await fixture();
    const payload = { ...request(), expectedCurrentRevisionId: f.acceptedId, selectedBaseRevisionId: f.candidateId };
    expect((await submit(f.projectId, payload, { authorization: "Bearer other-owner" })).statusCode).toBe(404);
    expect((await submit(f.projectId, { ...payload, selectedBaseRevisionId: f.failedId })).json().error.code).toBe("INVALID_CANDIDATE_BASE");
    const another = await createProjectRepository(database).create(owner, "another fixture"); projects.push(another.id);
    expect((await submit(another.id, { ...payload, expectedCurrentRevisionId: null })).statusCode).toBe(404);
    expect((await submit(f.projectId, { ...payload, expectedCurrentRevisionId: null })).json().error.code).toBe("STALE_BASE");
  });

  test("continues a runnable candidate when the project has no accepted version", async () => {
    const f = await fixture();
    await admin.query("UPDATE nano.projects SET current_revision_id=NULL WHERE id=$1", [f.projectId]);
    const response = await submit(f.projectId, { ...request(), selectedBaseRevisionId: f.candidateId });
    expect(response.statusCode, response.body).toBe(202);
    expect(await repository.getRun(owner, response.json().runId)).toMatchObject({ baseRevisionId: f.candidateId, expectedCurrentRevisionId: null });
    const project = await app.inject({ url: `/api/v1/projects/${f.projectId}`, headers });
    expect(project.json().project.currentRevisionId).toBeNull();
  });

  test("restores an unavailable candidate through the same quota queue without promotion or fake checks", async () => {
    const f = await fixture();
    const failed = await app.inject({ method: "POST", url: `/api/v1/projects/${f.projectId}/preview/restore`, headers: { ...headers, "idempotency-key": randomUUID() }, payload: { revisionId: f.failedId } });
    expect(failed.json().error.code).toBe("PREVIEW_NOT_RESTORABLE");
    const foreign = await app.inject({ method: "POST", url: `/api/v1/projects/${f.projectId}/preview/restore`, headers: { authorization: "Bearer other-owner", "idempotency-key": randomUUID() }, payload: { revisionId: f.candidateId } });
    expect(foreign.statusCode).toBe(404);
    const response = await app.inject({ method: "POST", url: `/api/v1/projects/${f.projectId}/preview/restore`, headers: { ...headers, "idempotency-key": randomUUID() }, payload: { revisionId: f.candidateId } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().preview).toMatchObject({ state: "queued", revisionId: f.candidateId });
    const project = await app.inject({ url: `/api/v1/projects/${f.projectId}`, headers });
    expect(project.json().project.currentRevisionId).toBe(f.acceptedId);
    const check = await app.inject({ url: `/api/v1/revisions/${f.candidateId}/check`, headers });
    expect(check.json().check).toBeNull();
  });

  test("parks an explicit candidate if accepted current changes while queued instead of silently rebasing", async () => {
    const f = await fixture();
    const response = await submit(f.projectId, { ...request(), expectedCurrentRevisionId: f.acceptedId, selectedBaseRevisionId: f.candidateId });
    expect(response.statusCode, response.body).toBe(202);
    const runId = response.json().runId;
    await reopenHttp();
    await admin.query("UPDATE nano.projects SET current_revision_id=NULL WHERE id=$1", [f.projectId]);
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE project_id=$1", [f.projectId]);
    expect(await repository.claimNextQueuedRun(runId)).not.toBeNull();
    const prepared = await repository.prepareDispatch(owner, runId);
    expect(prepared.outcome).toBe("parked");
    expect(prepared.run).toMatchObject({ baseRevisionId: f.candidateId, selectedBaseRevisionId: f.candidateId, error: { code: "QUEUE_BASELINE_CHANGED" } });
  });

  test("unselected queued requests still chain to an accepted predecessor", async () => {
    const f = await fixture();
    const response = await submit(f.projectId, { ...request(), expectedCurrentRevisionId: f.acceptedId });
    expect(response.statusCode, response.body).toBe(202);
    const runId = response.json().runId;
    await reopenHttp();
    await admin.query("UPDATE nano.runs SET state='completed',finished_at=now() WHERE result_revision_id=$1", [f.candidateId]);
    await admin.query("UPDATE nano.revisions SET status='accepted' WHERE id=$1", [f.candidateId]);
    await admin.query("UPDATE nano.projects SET current_revision_id=$2 WHERE id=$1", [f.projectId, f.candidateId]);
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE project_id=$1", [f.projectId]);
    expect(await repository.claimNextQueuedRun(runId)).not.toBeNull();
    const prepared = await repository.prepareDispatch(owner, runId);
    expect(prepared.outcome).toBe("ready");
    expect(prepared.run).toMatchObject({ baseRevisionId: f.candidateId, expectedCurrentRevisionId: f.candidateId, selectedBaseRevisionId: null });
    expect(await repository.getPlanningContext(owner, runId)).toMatchObject({ baseRevisionId: f.candidateId, previousPlan: { goal: "候选表单" } });
  });

  test("a clarification after reopening keeps the explicitly selected candidate even without a browser selection", async () => {
    const f = await fixture();
    const response = await submit(f.projectId, { ...request(), expectedCurrentRevisionId: f.acceptedId, selectedBaseRevisionId: f.candidateId });
    const runId = response.json().runId;
    await reopenHttp();
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE project_id=$1", [f.projectId]);
    await repository.claimNextQueuedRun(runId); await repository.prepareDispatch(owner, runId);
    const coordinator = await repository.startCoordinator(owner, runId);
    await repository.requestClarification(owner, runId, { roleRunId: coordinator.id, attempt: 0, question: "筛选哪些字段？" });
    // Occupy capacity again to leave the real HTTP submission in its queue.
    await admin.query("UPDATE nano.sandboxes SET state='active' WHERE project_id=$1", [f.projectId]);
    const answer = await submit(f.projectId, { ...request("按姓名筛选"), expectedCurrentRevisionId: f.acceptedId, parentRunId: runId });
    expect(answer.statusCode, answer.body).toBe(202);
    expect(await repository.getPlanningContext(owner, answer.json().runId)).toMatchObject({ baseRevisionId: f.candidateId, previousPlan: { goal: "候选表单" }, clarificationTurns: [expect.objectContaining({ answer: "按姓名筛选" })] });
  });
});
