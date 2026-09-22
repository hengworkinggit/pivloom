import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Plan } from "@pivloom/contracts";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createSourceStore } from "../../src/storage/source.js";
import { createArtifactStore } from "../../src/storage/artifacts.js";
import { runReview } from "../../src/generation/review.js";
import type { SandboxConnection } from "../../src/runtime/workspace.js";
import { REACT_TEMPLATE_VERSION } from "../../src/runtime/snapshot.js";

// Real owner-scoped PostgreSQL and private Storage. Model output, successful
// build and sandbox identity are explicit fixtures; no model or sandbox starts.
describe.skipIf(process.env.PIVLOOM_REVIEW_INTEGRATION !== "1")("review persistence and finalization boundaries", () => {
  let database: PivloomDatabase, admin: Pool;
  let generation: ReturnType<typeof createGenerationRepository>;
  let models: ReturnType<typeof createModelProfileService>;
  let sources: ReturnType<typeof createSourceStore>;
  let ownerA: string, ownerB: string, model: { id: string; configVersion: number }, manifestPath: string;
  const prefix = `review-fixture-${randomUUID()}`;
  const projectIds: string[] = [], runIds: string[] = [], leaseIds: string[] = [], sourceKeys: string[] = [];
  let cleanupVerifiedAt: string | null = null;
  const save = () => writeFile(manifestPath, JSON.stringify({ prefix, ownerA, ownerB, projectIds, runIds, leaseIds, sourceKeys, cleanupVerifiedAt }, null, 2), { mode: 0o600 });
  const plan: Plan = { schemaVersion: 1, goal: "添加书名", changeSummary: "提供书名输入与列表", assumptions: [], outOfScope: [],
    behaviors: [{ id: "B01", title: "添加书名", precondition: "空书单已打开", action: "输入测试书名并添加", expected: "列表出现测试书名", required: true }] };
  const files = [{ path: "src/App.tsx", content: "export default function App(){return <main>review fixture</main>}" }];

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
    if (!verified) throw Error("An existing verified model profile is required; this fixture never calls or modifies it");
    model = verified;
    generation = createGenerationRepository(database, models, { executorBootId: randomUUID() });
    sources = createSourceStore({ url: process.env.SUPABASE_URL!, secret: process.env.SUPABASE_SECRET_KEY! });
    const directory = resolve("../../.cache/review", environmentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    manifestPath = resolve(directory, `${prefix}.json`);
    await save();
  }, 30_000);

  async function candidate() {
    const project = await createProjectRepository(database).create(ownerA, prefix);
    projectIds.push(project.id); await save();
    const accepted = await generation.accept(ownerA, project.id, { idempotencyKey: randomUUID(), text: "添加书名并展示书单", expectedCurrentRevisionId: null, modelProfileId: model.id, modelConfigVersion: model.configVersion });
    runIds.push(accepted.run.id); leaseIds.push(accepted.run.credentialLeaseId); await save();
    const coordinator = await generation.startCoordinator(ownerA, accepted.run.id);
    await generation.submitPlan(ownerA, accepted.run.id, { roleRunId: coordinator.id, attempt: 0, plan });
    const builder = await generation.startBuilder(ownerA, accepted.run.id);
    await generation.completeBuilder(ownerA, accepted.run.id, { summary: "Explicit build fixture" });
    const source = await sources.save({ ownerId: ownerA, projectId: project.id, revisionId: randomUUID() }, REACT_TEMPLATE_VERSION, files);
    sourceKeys.push(source.key); await save();
    const revision = await generation.saveCandidate(ownerA, accepted.run.id, { source, buildStatus: "passed", build: {
      schemaVersion: 1, sourceHash: source.sourceHash,
      typecheck: { command: "node /workspace/node_modules/typescript/bin/tsc --noEmit", exitCode: 0, durationMs: 1, stdoutTail: "Explicit successful typecheck fixture", stderrTail: "" },
      build: { command: "node /workspace/node_modules/vite/bin/vite.js build", exitCode: 0, durationMs: 1, stdoutTail: "Explicit successful build fixture", stderrTail: "" },
    } });
    const sandbox = { sandboxId: `review-fixture-${randomUUID()}`, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    await generation.registerSandbox(ownerA, accepted.run.id, sandbox);
    await generation.bindPreview(ownerA, accepted.run.id, { ...sandbox, revisionId: revision.id, sourceHash: revision.sourceHash, markerVerified: true, writeRevoked: true, chromeClosed: true });
    return { project, run: accepted.run, builder, revision, source, sandbox };
  }

  async function reviewed(fixture: Awaited<ReturnType<typeof candidate>>, verdict: "passed" | "failed" | "blocked" = "passed", action: "click" | "press" | "reload" = "click") {
    await generation.queueReviewer(ownerA, fixture.run.id, { revisionId: fixture.revision.id });
    const execution = await generation.startReviewer(ownerA, fixture.run.id);
    const staging = new Map<string, Uint8Array>();
    let actions = 0, closes = 0, calls = 0;
    const connection: SandboxConnection = {
      sandboxId: fixture.sandbox.sandboxId, kill: async () => {}, isRunning: async () => true, renew: async () => {}, close: async () => {},
      endpoint: async () => ({ url: "http://preview-fixture.invalid", headers: {} }),
      write: async (path, bytes) => { staging.set(path, bytes); },
      read: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      run: async (command) => {
        let stdoutTail: string;
        if (command.startsWith("node /opt/pivloom/source-io.mjs")) {
          const request = JSON.parse(Buffer.from(staging.get(command.split("'")[1])!).toString());
          stdoutTail = request.op === "read"
            ? JSON.stringify({ data: Buffer.from(files.find((file) => file.path === request.path)!.content).toString("base64") })
            : JSON.stringify({ files: files.map((file) => file.path) });
        } else {
          let data: Record<string, unknown> = {};
          if (command.endsWith("'get' 'url'")) data = { url: "http://127.0.0.1:4173/" };
          else if (command.endsWith("'get' 'text' 'body'")) data = { text: actions && verdict === "passed" ? "测试书名" : "空书单" };
          else if (command.endsWith("'snapshot' '-i'")) data = { snapshot: '- button "添加" [ref=e1]', refs: { e1: { role: "button", name: "添加" } } };
          else if (command.includes("'click'") || command.includes("'press'")) actions++;
          else if (command.endsWith("'close'")) closes++;
          stdoutTail = JSON.stringify({ success: true, data });
        }
        return { id: randomUUID(), interrupt: async () => {}, wait: async () => ({ exitCode: 0, stdoutTail, stderrTail: "" }) };
      },
    };
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      const last = request.messages.filter((message: { role: string }) => message.role === "tool").at(-1);
      const observation = last ? JSON.parse(last.content) : undefined;
      const choice = calls === 1 ? { name: "browser_open", args: { path: "/" } }
        : calls === 2 ? action === "press"
          ? { name: "browser_press", args: { behaviorId: "B01", observationId: observation.observationId, key: "Enter" } }
          : { name: "browser_click", args: { behaviorId: "B01", observationId: observation.observationId, ref: "e1" } }
          : calls === 3 && action === "reload" ? { name: "browser_reload", args: { behaviorId: "B01", observationId: observation.observationId } }
          : { name: "submit_review", args: { revisionId: fixture.revision.id, sourceHash: fixture.revision.sourceHash,
            items: [{ behaviorId: "B01", verdict, expected: plan.behaviors[0].expected, actual: verdict === "passed" ? "列表出现测试书名" : "列表未更新",
              observationEventIds: [observation.id], screenshotIds: [], reproSteps: ["输入测试书名并添加"] }], summary: verdict === "passed" ? "关键流程检查通过" : "添加后列表未更新" } };
      const chunk = { id: "review-db-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name: choice.name, arguments: JSON.stringify(choice.args) } }] }, finish_reason: null }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    };
    const connector = { create: async () => connection, connect: async () => connection };
    const artifactStore = createArtifactStore({ url: process.env.SUPABASE_URL!, secret: process.env.SUPABASE_SECRET_KEY! });
    const output = await runReview({ binding: execution.scope, sessionId: execution.role.sessionId, handoff: execution.handoff, expiresAt: fixture.sandbox.expiresAt,
      source: fixture.source, sources, artifacts: { load: artifactStore.load, async save(scope, image) {
        const artifact = await artifactStore.save(scope, image); sourceKeys.push(artifact.key); await save(); return artifact;
      } },
      sandboxConfig: { baseUrl: "http://sandbox-fixture.invalid", apiKey: "sandbox-fixture", image: "fixture" },
      modelConfig: { provider: "review-db-fixture", id: "fixture", api: "openai-completions", baseUrl: "https://model-fixture.invalid/v1", apiKey: "fixture-not-a-real-key", fetch },
      signal: new AbortController().signal,
      assertActive: () => generation.assertRoleActive(ownerA, fixture.run.id, { role: "reviewer", roleRunId: execution.role.id, attempt: execution.scope.attempt }),
    }, { sandboxConnector: connector, previewFetch: async () => new Response(JSON.stringify({ revisionId: verdict === "blocked" ? randomUUID() : fixture.revision.id, sourceHash: fixture.revision.sourceHash })) });
    return { ...output, execution, stats: { actions, closes, calls } };
  }

  afterAll(async () => {
    if (admin && projectIds.length) {
      const found = await admin.query("SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3", [projectIds, ownerA, prefix]);
      if (found.rowCount !== projectIds.length) throw Error("Refusing cleanup outside review manifest");
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_id=NULL,operation_kind=NULL WHERE id=ANY($1::uuid[])", [projectIds]);
        if ((await admin.query("SELECT to_regclass('nano.checks') AS relation")).rows[0].relation) await admin.query("DELETE FROM nano.checks WHERE project_id=ANY($1::uuid[])", [projectIds]);
        for (const table of ["run_events", "messages", "sandboxes", "role_runs", "revisions", "runs"]) await admin.query(`DELETE FROM nano.${table} WHERE project_id=ANY($1::uuid[])`, [projectIds]);
        await admin.query("DELETE FROM nano.model_credential_leases WHERE owner_id=$1 AND id=ANY($2::uuid[])", [ownerA, leaseIds]);
        await admin.query("DELETE FROM nano.projects WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
    }
    if (sourceKeys.length) {
      if (!sourceKeys.every((key) => projectIds.some((id) => key.startsWith(`${ownerA}/${id}/`)))) throw Error("Object cleanup outside review manifest");
      const storage = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } }).storage;
      if ((await storage.from("pivloom-private").remove(sourceKeys)).error) throw Error("Exact object cleanup failed");
    }
    if (admin && projectIds.length) {
      const remaining = await admin.query(`SELECT
        (SELECT count(*)::int FROM nano.projects WHERE id=ANY($1::uuid[])) AS projects,
        (SELECT count(*)::int FROM nano.runs WHERE id=ANY($2::uuid[])) AS runs,
        (SELECT count(*)::int FROM nano.model_credential_leases WHERE id=ANY($3::uuid[])) AS leases,
        (SELECT count(*)::int FROM storage.objects WHERE bucket_id='pivloom-private' AND name=ANY($4::text[])) AS objects`, [projectIds, runIds, leaseIds, sourceKeys]);
      expect(remaining.rows[0]).toEqual({ projects: 0, runs: 0, leases: 0, objects: 0 });
      cleanupVerifiedAt = new Date().toISOString(); await save();
    }
    await database?.close(); await admin?.end();
  }, 30_000);

  test("a saved candidate queues one version-bound reviewer before execution and never promotes on handoff", async () => {
    const fixture = await candidate();
    const queued = await generation.queueReviewer(ownerA, fixture.run.id, { revisionId: fixture.revision.id });
    expect(queued.role).toMatchObject({ role: "reviewer", state: "queued", predecessorId: fixture.builder.id, attempt: 0 });
    expect(queued.role.sessionId).not.toBe(fixture.builder.sessionId);
    expect(queued.scope).toMatchObject({ runId: fixture.run.id, roleRunId: queued.role.id, attempt: 0, revisionId: fixture.revision.id, sourceHash: fixture.revision.sourceHash, sandboxId: fixture.sandbox.sandboxId });
    expect(queued.scope.browserSessionId).toMatch(/^pivloom-[a-f0-9-]+$/);
    expect(queued.handoff).toMatchObject({ fromRoleRunId: fixture.builder.id, toRole: "reviewer", expectedRevisionId: fixture.revision.id, sourceHash: fixture.revision.sourceHash, plan });
    const durable = await generation.readRunSnapshot(ownerA, fixture.run.id);
    expect(durable.roles.at(-1)).toMatchObject({ id: queued.role.id, state: "queued" });
    expect(durable.run.state).toBe("verifying");
    expect((await generation.readProjectSnapshot(ownerA, fixture.project.id)).project.currentRevisionId).toBeNull();
    const started = await generation.startReviewer(ownerA, fixture.run.id);
    expect(started.role.state).toBe("running");
    expect(started.scope).toEqual(queued.scope);
    await expect(generation.startReviewer(ownerB, fixture.run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await generation.finishFailed(ownerA, fixture.run.id, { code: "FIXTURE_COMPLETE", message: "No actual Reviewer invoked", retryable: false, cleanupState: "confirmed" });
  }, 120_000);

  test("an unavailable version is recorded as blocked without promoting and releases its lease after the browser closes", async () => {
    const fixture = await candidate();
    const review = await reviewed(fixture, "blocked");
    expect(review.receipt.markerVerified).toBe(false);
    expect(review.stats).toEqual({ actions: 0, closes: 0, calls: 0 });
    const finished = await generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt });
    expect(finished.run).toMatchObject({ state: "failed", cleanupState: "clear", error: { code: "CHECK_BLOCKED" } });
    expect(finished.check).toMatchObject({ verdict: "blocked", revisionId: fixture.revision.id });
    expect((await generation.getRunCheck(ownerA, fixture.run.id))?.id).toBe(finished.check.id);
    expect((await generation.readProjectSnapshot(ownerA, fixture.project.id)).project.currentRevisionId).toBeNull();
    await expect(models.freezeForRun(ownerA, model.id, model.configVersion, fixture.run.id)).rejects.toMatchObject({ code: "MODEL_LEASE_RELEASED" });
  }, 180_000);

  test("only an active exact-version review can atomically promote, with owner-isolated checks and private artifacts", async () => {
    const fixture = await candidate();
    const review = await reviewed(fixture);
    expect(review.receipt.markerVerified).toBe(true);
    expect(review.stats).toEqual({ actions: 1, closes: 1, calls: 3 });
    expect(review.receipt.artifacts).toHaveLength(1);
    await expect(generation.finishReview(ownerB, fixture.run.id, { receipt: review.receipt })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.finishReview(ownerA, fixture.run.id, { receipt: JSON.parse(JSON.stringify(review.receipt)) })).rejects.toMatchObject({ code: "INVALID_REVIEW_RECEIPT" });
    const binding = review.execution.scope;
    for (const [field, value] of Object.entries({ revisionId: randomUUID(), sourceHash: "b".repeat(64), attempt: 1,
      roleRunId: randomUUID(), runId: randomUUID(), sandboxId: "different-sandbox", browserSessionId: `pivloom-${randomUUID()}` })) {
      await admin.query("UPDATE nano.role_runs SET review_binding_json=$3 WHERE owner_id=$1 AND id=$2", [ownerA, binding.roleRunId, { ...binding, [field]: value }]);
      await expect(generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt })).rejects.toMatchObject({ code: "REVIEW_BINDING_MISMATCH" });
    }
    await admin.query("UPDATE nano.role_runs SET review_binding_json=$3 WHERE owner_id=$1 AND id=$2", [ownerA, binding.roleRunId, binding]);
    await admin.query("UPDATE nano.runs SET attempt=1 WHERE owner_id=$1 AND id=$2", [ownerA, fixture.run.id]);
    await expect(generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt })).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    await admin.query("UPDATE nano.runs SET attempt=0,state='cancel_requested' WHERE owner_id=$1 AND id=$2", [ownerA, fixture.run.id]);
    await expect(generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt })).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    await admin.query("UPDATE nano.runs SET state='verifying',deadline_at=now()-interval '1 second' WHERE owner_id=$1 AND id=$2", [ownerA, fixture.run.id]);
    await expect(generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt })).rejects.toMatchObject({ code: "RUN_TIMEOUT" });
    await admin.query("UPDATE nano.runs SET deadline_at=$3 WHERE owner_id=$1 AND id=$2", [ownerA, fixture.run.id, fixture.run.deadlineAt]);
    await admin.query("UPDATE nano.projects SET current_revision_id=$3 WHERE owner_id=$1 AND id=$2", [ownerA, fixture.project.id, fixture.revision.id]);
    await expect(generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt })).rejects.toMatchObject({ code: "STALE_BASE" });
    await admin.query("UPDATE nano.projects SET current_revision_id=NULL WHERE owner_id=$1 AND id=$2", [ownerA, fixture.project.id]);
    await admin.query("UPDATE nano.revisions SET build_json=$3 WHERE owner_id=$1 AND id=$2", [ownerA, fixture.revision.id, { ...fixture.revision.build, sourceHash: "b".repeat(64) }]);
    await expect(generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt })).rejects.toMatchObject({ code: "BUILD_NOT_VERIFIED" });
    await admin.query("UPDATE nano.revisions SET build_json=$3 WHERE owner_id=$1 AND id=$2", [ownerA, fixture.revision.id, fixture.revision.build]);
    expect(await generation.getRunCheck(ownerA, fixture.run.id)).toBeNull();
    const published: unknown[] = [];
    const failing = createGenerationRepository({ owned: <T>(ownerId: string, operation: (client: PoolClient) => Promise<T>) => database.owned(ownerId, async (client) => {
      await operation(client); throw Error("injected review commit failure");
    }) }, models, { executorBootId: randomUUID(), onCommittedEvent: (_owner, event) => { published.push(event); } });
    await expect(failing.finishReview(ownerA, fixture.run.id, { receipt: review.receipt })).rejects.toThrow("injected review commit failure");
    expect(published).toEqual([]);
    expect(await generation.getRunCheck(ownerA, fixture.run.id)).toBeNull();
    expect((await generation.getRevision(ownerA, fixture.revision.id)).status).toBe("candidate");
    expect((await generation.readProjectSnapshot(ownerA, fixture.project.id)).project.currentRevisionId).toBeNull();
    expect((await models.freezeForRun(ownerA, model.id, model.configVersion, fixture.run.id)).id).toBe(fixture.run.credentialLeaseId);
    const finished = await generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt });
    expect(finished.run).toMatchObject({ state: "completed", cleanupState: "clear", error: null });
    expect(finished.revision.status).toBe("accepted");
    expect(finished.check).toMatchObject({ verdict: "passed", ...binding });
    expect((await generation.readProjectSnapshot(ownerA, fixture.project.id)).project.currentRevisionId).toBe(fixture.revision.id);
    expect((await generation.getCheck(ownerA, finished.check.id)).id).toBe(finished.check.id);
    await expect(generation.getCheck(ownerB, finished.check.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(generation.getRunCheck(ownerB, fixture.run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const artifact = finished.check.artifacts[0];
    expect("key" in artifact).toBe(false);
    const stored = await generation.getArtifact(ownerA, artifact.id);
    expect(stored).toMatchObject({ checkId: finished.check.id, source: { revisionId: fixture.revision.id }, artifact: { id: artifact.id, bytes: 8 } });
    await expect(generation.getArtifact(ownerB, artifact.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const bytes = await createArtifactStore({ url: process.env.SUPABASE_URL!, secret: process.env.SUPABASE_SECRET_KEY! }).load(stored.source, stored.artifact);
    expect([...bytes]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    await expect(generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt })).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    expect((await generation.listProjectMessages(ownerA, fixture.project.id)).filter((message) => message.kind === "result")).toHaveLength(1);
    expect((await generation.listEvents(ownerA, fixture.run.id)).slice(-3).map((event) => event.type)).toEqual(["role.completed", "check.completed", "run.finished"]);
    await expect(models.freezeForRun(ownerA, model.id, model.configVersion, fixture.run.id)).rejects.toMatchObject({ code: "MODEL_LEASE_RELEASED" });
  }, 300_000);

  test("an observed behavior failure becomes needs_changes and never promotes its candidate", async () => {
    const fixture = await candidate();
    const review = await reviewed(fixture, "failed");
    expect(review.receipt.markerVerified).toBe(true);
    const finished = await generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt });
    expect(finished.run).toMatchObject({ state: "needs_changes", cleanupState: "clear", error: null });
    expect(finished.check.verdict).toBe("failed");
    expect(finished.revision.status).toBe("rejected");
    expect((await generation.readProjectSnapshot(ownerA, fixture.project.id)).project.currentRevisionId).toBeNull();
  }, 180_000);

  test("an Enter keyboard action retains its key and can promote after its observed behavior passes", async () => {
    const fixture = await candidate();
    const review = await reviewed(fixture, "passed", "press");
    expect(review.stats).toEqual({ actions: 1, closes: 1, calls: 3 });
    const finished = await generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt });
    expect(finished.run.state).toBe("completed");
    expect(finished.check.verdict).toBe("passed");
    expect((await generation.readProjectSnapshot(ownerA, fixture.project.id)).project.currentRevisionId).toBe(fixture.revision.id);
    const persisted = await admin.query("SELECT evidence_json FROM nano.checks WHERE owner_id=$1 AND id=$2", [ownerA, finished.check.id]);
    expect(persisted.rows[0].evidence_json).toContainEqual(expect.objectContaining({ behaviorId: "B01", action: "press", key: "Enter" }));
  }, 180_000);

  test("a reload after adding retains its bound observation through real persistence and finalization", async () => {
    const fixture = await candidate();
    const review = await reviewed(fixture, "passed", "reload");
    expect(review.stats).toEqual({ actions: 1, closes: 1, calls: 4 });
    const finished = await generation.finishReview(ownerA, fixture.run.id, { receipt: review.receipt });
    expect(finished.run.state).toBe("completed");
    expect(finished.check.verdict).toBe("passed");
    expect((await generation.readProjectSnapshot(ownerA, fixture.project.id)).project.currentRevisionId).toBe(fixture.revision.id);
    const persisted = await admin.query("SELECT evidence_json FROM nano.checks WHERE owner_id=$1 AND id=$2", [ownerA, finished.check.id]);
    expect(persisted.rows[0].evidence_json).toContainEqual(expect.objectContaining({ behaviorId: "B01", action: "reload", text: "测试书名" }));
  }, 180_000);
});
