import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import { createSourceStore, prepareSourceSnapshot } from "../../src/storage/source.js";

describe.skipIf(process.env.PIVLOOM_GENERATION_INTEGRATION !== "1")("real generation persistence boundaries", () => {
  let database: PivloomDatabase;
  let admin: Pool;
  let generation: ReturnType<typeof createGenerationRepository>;
  let ownerA: string;
  let ownerB: string;
  let model: { id: string; configVersion: number };
  let models: ReturnType<typeof createModelProfileService>;
  const projectIds: string[] = [];
  const prefix = `generation-fixture-${randomUUID()}`;
  let manifestPath: string;
  const sourceKeys: string[] = [];
  const runIds: string[] = [];
  const leaseIds: string[] = [];
  let cleanupVerifiedAt: string | null = null;
  let sources: ReturnType<typeof createSourceStore>;

  beforeAll(async () => {
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environmentId || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY) throw Error("Explicit integration target required");
    const identity = JSON.parse(await readFile(resolve("../../.cache/identity", environmentId, "manifest.json"), "utf8"));
    if (identity.environmentId !== environmentId) throw Error("Identity manifest mismatch");
    const userA = identity.users.find((user: { label: string }) => user.label === "A").id;
    const userB = identity.users.find((user: { label: string }) => user.label === "B").id;
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
    const target = await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true");
    if (target.rows[0]?.environment_id !== environmentId) throw Error("Database target mismatch");
    database = new PivloomDatabase(process.env.DATABASE_URL);
    models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY));
    // This suite accepts real runs, so it must act as an account that still has
    // daily quota. Which account that is changes as the day is consumed, so the
    // A/B roles are assigned from the live counter instead of being assumed.
    const verifiedFor = async (owner: string) => (await models.list(owner))
      .find((profile) => profile.isDefault && profile.capabilities.streaming === "verified" && profile.capabilities.tools === "verified" && profile.capabilities.vision === "verified");
    const [aProfile, aQuota, bProfile, bQuota] = await Promise.all([
      verifiedFor(userA),
      createGenerationRepository(database, models, { executorBootId: randomUUID() }).quota(userA),
      verifiedFor(userB),
      createGenerationRepository(database, models, { executorBootId: randomUUID() }).quota(userB),
    ]);
    const useB = !!bProfile && bQuota.dailyAccepted < bQuota.dailyLimit && (!aProfile || aQuota.dailyAccepted >= aQuota.dailyLimit);
    const verified = useB ? bProfile : aProfile;
    if (!verified) throw Error("A genuinely verified default profile with remaining quota is required; no capability fixture is substituted");
    ownerA = useB ? userB : userA;
    ownerB = useB ? userA : userB;
    model = verified;
    generation = createGenerationRepository(database, models, { executorBootId: randomUUID() });
    sources = createSourceStore({ url: process.env.SUPABASE_URL!, secret: process.env.SUPABASE_SECRET_KEY! });
    const directory = resolve("../../.cache/generation", environmentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    manifestPath = resolve(directory, `${prefix}.json`);
    await saveManifest();
  }, 30_000);

  async function saveManifest() {
    await writeFile(manifestPath, JSON.stringify({ prefix, ownerA, ownerB, projectIds, runIds, leaseIds, sourceKeys, cleanupVerifiedAt }, null, 2), { mode: 0o600 });
  }
  async function project() {
    const created = await createProjectRepository(database).create(ownerA, prefix);
    projectIds.push(created.id);
    await saveManifest();
    return created.id;
  }
  const request = (text = "生成活动报名页面") => ({
    idempotencyKey: randomUUID(), text, expectedCurrentRevisionId: null,
    modelProfileId: model.id, modelConfigVersion: model.configVersion,
  });

  afterAll(async () => {
    if (admin && projectIds.length) {
      // Only exact IDs created by this suite; never reset or mutate the shared accounts/model.
      const found = await admin.query("SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3", [projectIds, ownerA, prefix]);
      if (found.rowCount !== projectIds.length) throw Error("Refusing cleanup: fixture ownership mismatch");
      const recorded = await admin.query("SELECT id,credential_lease_id FROM nano.runs WHERE owner_id=$1 AND project_id=ANY($2::uuid[])", [ownerA, projectIds]);
      runIds.push(...recorded.rows.map((run) => run.id));
      leaseIds.push(...recorded.rows.map((run) => run.credential_lease_id));
      await saveManifest();
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_id=NULL,operation_kind=NULL WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.run_events WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.messages WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.sandboxes WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.role_runs WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.revisions WHERE project_id=ANY($1::uuid[])", [projectIds]);
        const runs = await admin.query("DELETE FROM nano.runs WHERE project_id=ANY($1::uuid[]) RETURNING id", [projectIds]);
        await admin.query("DELETE FROM nano.model_credential_leases WHERE owner_id=$1 AND reference_id=ANY($2::uuid[])", [ownerA, runs.rows.map((run) => run.id)]);
        await admin.query("DELETE FROM nano.projects WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
    }
    if (database) await database.close();
    if (sourceKeys.length) {
      if (!sourceKeys.every((key) => projectIds.some((id) => key.startsWith(`${ownerA}/${id}/`)))) throw Error("Object cleanup out of fixture scope");
      const storage = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } }).storage;
      if ((await storage.from("pivloom-private").remove(sourceKeys)).error) throw Error("Exact object cleanup failed");
    }
    if (admin && projectIds.length) {
      const remaining = await admin.query(`SELECT
        (SELECT count(*)::int FROM nano.projects WHERE id=ANY($1::uuid[])) AS projects,
        (SELECT count(*)::int FROM nano.runs WHERE id=ANY($2::uuid[])) AS runs,
        (SELECT count(*)::int FROM nano.model_credential_leases WHERE id=ANY($3::uuid[])) AS leases`,
      [projectIds, runIds, leaseIds]);
      expect(remaining.rows[0]).toEqual({ projects: 0, runs: 0, leases: 0 });
      const objectLists = await Promise.all(projectIds.map((projectId) => sources.listObjects(ownerA, projectId)));
      expect(objectLists.flat().filter((object) => sourceKeys.includes(object.key))).toEqual([]);
      cleanupVerifiedAt = new Date().toISOString();
      await saveManifest();
    }
    if (admin) await admin.end();
  }, 30_000);

  test("acceptance atomically records one run, user message, coordinator and accepted event and safely replays its key", async () => {
    const id = await project();
    const input = request();
    const first = await generation.accept(ownerA, id, input);
    const replay = await generation.accept(ownerA, id, input);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
    expect(first.run.state).toBe("accepted");
    expect(first.run.coordinatorRoleRunId).toEqual(expect.any(String));
    expect(first.run.builderRoleRunId).toBeNull();
    expect(first.run.credentialLeaseId).toEqual(expect.any(String));
    const messages = await generation.listProjectMessages(ownerA, id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "user", runId: first.run.id, content: input.text });
    const events = await generation.listEvents(ownerA, first.run.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ schemaVersion: 1, type: "run.accepted", runId: first.run.id });
    await expect(generation.accept(ownerA, id, { ...input, text: "不同输入" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await generation.finishFailed(ownerA, first.run.id, { code: "CHECK_BLOCKED", message: "检查组件尚未接入", retryable: false, cleanupState: "confirmed" });
    expect((await createProjectRepository(database).get(ownerA, id)).currentRevisionId).toBeNull();
  }, 90_000);

  test("a verified private snapshot becomes an immutable candidate and CHECK_BLOCKED never promotes current", async () => {
    const id = await project();
    const accepted = await generation.accept(ownerA, id, request("保存候选快照"));
    await generation.setPhase(ownerA, accepted.run.id, { state: "building", phase: "snapshot" });
    const files = [{ path: "README.md", content: "hello" }, { path: "src/App.tsx", content: "export default function App(){return <main>fixture</main>}" }];
    const prepared = prepareSourceSnapshot("fixture-template-1", files);
    const revisionId = randomUUID();
    sourceKeys.push(`${ownerA}/${id}/${revisionId}/${prepared.sourceHash}.json.gz`);
    await saveManifest();
    const source = await sources.save({ ownerId: ownerA, projectId: id, revisionId }, "fixture-template-1", files);
    const candidate = await generation.saveCandidate(ownerA, accepted.run.id, { source, buildStatus: "passed", build: { fixture: true, exitCode: 0 } });
    expect(candidate.status).toBe("candidate");
    expect(candidate.manifest[0]).toEqual({ path: "README.md", bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
    const loaded = await sources.load((await generation.getRevision(ownerA, revisionId)).source);
    expect(loaded.files.map((file) => file.content)).toEqual(files.map((file) => file.content));
    const finished = await generation.finishFailed(ownerA, accepted.run.id, {
      code: "CHECK_BLOCKED", message: "检查组件尚未接入", retryable: false, resultRevisionId: revisionId, cleanupState: "confirmed",
    });
    expect(finished).toMatchObject({ state: "failed", resultRevisionId: revisionId, error: { code: "CHECK_BLOCKED" } });
    expect((await createProjectRepository(database).get(ownerA, id)).currentRevisionId).toBeNull();
    expect((await generation.listProjectRevisions(ownerA, id)).map((item) => item.id)).toEqual([revisionId]);
    const history = await generation.readProjectVersionHistory(ownerA, id);
    expect(history.currentRevisionId).toBeNull();
    expect(history.revisions.map((item) => [item.id, item.revisionNo, item.sourceHash, item.status])).toEqual([
      [revisionId, 1, prepared.sourceHash, "candidate"],
    ]);
    await expect(generation.readProjectVersionHistory(ownerB, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.getRevision(ownerB, revisionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.setPhase(ownerA, accepted.run.id, { phase: "implement" })).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
  }, 90_000);

  test("full sandbox capacity rejects new work without changing an accepted request replay", async () => {
    const id = await project();
    const input = request("容量测试");
    const accepted = await generation.accept(ownerA, id, input);
    // The global index allows one active run at a time, so this run must reach a
    // terminal state before the capacity assertion can be attributed correctly.
    await generation.finishFailed(ownerA, accepted.run.id, { code: "CHECK_BLOCKED", message: "fixture terminal", retryable: false, cleanupState: "confirmed" });
    // Capacity is counted from the durable registry, so the fixture is a real
    // live sandbox row (the external boundary) rather than an injected predicate.
    const fixtureSandbox = randomUUID();
    // The live count is measured, not assumed: this environment may already hold
    // a real preview sandbox, and the ceiling must be expressed relative to it.
    const liveBefore = (await admin.query("SELECT nano.live_sandbox_count() AS live")).rows[0].live as number;
    await admin.query(`INSERT INTO nano.sandboxes(owner_id,project_id,run_id,attempt,remote_id,purpose,state,expires_at)
      VALUES($1,$2,$3,0,$4,'preview','active',now()+interval '10 minutes')`, [ownerA, id, accepted.run.id, fixtureSandbox]);
    let releasedRunId: string | null = null;
    try {
      const full = createGenerationRepository(database, models, { executorBootId: randomUUID(), maxSandboxes: liveBefore + 1 });
      // An idempotent replay is still served: it never claimed a new sandbox.
      expect((await full.accept(ownerA, id, input)).run.id).toBe(accepted.run.id);
      const emptyProject = await project();
      await expect(full.accept(ownerA, emptyProject, request())).rejects.toMatchObject({ code: "SERVICE_BUSY" });
      expect(await generation.getLatestRun(ownerA, emptyProject)).toBeNull();
      expect(await generation.listProjectMessages(ownerA, emptyProject)).toEqual([]);
      // A reclaimed sandbox stops counting immediately, even before its expiry.
      await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE remote_id=$1", [fixtureSandbox]);
      const released = await full.accept(ownerA, emptyProject, request("容量释放后"));
      expect(released.run.state).toBe("accepted");
      releasedRunId = released.run.id;
    } finally {
      // An accepted run holds the single global generation slot until it reaches
      // a terminal state, so it must never outlive this case.
      if (releasedRunId) {
        await generation.cancel(ownerA, releasedRunId);
        await generation.finishCancelled(ownerA, releasedRunId, { cleanupState: "confirmed", summary: "fixture cleanup" });
      }
      await admin.query("DELETE FROM nano.sandboxes WHERE remote_id=$1", [fixtureSandbox]);
    }
  }, 90_000);

  test("a failed upload and a real database rollback never reference an unavailable snapshot and leave identifiable orphans", async () => {
    const id = await project();
    const accepted = await generation.accept(ownerA, id, request("保存边界故障验证"));
    const files = [{ path: "README.md", content: "snapshot boundary fixture" }];
    const failedUpload = createSourceStore({ url: process.env.SUPABASE_URL!, secret: process.env.SUPABASE_SECRET_KEY!, objects: {
      upload: async () => { throw Error("injected external Storage upload failure"); },
      download: async () => { throw Error("upload failed before download"); }, list: async () => [],
    } });
    await expect(failedUpload.save({ ownerId: ownerA, projectId: id, revisionId: randomUUID() }, "fixture-template", files)).rejects.toMatchObject({ code: "SNAPSHOT_SAVE_FAILED" });
    expect(await generation.listProjectRevisions(ownerA, id)).toEqual([]);
    expect((await createProjectRepository(database).get(ownerA, id)).currentRevisionId).toBeNull();

    const revisionId = randomUUID();
    const prepared = prepareSourceSnapshot("fixture-template", files);
    sourceKeys.push(`${ownerA}/${id}/${revisionId}/${prepared.sourceHash}.json.gz`);
    await saveManifest();
    const source = await sources.save({ ownerId: ownerA, projectId: id, revisionId }, "fixture-template", files);
    // External database-commit boundary injection: all SQL executes against real Postgres,
    // then a failure before COMMIT forces its actual transaction to roll back.
    const failingDatabase: Pick<PivloomDatabase, "owned"> = {
      owned: <T>(ownerId: string, operation: (client: PoolClient) => Promise<T>) => database.owned(ownerId, async (client) => {
        await operation(client);
        throw Error("injected database commit failure");
      }),
    };
    const failedCommit = createGenerationRepository(failingDatabase, models, { executorBootId: randomUUID() });
    await expect(failedCommit.saveCandidate(ownerA, accepted.run.id, { source, buildStatus: "passed", build: { fixture: true, exitCode: 0 } })).rejects.toThrow("injected database commit failure");
    expect(await generation.listProjectRevisions(ownerA, id)).toEqual([]);
    expect((await generation.getRun(ownerA, accepted.run.id)).resultRevisionId).toBeNull();
    expect((await createProjectRepository(database).get(ownerA, id)).currentRevisionId).toBeNull();
    const referenced = new Set(await generation.listReferencedSourceKeys(ownerA, id));
    const orphaned = (await sources.listObjects(ownerA, id)).filter((object) => !referenced.has(object.key));
    expect(orphaned.map((object) => object.key)).toContain(source.key);
    expect((await generation.listEvents(ownerA, accepted.run.id)).some((event) => event.type === "revision.saved")).toBe(false);
    await generation.finishFailed(ownerA, accepted.run.id, { code: "SNAPSHOT_SAVE_FAILED", message: "fixture boundary failure", retryable: true, cleanupState: "confirmed" });
  }, 120_000);

  test("owner isolation, global capacity and cleanup pending prevent duplicate or overlapping accepted work", async () => {
    const firstProject = await project();
    const secondProject = await project();
    const input = request("并发请求");
    const outcomes = await Promise.allSettled([
      generation.accept(ownerA, firstProject, input),
      generation.accept(ownerA, firstProject, { ...input, idempotencyKey: randomUUID() }),
    ]);
    const accepted = outcomes.find((result) => result.status === "fulfilled");
    if (!accepted || accepted.status !== "fulfilled") throw Error("No accepted concurrent request");
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("PROJECT_BUSY");
    const runId = accepted.value.run.id;
    expect((await generation.listProjectMessages(ownerA, firstProject)).filter((message) => message.kind === "user")).toHaveLength(1);
    await expect(generation.getRun(ownerB, runId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.accept(ownerB, firstProject, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.accept(ownerA, secondProject, request())).rejects.toMatchObject({ code: "SERVICE_BUSY" });
    await expect(generation.accept(ownerA, secondProject, { ...request(), expectedCurrentRevisionId: randomUUID() })).rejects.toMatchObject({ code: "STALE_BASE" });
    await expect(generation.appendEvent(ownerA, runId, { type: "tool.output", payload: { output: "a".repeat(16 * 1024) } })).rejects.toMatchObject({ code: "EVENT_TOO_LARGE" });
    await generation.finishFailed(ownerA, runId, { code: "REMOTE_CLEANUP_PENDING", message: "fixture remote cleanup pending", retryable: true, cleanupState: "pending" });
    await expect(generation.accept(ownerA, secondProject, request())).rejects.toMatchObject({ code: "SERVICE_BUSY" });
    await generation.confirmCleanup(ownerA, runId);
    const next = await generation.accept(ownerA, secondProject, request());
    await generation.finishFailed(ownerA, next.run.id, { code: "CHECK_BLOCKED", message: "fixture terminal", retryable: false, cleanupState: "confirmed" });
  }, 120_000);
});
