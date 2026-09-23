import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createSourceStore } from "../../src/storage/source.js";
import { createArtifactStore } from "../../src/storage/artifacts.js";
import { createGenerationExecutor } from "../../src/generation/executor.js";
import { createPreviewGateway } from "../../src/generation/preview.js";
import type { SandboxConnection, SandboxConnector } from "../../src/runtime/workspace.js";

const plan = { schemaVersion: 1 as const, goal: "点击加一", changeSummary: "计数器", assumptions: [], outOfScope: [],
  behaviors: [{ id: "B01", title: "加一", precondition: "初始为零", action: "点击加一", expected: "计数显示1", required: true }] };

/** Real executor, Pi roles, repository transactions and snapshot validation.
 * Only provider SSE, remote processes/files/browser and object storage are fixtures.
 * This suite requires an explicitly isolated database, never the public service DB. */
describe.skipIf(process.env.PIVLOOM_EXECUTOR_INTEGRATION !== "1")("executor repair and iteration", () => {
  let database: PivloomDatabase;
  let admin: Pool;
  let owner: string;
  let models: ReturnType<typeof createModelProfileService>;
  let repository: ReturnType<typeof createGenerationRepository>;
  let model: { id: string; configVersion: number };
  const projects: string[] = [], leases: string[] = [];
  const prefix = `executor-fixture-${randomUUID()}`;
  const closers: Array<() => Promise<void>> = [];
  const finished = new Map<string, () => void>();
  const objects = new Map<string, Uint8Array>();
  const sources = createSourceStore({ url: "http://storage-fixture.invalid", secret: "fixture",
    objects: { upload: async (key, body) => { objects.set(key, body); }, download: async (key) => objects.get(key)!, list: async () => [] } });

  beforeAll(async () => {
    const environment = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environment || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY
      || !new URL(process.env.DATABASE_URL).pathname.startsWith("/pivloom_executor_test_"))
      throw Error("Executor tests require an explicit isolated environment");
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
    if ((await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true")).rows[0]?.environment_id !== environment)
      throw Error("Isolated database identity mismatch");
    const configuredOwner = process.env.PIVLOOM_EXECUTOR_OWNER_ID;
    const identity = configuredOwner ? null : JSON.parse(await readFile(resolve("../../.cache/identity", environment, "manifest.json"), "utf8"));
    owner = configuredOwner ?? identity.users.find((user: { label: string }) => user.label === "A").id;
    database = new PivloomDatabase(process.env.DATABASE_URL);
    models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY));
    const profile = (await models.list(owner)).find((item) => item.capabilities.streaming === "verified" && item.capabilities.tools === "verified");
    if (!profile) throw Error("Isolated test account needs a verified profile");
    model = profile;
    repository = createGenerationRepository(database, models, { executorBootId: randomUUID(), maxSandboxes: 5,
      onCommittedEvent: (_owner, event) => { if (event.type === "run.finished") finished.get(event.runId)?.(); } });
  }, 30_000);

  afterAll(async () => {
    for (const close of closers.reverse()) await close();
    if (admin && projects.length) {
      const found = await admin.query("SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3", [projects, owner, prefix]);
      if (found.rowCount !== projects.length) throw Error("Refusing cleanup outside executor fixture");
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_kind=NULL,operation_id=NULL WHERE id=ANY($1::uuid[])", [projects]);
        for (const table of ["preview_restores", "checks", "run_events", "messages", "sandboxes", "role_runs", "revisions", "runs"])
          await admin.query(`DELETE FROM nano.${table} WHERE project_id=ANY($1::uuid[])`, [projects]);
        await admin.query("DELETE FROM nano.model_credential_leases WHERE id=ANY($1::uuid[]) AND owner_id=$2", [leases, owner]);
        await admin.query("DELETE FROM nano.projects WHERE id=ANY($1::uuid[])", [projects]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
    }
    await database?.close(); await admin?.end();
  }, 30_000);

  async function fixture(mode: "normal" | "build-once" | "tool-budget" | "cleanup-fails" | "restore-cleanup-fails" | "restore-build-fails" | "cancel-builder" | "cancel-builder-cleanup-fails" | "model-fails",
    options: { failCancelledWrites?: number; failFailedWrites?: number; failRestoreWrites?: number; settlementRetryMs?: number; cleanupSweepMs?: number } = {}) {
    const remotes = new Map<string, { files: Map<string, Buffer>; live: boolean; actions: number; url: string; index: number }>();
    let builderSessions = 0;
    let signalBuilderStarted = () => {};
    const builderStarted = new Promise<void>((resolve) => { signalBuilderStarted = resolve; });
    let cleanupUnavailable = mode === "cleanup-fails" || mode === "restore-cleanup-fails" || mode === "cancel-builder-cleanup-fails";
    let closeHook: (() => Promise<void>) | undefined;
    const builderPrompts: string[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url!, "http://fixture").pathname;
      const id = path.split("/")[3];
      if (path.startsWith("/v1/sandboxes/") && !path.includes("/proxy/")) {
        const remote = remotes.get(id);
        if (request.method === "DELETE" && cleanupUnavailable) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "SANDBOX_UNAVAILABLE", message: "Synthetic cleanup outage" }));
        } else if (request.method === "DELETE") { if (remote) remote.live = false; response.writeHead(204); response.end(); }
        else { response.writeHead(remote?.live ? 200 : 404, { "content-type": "application/json" }); response.end(JSON.stringify(remote?.live ? {} : { code: "SANDBOX_NOT_FOUND", message: "Sandbox missing" })); }
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(remotes.get(id)?.files.get("/opt/pivloom/marker.json") ?? "{}");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Fixture server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    closers.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
    const connections = new Map<string, SandboxConnection>();
    const connector: SandboxConnector = {
      connect: async (_config, id) => connections.get(id)!,
      create: async () => {
        const id = randomUUID();
        const remote = { files: new Map<string, Buffer>(), live: true, actions: 0, url: "http://127.0.0.1:4173/", index: remotes.size };
        remotes.set(id, remote);
        const connection: SandboxConnection = {
          sandboxId: id, kill: async () => {
            if (mode === "cancel-builder-cleanup-fails" && cleanupUnavailable) throw new Error("Synthetic first destroy failure");
            remote.live = false;
          }, isRunning: async () => remote.live,
          renew: async () => {}, close: async () => { const hook = closeHook; closeHook = undefined; await hook?.(); }, endpoint: async () => ({ url: `${origin}/v1/sandboxes/${id}/proxy/4173`, headers: {} }),
          read: async (path) => path.startsWith("/tmp/pivloom-browser/")
            ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV0cAAAAASUVORK5CYII=", "base64")
            : remote.files.get(path) ?? Buffer.alloc(0),
          write: async (path, data) => { remote.files.set(path, Buffer.from(data)); },
          run: async (command) => {
            let stdoutTail = "", exitCode = 0;
            if (command.startsWith("node /opt/pivloom/source-io.mjs")) {
              const request = JSON.parse(remote.files.get(command.split("'")[1])!.toString());
              if (request.op === "write") { remote.files.set(`/workspace/app/${request.path}`, Buffer.from(request.data, "base64")); stdoutTail = '{"ok":true}'; }
              else if (request.op === "read") stdoutTail = JSON.stringify({ data: remote.files.get(`/workspace/app/${request.path}`)?.toString("base64") });
              else stdoutTail = JSON.stringify({ files: [...remote.files.keys()].filter((path) => path.startsWith("/workspace/app/")).map((path) => path.slice(15)) });
            } else if (command.includes('readFileSync("/workspace/package.json"')) stdoutTail = '{"name":"fixture","dependencies":{"react":"19.2.4"}}';
            else if (command.includes('readFileSync("/workspace/package-lock.json"')) stdoutTail = '{"name":"fixture","lockfileVersion":3}';
            else if (command.includes("typescript/bin/tsc") && (mode === "restore-build-fails" || mode === "build-once" && remote.index === 0)) { exitCode = 2; stdoutTail = "src/App.tsx(1,1): error TS1005: fixture semicolon expected"; }
            else if (command.includes("agent-browser")) {
              let data: Record<string, unknown> = {};
              if (command.includes("'open'")) remote.url = command.split("'open' '")[1]?.split("'")[0] ?? remote.url;
              if (command.endsWith("'get' 'url'")) data = { url: remote.url };
              else if (command.endsWith("'get' 'text' 'body'")) data = { text: (mode === "tool-budget" || mode === "cleanup-fails") && remote.index === 0 ? "计数0" : `计数${remote.actions ? 1 : 0}` };
              else if (command.endsWith("'snapshot' '-i'")) data = { snapshot: '- button "加一" [ref=e1]', refs: { e1: { role: "button", name: "加一" } } };
              else if (command.includes("'click'")) remote.actions++;
              stdoutTail = JSON.stringify({ success: true, data });
            }
            return { id: randomUUID(), interrupt: async () => {}, wait: async () => ({ exitCode, stdoutTail, stderrTail: "" }) };
          },
        };
        connections.set(id, connection); return connection;
      },
    };
    let providerRequests = 0;
    const modelFetch: typeof fetch = async (_url, init) => {
      providerRequests++;
      if (mode === "model-fails") return new Response(JSON.stringify({ error: { message: "Fixture invalid credential", type: "invalid_api_key" } }),
        { status: 401, headers: { "content-type": "application/json" } });
      const request = JSON.parse(String(init?.body));
      const tools: string[] = request.tools.map((tool: { function: { name: string } }) => tool.function.name);
      const messages: Array<{ role: string; content: string; tool_calls?: Array<{ function: { name: string } }> }> = request.messages;
      const responses = messages.filter((message) => message.role === "tool");
      const last = responses.at(-1);
      if ((mode === "cancel-builder" || mode === "cancel-builder-cleanup-fails") && tools.includes("write")) {
        signalBuilderStarted();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const stopped = () => reject(new DOMException("Builder request stopped", "AbortError"));
          if (signal?.aborted) stopped();
          else signal?.addEventListener("abort", stopped, { once: true });
        });
      }
      let calls: Array<{ name: string; args: unknown }> = [];
      if (tools.includes("submit_plan")) calls = [{ name: "submit_plan", args: { plan } }];
      else if (tools.includes("write")) {
        if (!messages.some((message) => message.role === "assistant")) {
          builderSessions++; builderPrompts.push(JSON.stringify(messages));
          const count = mode === "tool-budget" && builderSessions > 1 ? 2 : 1;
          calls = Array.from({ length: count }, () => ({ name: "write", args: { path: "src/App.tsx", content: "export default function App(){return <button>加一</button>}" } }));
          if (mode === "normal") calls.push({ name: "write", args: { path: "README.md", content: "preserve this existing file across modifications" } });
        }
      } else if (tools.includes("browser_open")) {
        const priorCalls = messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name);
        if (!priorCalls.includes("browser_open")) calls = [{ name: "browser_open", args: {} }];
        else if (!priorCalls.includes("browser_click")) {
          const observation = responses.map((message) => { try { return JSON.parse(message.content); } catch { return null; } }).reverse().find((value) => value?.observationId);
          calls = [{ name: "browser_click", args: { behaviorId: "B01", observationId: observation.observationId, ref: "e1" } }];
        } else {
          const observation = JSON.parse(last!.content);
          const failed = (mode === "tool-budget" || mode === "cleanup-fails") && builderSessions === 1;
          calls = [{ name: "record_behavior", args: { behaviorId: "B01", verdict: failed ? "failed" : "passed",
            expected: plan.behaviors[0].expected, actual: failed ? "点击后仍为0" : "点击后显示1",
            observationEventIds: [observation.id], screenshotIds: [], reproSteps: ["点击加一"] } }];
        }
      }
      const delta = calls.length ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
        : { role: "assistant", content: "完成" };
      const chunk = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    };
    const previews = createPreviewGateway({ publicOrigin: "http://localhost:45311", appOrigin: "http://localhost:45231", sandboxOrigin: origin,
      isSessionActive: async () => true });
    let cancelledWrites = 0;
    let failedWrites = 0;
    let restoreWrites = 0;
    const executionRepository = options.failCancelledWrites || options.failFailedWrites || options.failRestoreWrites ? {
      ...repository,
      async finishCancelled(...args: Parameters<typeof repository.finishCancelled>) {
        cancelledWrites++;
        if (cancelledWrites <= (options.failCancelledWrites ?? 0)) throw new Error("Synthetic terminal transaction outage");
        return repository.finishCancelled(...args);
      },
      async finishFailed(...args: Parameters<typeof repository.finishFailed>) {
        failedWrites++;
        if (failedWrites <= (options.failFailedWrites ?? 0)) throw new Error("Synthetic failure transaction outage");
        return repository.finishFailed(...args);
      },
      async failRestore(...args: Parameters<typeof repository.failRestore>) {
        restoreWrites++;
        if (restoreWrites <= (options.failRestoreWrites ?? 0)) throw new Error("Synthetic restore transaction outage");
        return repository.failRestore(...args);
      },
    } : repository;
    const executor = createGenerationExecutor({ repository: executionRepository, models, sources, previews, sandbox: { baseUrl: origin, apiKey: "external-sandbox-secret-never-in-generated-source", image: "fixture" }, maxSandboxes: 5,
      artifacts: createArtifactStore({ url: "http://storage-fixture.invalid", secret: "fixture", objects: {
        upload: async (key, bytes) => { objects.set(key, bytes); }, download: async (key) => objects.get(key)!,
      } }) }, { sandboxConnector: connector, modelFetch, ...(mode === "tool-budget" ? { maxToolCalls: 6 } : {}),
        ...(options.settlementRetryMs ? { settlementRetryMs: options.settlementRetryMs } : {}),
        ...(options.cleanupSweepMs ? { cleanupSweepMs: options.cleanupSweepMs } : {}) });
    closers.push(async () => { await executor.close(); await previews.close(); });
    return { executor, remotes, builderPrompts, builderStarted, cancelledWrites: () => cancelledWrites,
      failedWrites: () => failedWrites, restoreWrites: () => restoreWrites, providerRequests: () => providerRequests,
      allowCleanup() { cleanupUnavailable = false; }, onRelease(hook: () => Promise<void>) { closeHook = hook; } };
  }

  async function run(f: Awaited<ReturnType<typeof fixture>>, projectId?: string) {
    const project = projectId ? await createProjectRepository(database).get(owner, projectId) : await createProjectRepository(database).create(owner, prefix);
    if (!projects.includes(project.id)) projects.push(project.id);
    const accepted = await repository.accept(owner, project.id, { idempotencyKey: randomUUID(), text: "初始0，点击加一显示1", expectedCurrentRevisionId: project.currentRevisionId, modelProfileId: model.id, modelConfigVersion: model.configVersion });
    leases.push(accepted.run.credentialLeaseId);
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(Error("Executor fixture did not finish")), 600_000);
      finished.set(accepted.run.id, () => { clearTimeout(timer); finished.delete(accepted.run.id); done(); });
      f.executor.start(accepted.run);
    });
    await f.executor.close();
    return { ...await repository.readRunSnapshot(owner, accepted.run.id), projectId: project.id };
  }

  test("a build failure repairs the saved candidate and preserves existing project files", async () => {
    const initial = await run(await fixture("normal"));
    expect(initial.run.state, JSON.stringify(initial.run.error)).toBe("completed");
    const before = await repository.getRevision(owner, initial.run.resultRevisionId!);
    const repair = await fixture("build-once");
    const result = await run(repair, initial.projectId);
    expect(result.run).toMatchObject({ state: "completed", attempt: 1 });
    const revisions = (await repository.listProjectRevisions(owner, initial.projectId)).filter((revision) => revision.runId === result.run.id);
    expect(revisions.map((revision) => [revision.attempt, revision.buildStatus]).sort()).toEqual([[0, "failed"], [1, "passed"]]);
    const bundle = await sources.load((await repository.getRevision(owner, result.run.resultRevisionId!)).source);
    expect(bundle.files.find((file) => file.path === "README.md")?.content).toBe("preserve this existing file across modifications");
    expect(repair.builderPrompts[1]).toContain("TS1005");
    expect((await repository.getRevision(owner, before.id)).sourceHash).toBe(before.sourceHash);
  }, 900_000);

  test("Reviewer actions consume the same tool allowance as the next repair Builder", async () => {
    const result = await run(await fixture("tool-budget"));
    expect(result.run).toMatchObject({ state: "failed", attempt: 1, error: { code: "TOOL_BUDGET_EXCEEDED" } });
    const events = await repository.listEvents(owner, result.run.id, "0", 200);
    expect(events.length).toBeLessThan(200);
    expect(events.filter((event) => event.type === "tool.started").length).toBeLessThanOrEqual(6);
    expect((await createProjectRepository(database).get(owner, result.projectId)).currentRevisionId).toBeNull();
  }, 900_000);

  test("a rebuilt preview is destroyed if its restore is no longer active before binding", async () => {
    const initial = await run(await fixture("normal"));
    expect(initial.run.state).toBe("completed");
    const before = await repository.getRevision(owner, initial.run.resultRevisionId!);
    const restore = await repository.beginRestore(owner, initial.projectId, { revisionId: before.id, idempotencyKey: randomUUID() });
    const remote = await fixture("normal");
    remote.onRelease(async () => {
      await repository.failRestore(owner, initial.projectId, restore.restore.id, { code: "RESTORE_TIMEOUT", message: "Restore ended before binding" });
    });
    await remote.executor.restore(restore.restore, restore.revision);
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
    expect(remote.builderPrompts).toEqual([]);
    expect((await createProjectRepository(database).get(owner, initial.projectId)).currentRevisionId).toBe(before.id);
    expect((await repository.getRevision(owner, before.id)).sourceHash).toBe(before.sourceHash);
  }, 900_000);

  test("an unconfirmed restore cleanup keeps a durable sandbox binding and unlocks only after destruction", async () => {
    const initial = await run(await fixture("normal"));
    expect(initial.run.state).toBe("completed");
    const before = await repository.getRun(owner, initial.run.id);
    const restore = await repository.beginRestore(owner, initial.projectId, { revisionId: initial.run.resultRevisionId!, idempotencyKey: randomUUID() });
    const remote = await fixture("restore-cleanup-fails");
    remote.onRelease(async () => {
      await repository.failRestore(owner, initial.projectId, restore.restore.id, { code: "RESTORE_TIMEOUT", message: "Restore ended before binding" });
    });
    await remote.executor.restore(restore.restore, restore.revision);
    const pending = await repository.getActiveRestore(owner, initial.projectId, restore.revision.id);
    expect(pending).toMatchObject({ status: "pending", sandboxId: [...remote.remotes.keys()][0] });
    expect(pending?.error).not.toBeNull();
    expect(await repository.getPreviewBinding(owner, initial.projectId, restore.revision.id)).toMatchObject({ state: "creating", sandboxId: pending?.sandboxId });
    expect(await repository.getRun(owner, initial.run.id)).toEqual(before);
    await expect(repository.beginRestore(owner, initial.projectId, { revisionId: restore.revision.id, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    remote.allowCleanup();
    await remote.executor.close();
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
    expect(await repository.getActiveRestore(owner, initial.projectId, restore.revision.id)).toMatchObject({ status: "failed" });
    expect(await repository.getRun(owner, initial.run.id)).toEqual(before);
    const retry = await repository.beginRestore(owner, initial.projectId, { revisionId: restore.revision.id, idempotencyKey: randomUUID() });
    expect(retry.restore.status).toBe("pending");
    await repository.failRestore(owner, initial.projectId, retry.restore.id, { code: "FIXTURE_CLEANUP", message: "No sandbox was created" });
  }, 900_000);

  test("an unconfirmed rejected-sandbox cleanup stops repair and keeps the project locked", async () => {
    const initial = await run(await fixture("normal"));
    expect(initial.run.state).toBe("completed");
    const remote = await fixture("cleanup-fails");
    const result = await run(remote, initial.projectId);
    expect(result.run).toMatchObject({ state: "failed", attempt: 0, cleanupState: "pending", error: { code: "SANDBOX_CLEANUP_PENDING" } });
    expect(remote.builderPrompts).toHaveLength(1);
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([true]);
    expect((await repository.getRunCheck(owner, result.run.id))?.verdict).toBe("failed");
    expect((await createProjectRepository(database).get(owner, initial.projectId)).currentRevisionId).toBe(initial.run.resultRevisionId);
    await expect(repository.accept(owner, initial.projectId, { idempotencyKey: randomUUID(), text: "重新尝试", expectedCurrentRevisionId: initial.run.resultRevisionId,
      modelProfileId: model.id, modelConfigVersion: model.configVersion })).rejects.toMatchObject({ code: "PROJECT_BUSY" });
  }, 900_000);

  test("stopping during Builder model streaming ends as cancelled after its candidate sandbox is destroyed", async () => {
    const remote = await fixture("cancel-builder");
    const project = await createProjectRepository(database).create(owner, prefix);
    projects.push(project.id);
    const accepted = await repository.accept(owner, project.id, {
      idempotencyKey: randomUUID(), text: "初始0，点击加一显示1", expectedCurrentRevisionId: null,
      modelProfileId: model.id, modelConfigVersion: model.configVersion,
    });
    leases.push(accepted.run.credentialLeaseId);
    const finishedRun = new Promise<void>((resolve) => {
      finished.set(accepted.run.id, () => { finished.delete(accepted.run.id); resolve(); });
    });
    remote.executor.start(accepted.run);
    let startedTimer: ReturnType<typeof setTimeout> | undefined;
    const reachedBuilder = await Promise.race([
      remote.builderStarted.then(() => true),
      finishedRun.then(() => false),
      new Promise<boolean>((resolve) => { startedTimer = setTimeout(() => resolve(false), 120_000); }),
    ]);
    clearTimeout(startedTimer);
    expect(reachedBuilder).toBe(true);
    expect((await repository.cancel(owner, accepted.run.id)).state).toBe("cancel_requested");
    expect(remote.executor.cancel(accepted.run.id)).toBe(true);
    await finishedRun;
    const snapshot = await repository.readRunSnapshot(owner, accepted.run.id);
    expect(snapshot.run.state).toBe("cancelled");
    expect(snapshot.run.cleanupState).toBe("confirmed");
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
    expect((await createProjectRepository(database).get(owner, project.id)).currentRevisionId).toBeNull();
  }, 300_000);

  test("terminal transaction outage keeps cancellation owned and settles after the database recovers", async () => {
    const remote = await fixture("cancel-builder", { failCancelledWrites: 3, settlementRetryMs: 50 });
    const project = await createProjectRepository(database).create(owner, prefix);
    projects.push(project.id);
    const accepted = await repository.accept(owner, project.id, {
      idempotencyKey: randomUUID(), text: "初始0，点击加一显示1", expectedCurrentRevisionId: null,
      modelProfileId: model.id, modelConfigVersion: model.configVersion,
    });
    leases.push(accepted.run.credentialLeaseId);
    remote.executor.start(accepted.run);
    await remote.builderStarted;
    expect((await repository.cancel(owner, accepted.run.id)).state).toBe("cancel_requested");
    expect(remote.executor.cancel(accepted.run.id)).toBe(true);
    const deadline = Date.now() + 45_000;
    let settled = await repository.getRun(owner, accepted.run.id);
    while (settled.state !== "cancelled" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = await repository.getRun(owner, accepted.run.id);
    }
    expect(remote.cancelledWrites()).toBeGreaterThanOrEqual(4);
    expect(settled.state).toBe("cancelled");
    expect(settled.cleanupState).toBe("confirmed");
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE owner_id=$1 AND id=$2", [owner, project.id])).rows[0].operation_id).toBeNull();
  }, 180_000);

  test("a failed Provider run persists its original error after transient terminal DB failures without model replay", async () => {
    const remote = await fixture("model-fails", { failFailedWrites: 3, settlementRetryMs: 50 });
    const project = await createProjectRepository(database).create(owner, prefix);
    projects.push(project.id);
    const accepted = await repository.accept(owner, project.id, {
      idempotencyKey: randomUUID(), text: "初始0，点击加一显示1", expectedCurrentRevisionId: null,
      modelProfileId: model.id, modelConfigVersion: model.configVersion,
    });
    leases.push(accepted.run.credentialLeaseId);
    remote.executor.start(accepted.run);
    const deadline = Date.now() + 45_000;
    let settled = await repository.getRun(owner, accepted.run.id);
    while (settled.state !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = await repository.getRun(owner, accepted.run.id);
    }
    expect(settled).toMatchObject({ state: "failed", cleanupState: "confirmed", error: { code: "MODEL_FAILED", retryable: true } });
    expect(remote.failedWrites()).toBeGreaterThanOrEqual(4);
    expect(remote.providerRequests()).toBe(1);
    expect(remote.remotes.size).toBe(0);
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE owner_id=$1 AND id=$2", [owner, project.id])).rows[0].operation_id).toBeNull();
  }, 120_000);

  test("a failed first sandbox destroy is retried before its Preview TTL and only then unlocks the project", async () => {
    const remote = await fixture("cancel-builder-cleanup-fails", { cleanupSweepMs: 50 });
    const project = await createProjectRepository(database).create(owner, prefix);
    projects.push(project.id);
    const accepted = await repository.accept(owner, project.id, {
      idempotencyKey: randomUUID(), text: "初始0，点击加一显示1", expectedCurrentRevisionId: null,
      modelProfileId: model.id, modelConfigVersion: model.configVersion,
    });
    leases.push(accepted.run.credentialLeaseId);
    const finishedRun = new Promise<void>((resolve) => {
      finished.set(accepted.run.id, () => { finished.delete(accepted.run.id); resolve(); });
    });
    remote.executor.start(accepted.run);
    await remote.builderStarted;
    expect((await repository.cancel(owner, accepted.run.id)).state).toBe("cancel_requested");
    expect(remote.executor.cancel(accepted.run.id)).toBe(true);
    await finishedRun;
    const pending = await repository.getRun(owner, accepted.run.id);
    expect(pending).toMatchObject({ state: "cancelled", cleanupState: "pending" });
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([true]);
    await expect(repository.accept(owner, project.id, {
      idempotencyKey: randomUUID(), text: "retry", expectedCurrentRevisionId: null,
      modelProfileId: model.id, modelConfigVersion: model.configVersion,
    })).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    remote.allowCleanup();
    const deadline = Date.now() + 30_000;
    let settled = await repository.getRun(owner, accepted.run.id);
    while (settled.cleanupState !== "confirmed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = await repository.getRun(owner, accepted.run.id);
    }
    expect(settled.cleanupState).toBe("confirmed");
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE owner_id=$1 AND id=$2", [owner, project.id])).rows[0].operation_id).toBeNull();
  }, 180_000);

  test("restore failure transaction is retried without rebuilding the Preview", async () => {
    const initial = await run(await fixture("normal"));
    expect(initial.run.state).toBe("completed");
    const current = await repository.getRevision(owner, initial.run.resultRevisionId!);
    const begun = await repository.beginRestore(owner, initial.projectId, { revisionId: current.id, idempotencyKey: randomUUID() });
    const remote = await fixture("restore-build-fails", { failRestoreWrites: 1, settlementRetryMs: 50 });
    await remote.executor.restore(begun.restore, begun.revision);
    const deadline = Date.now() + 30_000;
    let status = (await admin.query("SELECT status FROM nano.preview_restores WHERE id=$1", [begun.restore.id])).rows[0].status;
    while (status !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await admin.query("SELECT status FROM nano.preview_restores WHERE id=$1", [begun.restore.id])).rows[0].status;
    }
    expect(remote.restoreWrites()).toBeGreaterThanOrEqual(2);
    expect(status).toBe("failed");
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
    expect((await createProjectRepository(database).get(owner, initial.projectId)).currentRevisionId).toBe(current.id);
    expect(remote.builderPrompts).toEqual([]);
  }, 240_000);
});
