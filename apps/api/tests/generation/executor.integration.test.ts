import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
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
import type { GroupedPlan } from "@pivloom/contracts";

const plan: GroupedPlan = { schemaVersion: 2, goal: "点击加一", changeSummary: "计数器", assumptions: [], outOfScope: [],
  behaviors: [
    { id: "B01", title: "加一", precondition: "初始为零", action: "点击加一", expected: "计数显示1", required: true },
    { id: "B02", title: "再次加一", precondition: "计数显示1", action: "点击加一", expected: "计数继续增加", required: true },
    { id: "B03", title: "重置入口", precondition: "计数已增加", action: "点击加一", expected: "交互保持可用", required: true },
    { id: "B04", title: "刷新后的交互", precondition: "页面已刷新", action: "点击加一", expected: "交互仍可用", required: true },
    { id: "B05", title: "窄屏操作", precondition: "视口宽390像素", action: "点击加一", expected: "按钮仍可点击", required: true },
  ], groups: [
    { id: "G1", title: "基本计数", behaviorIds: ["B01"] },
    { id: "G2", title: "连续输入", behaviorIds: ["B02"] },
    { id: "G3", title: "错误恢复", behaviorIds: ["B03"] },
    { id: "G4", title: "状态与刷新", behaviorIds: ["B04"] },
    { id: "G5", title: "视觉布局", behaviorIds: ["B05"] },
  ], replacements: [] };

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
  let targetVerified = false;
  const fixtureProfileId = randomUUID();
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
    // Opt-in local service-failure tests stop this disposable PostgreSQL process.
    // An idle admin connection can then emit an expected pool error while down.
    admin.on("error", () => {});
    if ((await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true")).rows[0]?.environment_id !== environment)
      throw Error("Isolated database identity mismatch");
    if ((await admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema='nano' AND table_name='checks' AND column_name='group_results_json'")).rowCount !== 1)
      throw Error("Executor test database requires migration 015 for grouped checks");
    targetVerified = true;
    const configuredOwner = process.env.PIVLOOM_EXECUTOR_OWNER_ID;
    const identity = configuredOwner ? null : JSON.parse(await readFile(resolve("../../.cache/identity", environment, "manifest.json"), "utf8"));
    owner = configuredOwner ?? identity.users.find((user: { label: string }) => user.label === "A").id;
    database = new PivloomDatabase(process.env.DATABASE_URL);
    const vault = createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY);
    models = createModelProfileService(database, vault);
    // The provider and browser are explicit test seams. Give this isolated suite
    // its own exact-model image capability fixture; never change account A's
    // saved profile or mistake the fixture for a real Provider probe.
    const sealed = vault.seal("executor-fixture-key-not-real", { ownerId: owner, profileId: fixtureProfileId, version: 1 });
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO nano.model_profiles(id,owner_id,current_version,is_default) VALUES($1,$2,1,false)", [fixtureProfileId, owner]);
      await admin.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask,capabilities)
        VALUES($1,$2,1,$3,'openai-completions','https://model-fixture.invalid/v1','executor-fixture','fixture',
          '{"streaming":"verified","tools":"verified","vision":"verified"}')`, [fixtureProfileId, owner, prefix]);
      await admin.query("INSERT INTO nano.model_credentials(profile_id,config_version,owner_id,ciphertext,nonce,auth_tag) VALUES($1,1,$2,$3,$4,$5)",
        [fixtureProfileId, owner, sealed.ciphertext, sealed.nonce, sealed.authTag]);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    model = { id: fixtureProfileId, configVersion: 1 };
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
    if (admin && targetVerified) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("DELETE FROM nano.model_credentials WHERE owner_id=$1 AND profile_id=$2", [owner, fixtureProfileId]);
        await admin.query("DELETE FROM nano.model_profile_versions WHERE owner_id=$1 AND profile_id=$2", [owner, fixtureProfileId]);
        await admin.query("DELETE FROM nano.model_profiles WHERE owner_id=$1 AND id=$2", [owner, fixtureProfileId]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
    }
    await database?.close(); await admin?.end();
  }, 30_000);

  async function fixture(mode: "normal" | "review-blocked" | "reviewer-infra-once" | "reviewer-infra-twice" | "build-once" | "tool-budget" | "cleanup-fails" | "restore-cleanup-fails" | "restore-build-fails" | "cancel-builder" | "cancel-builder-cleanup-fails" | "model-fails",
    options: { failCancelledWrites?: number; failFailedWrites?: number; failRestoreWrites?: number; settlementRetryMs?: number; cleanupSweepMs?: number;
      observeTerminalWrites?: boolean;
      beforeModelFailure?: () => Promise<void> } = {}) {
    const remotes = new Map<string, { files: Map<string, Buffer>; live: boolean; actions: number; url: string; index: number; renewals: number[] }>();
    let builderSessions = 0;
    const reviewerSessions = new Set<string>();
    let infrastructureFailures = 0;
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
        const remote = { files: new Map<string, Buffer>(), live: true, actions: 0, url: "http://127.0.0.1:4173/", index: remotes.size, renewals: [] as number[] };
        remotes.set(id, remote);
        const connection: SandboxConnection = {
          sandboxId: id, kill: async () => {
            if (mode === "cancel-builder-cleanup-fails" && cleanupUnavailable) throw new Error("Synthetic first destroy failure");
            remote.live = false;
          }, isRunning: async () => remote.live,
          renew: async (seconds) => { remote.renewals.push(seconds); }, close: async () => { const hook = closeHook; closeHook = undefined; await hook?.(); }, endpoint: async () => ({ url: `${origin}/v1/sandboxes/${id}/proxy/4173`, headers: {} }),
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
              const browserSession = command.match(/'--session' '([^']+)'/)?.[1];
              if (browserSession) reviewerSessions.add(browserSession);
              let data: Record<string, unknown> = {};
              if (command.includes("'open'")) remote.url = command.split("'open' '")[1]?.split("'")[0] ?? remote.url;
              if (command.endsWith("'get' 'url'")) data = { url: remote.url };
              else if (command.endsWith("'get' 'text' 'body'")) data = { text: (mode === "tool-budget" || mode === "cleanup-fails") && remote.index === 0 ? "计数0" : `计数${remote.actions ? 1 : 0}` };
              else if (command.endsWith("'snapshot' '-i'")) data = { snapshot: '- button "加一" [ref=e1]', refs: { e1: { role: "button", name: "加一" } } };
              else if (command.includes("'click'")) {
                if ((mode === "reviewer-infra-once" && infrastructureFailures === 0)
                  || (mode === "reviewer-infra-twice" && infrastructureFailures < 2)) {
                  infrastructureFailures++;
                  exitCode = 1;
                  stdoutTail = JSON.stringify({ success: false, error: "Synthetic browser transport failure" });
                } else remote.actions++;
              }
              if (!stdoutTail) stdoutTail = JSON.stringify({ success: true, data });
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
      if (mode === "model-fails") {
        await options.beforeModelFailure?.();
        return new Response(JSON.stringify({ error: { message: "Fixture invalid credential", type: "invalid_api_key" } }),
          { status: 401, headers: { "content-type": "application/json" } });
      }
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
        const completed = priorCalls.filter((name) => name === "record_behavior").length;
        const section = priorCalls.slice(priorCalls.lastIndexOf("record_behavior") + 1);
        const parsedResponses = responses.map((message) => { try { return JSON.parse(message.content); } catch { return null; } });
        const current = plan.behaviors[completed];
        if (!priorCalls.includes("browser_open")) calls = [{ name: "browser_open", args: {} }];
        else if (current && !section.includes("browser_click")) {
          const observation = [...parsedResponses].reverse().find((value) => value?.observationId);
          calls = [{ name: "browser_click", args: { behaviorId: current.id, observationId: observation.observationId, ref: "e1" } }];
        } else if (current && !section.includes("browser_screenshot")) {
          calls = [{ name: "browser_screenshot", args: {} }];
        } else if (current) {
          const screenshot = JSON.parse(last!.content);
          const observation = [...parsedResponses].reverse().find((value) => value?.action === "click" && value.behaviorId === current.id);
          expect(request.messages.some((message: { role: string; content: unknown }) => message.role === "user" && Array.isArray(message.content)
            && message.content.some((part: { type: string; image_url?: { url: string } }) => part.type === "image_url"
              && part.image_url?.url.startsWith("data:image/png;base64,")))).toBe(true);
          const failed = completed === 0 && (mode === "tool-budget" || mode === "cleanup-fails") && builderSessions === 1;
          const blocked = mode === "review-blocked" && completed === 0;
          calls = [{ name: "record_behavior", args: { behaviorId: current.id, verdict: blocked ? "blocked" : failed ? "failed" : "passed",
            expected: current.expected, actual: blocked ? "隔离夹具无法确认计数行为" : failed ? "点击后仍为0" : `点击后观察 ${current.id}`,
            observationEventIds: [observation.id], screenshotIds: [screenshot.artifactId], reproSteps: [`点击加一检查 ${current.id}`] } }];
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
    let terminalDbFailures = 0;
    let restoreWrites = 0;
    const executionRepository = options.failCancelledWrites || options.failFailedWrites || options.failRestoreWrites || options.observeTerminalWrites ? {
      ...repository,
      async finishCancelled(...args: Parameters<typeof repository.finishCancelled>) {
        cancelledWrites++;
        if (cancelledWrites <= (options.failCancelledWrites ?? 0)) throw new Error("Synthetic terminal transaction outage");
        try { return await repository.finishCancelled(...args); }
        catch (error) { terminalDbFailures++; throw error; }
      },
      async finishFailed(...args: Parameters<typeof repository.finishFailed>) {
        failedWrites++;
        if (failedWrites <= (options.failFailedWrites ?? 0)) throw new Error("Synthetic failure transaction outage");
        try { return await repository.finishFailed(...args); }
        catch (error) { terminalDbFailures++; throw error; }
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
      } }) }, { sandboxConnector: connector, modelFetch, ...(mode === "tool-budget" ? { maxToolCalls: 18 } : {}),
        ...(options.settlementRetryMs ? { settlementRetryMs: options.settlementRetryMs } : {}),
        ...(options.cleanupSweepMs ? { cleanupSweepMs: options.cleanupSweepMs } : {}) });
    closers.push(async () => { await executor.close(); await previews.close(); });
    return { executor, remotes, builderPrompts, builderStarted, reviewerSessions, infrastructureFailures: () => infrastructureFailures, cancelledWrites: () => cancelledWrites,
      failedWrites: () => failedWrites, terminalDbFailures: () => terminalDbFailures,
      restoreWrites: () => restoreWrites, providerRequests: () => providerRequests,
      allowCleanup() { cleanupUnavailable = false; }, onRelease(hook: () => Promise<void>) { closeHook = hook; } };
  }

  async function run(f: Awaited<ReturnType<typeof fixture>>, projectId?: string, closeAfter = true, retryOfRunId?: string) {
    const project = projectId ? await createProjectRepository(database).get(owner, projectId) : await createProjectRepository(database).create(owner, prefix);
    if (!projects.includes(project.id)) projects.push(project.id);
    const accepted = await repository.accept(owner, project.id, { idempotencyKey: randomUUID(), text: "初始0，点击加一显示1",
      expectedCurrentRevisionId: project.currentRevisionId, modelProfileId: model.id, modelConfigVersion: model.configVersion,
      retryOfRunId: retryOfRunId ?? null });
    leases.push(accepted.run.credentialLeaseId);
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(Error("Executor fixture did not finish")), 600_000);
      finished.set(accepted.run.id, () => { clearTimeout(timer); finished.delete(accepted.run.id); done(); });
      f.executor.start(accepted.run);
    });
    if (closeAfter) await f.executor.close();
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

  test("a terminal blocked Reviewer preserves source and Check but destroys its candidate sandbox and frees the slot", async () => {
    const remote = await fixture("review-blocked");
    const result = await run(remote);
    expect(result.run.state).toBe("failed");
    expect(result.revision?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await sources.load(result.revision!.source)).files.find((file) => file.path === "src/App.tsx")?.content)
      .toContain("加一");
    const checks = await admin.query("SELECT verdict FROM nano.checks WHERE run_id=$1", [result.run.id]);
    expect(checks.rows.map((row: { verdict: string }) => row.verdict)).toEqual(["blocked"]);
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
    expect(result.binding?.state).toBe("destroyed");
    const occupied = await admin.query("SELECT count(*)::int AS n FROM nano.sandboxes WHERE run_id=$1 AND state NOT IN ('destroyed','expired')", [result.run.id]);
    expect(occupied.rows[0].n).toBe(0);
    const next = await repository.accept(owner, result.projectId, { idempotencyKey: randomUUID(), text: "修复后再试",
      expectedCurrentRevisionId: null, modelProfileId: model.id, modelConfigVersion: model.configVersion });
    leases.push(next.run.credentialLeaseId);
    expect(next.run.state).toBe("accepted");
    await repository.finishCancelled(owner, next.run.id, { cleanupState: "confirmed", summary: "隔离夹具已结束" });
  }, 900_000);

  test("linked retry rebuilds a blocked candidate without Coordinator or Builder model calls", async () => {
    const old = await run(await fixture("review-blocked"));
    expect(old.run).toMatchObject({ state: "failed", error: { code: "CHECK_BLOCKED" } });
    const original = await repository.getRevision(owner, old.run.resultRevisionId!);
    const remote = await fixture("normal");
    const retried = await run(remote, old.projectId, true, old.run.id);
    expect(retried.run).toMatchObject({ state: "completed", attempt: 0, retryOfRunId: old.run.id });
    expect(retried.run.resultRevisionId).not.toBe(original.id);
    const revision = await repository.getRevision(owner, retried.run.resultRevisionId!);
    expect(revision.sourceHash).toBe(original.sourceHash);
    expect(remote.builderPrompts).toHaveLength(0);
    expect(retried.roles.filter((role) => role.role === "coordinator" || role.role === "builder"))
      .toHaveLength(2);
    const roleUsage = await admin.query(`SELECT role,usage_json FROM nano.role_runs WHERE run_id=$1
      AND role IN ('coordinator','builder') ORDER BY role`, [retried.run.id]);
    expect(roleUsage.rows).toMatchObject([
      { role: "builder", usage_json: { modelCalls: 0, toolCalls: 0 } },
      { role: "coordinator", usage_json: { modelCalls: 0, toolCalls: 0 } },
    ]);
    expect((await repository.getRunCheck(owner, retried.run.id))?.verdict).toBe("passed");
  }, 900_000);

  test("one browser infrastructure failure rechecks the exact candidate with a fresh browser and completes", async () => {
    const remote = await fixture("reviewer-infra-once");
    const result = await run(remote, undefined, false);
    try {
      expect(result.run).toMatchObject({ state: "completed", attempt: 0 });
      expect(remote.infrastructureFailures()).toBe(1);
      expect(remote.reviewerSessions.size).toBe(2);
      expect(remote.builderPrompts).toHaveLength(1);
      const revisions = (await repository.listProjectRevisions(owner, result.projectId)).filter((item) => item.runId === result.run.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ id: result.run.resultRevisionId, status: "accepted" });
      expect(result.roles.filter((role) => role.role === "reviewer").map((role) => role.state)).toEqual(["failed", "succeeded"]);
      expect((await repository.getRunCheck(owner, result.run.id))?.verdict).toBe("passed");
      expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([true]);
    } finally { await remote.executor.close(); }
  }, 900_000);

  test("two browser infrastructure failures terminate and clean up without rebuilding or a third reviewer", async () => {
    const remote = await fixture("reviewer-infra-twice");
    const result = await run(remote);
    expect(result.run).toMatchObject({ state: "failed", attempt: 0, error: { code: "CHECK_BLOCKED" } });
    expect(remote.infrastructureFailures()).toBe(2);
    expect(remote.reviewerSessions.size).toBe(2);
    expect(remote.builderPrompts).toHaveLength(1);
    expect((await repository.listProjectRevisions(owner, result.projectId)).filter((item) => item.runId === result.run.id)).toHaveLength(1);
    expect(result.roles.filter((role) => role.role === "reviewer")).toHaveLength(2);
    expect((await repository.getRunCheck(owner, result.run.id))?.verdict).toBe("blocked");
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
  }, 900_000);

  test("only an accepted Reviewer result retains the current candidate preview", async () => {
    const remote = await fixture("normal");
    const result = await run(remote, undefined, false);
    try {
      expect(result.run.state).toBe("completed");
      expect(result.binding?.state).toBe("active");
      const sandbox = [...remote.remotes.values()][0];
      expect(sandbox.live).toBe(true);
      expect(sandbox.renewals).toContain(1_800);
      expect(Date.parse(result.binding!.expiresAt) - Date.parse(result.run.finishedAt!)).toBeGreaterThan(25 * 60_000);
      const stored = await repository.getPreviewBinding(owner, result.projectId, result.run.resultRevisionId!);
      expect(stored?.expiresAt).toBe(result.binding?.expiresAt);
    } finally { await remote.executor.close(); }
  }, 900_000);

  test("Reviewer actions consume the same tool allowance as the next repair Builder", async () => {
    const result = await run(await fixture("tool-budget"));
    expect(result.run).toMatchObject({ state: "failed", attempt: 1, error: { code: "TOOL_BUDGET_EXCEEDED" } });
    const events = await repository.listEvents(owner, result.run.id, "0", 200);
    expect(events.length).toBeLessThan(200);
    expect(events.filter((event) => event.type === "tool.started").length).toBeLessThanOrEqual(18);
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

  test("a short run deadline survives a terminal write outage and keeps the project locked until cleanup confirms", async () => {
    const remote = await fixture("cancel-builder-cleanup-fails", {
      failFailedWrites: 1, settlementRetryMs: 50, cleanupSweepMs: 50,
    });
    const project = await createProjectRepository(database).create(owner, prefix);
    projects.push(project.id);
    const accepted = await repository.accept(owner, project.id, {
      idempotencyKey: randomUUID(), text: "初始0，点击加一显示1", expectedCurrentRevisionId: null,
      modelProfileId: model.id, modelConfigVersion: model.configVersion,
    });
    leases.push(accepted.run.credentialLeaseId);
    // This database is dedicated to the test. Shorten only the accepted test
    // run's deadline before dispatch; production has no prompt-triggered fault.
    const shortDeadline = new Date(Date.now() + 2_000).toISOString();
    await admin.query("UPDATE nano.runs SET deadline_at=$2 WHERE owner_id=$1 AND id=$3", [owner, shortDeadline, accepted.run.id]);
    remote.executor.start({ ...accepted.run, deadlineAt: shortDeadline });
    await remote.builderStarted;

    const pendingBy = Date.now() + 15_000;
    let pending = await repository.getRun(owner, accepted.run.id);
    while ((pending.state !== "failed" || pending.cleanupState !== "pending") && Date.now() < pendingBy) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      pending = await repository.getRun(owner, accepted.run.id);
    }
    expect(pending).toMatchObject({ state: "failed", phase: "cleanup", cleanupState: "pending",
      error: { code: "RUN_TIMEOUT", retryable: true } });
    expect(remote.failedWrites()).toBeGreaterThanOrEqual(2);
    expect(remote.remotes.size).toBe(1);
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([true]);
    const providerCallsAtDeadline = remote.providerRequests();
    const pendingLock = (await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [project.id])).rows[0].operation_id;
    await expect(repository.accept(owner, project.id, {
      idempotencyKey: randomUUID(), text: "retry", expectedCurrentRevisionId: null,
      modelProfileId: model.id, modelConfigVersion: model.configVersion,
    })).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    expect(pendingLock).toBe(accepted.run.id);

    remote.allowCleanup();
    const confirmedBy = Date.now() + 15_000;
    let settled = await repository.getRun(owner, accepted.run.id);
    while (settled.cleanupState !== "confirmed" && Date.now() < confirmedBy) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = await repository.getRun(owner, accepted.run.id);
    }
    expect(settled).toMatchObject({ state: "failed", cleanupState: "confirmed", error: { code: "RUN_TIMEOUT" } });
    expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
    expect(remote.providerRequests()).toBe(providerCallsAtDeadline);
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [project.id])).rows[0].operation_id).toBeNull();
    expect((await createProjectRepository(database).get(owner, project.id)).currentRevisionId).toBeNull();

    const retried = await repository.accept(owner, project.id, {
      idempotencyKey: randomUUID(), text: "retry", expectedCurrentRevisionId: null,
      modelProfileId: model.id, modelConfigVersion: model.configVersion,
      retryOfRunId: accepted.run.id,
    });
    leases.push(retried.run.credentialLeaseId);
    expect(retried.run).toMatchObject({ state: "accepted", requestText: accepted.run.requestText });
    if (process.env.PIVLOOM_RC03_EVIDENCE_FILE) await writeFile(process.env.PIVLOOM_RC03_EVIDENCE_FILE, JSON.stringify({
      environmentId: process.env.PIVLOOM_ENVIRONMENT_ID, runId: accepted.run.id, projectId: project.id,
      injectedDeadlineAt: shortDeadline, pending: { state: pending.state, phase: pending.phase,
        cleanupState: pending.cleanupState, errorCode: pending.error?.code, projectLock: pendingLock },
      terminalWriteAttempts: remote.failedWrites(), remoteLiveAtPending: true,
      settled: { state: settled.state, cleanupState: settled.cleanupState, errorCode: settled.error?.code,
        projectLock: null }, remoteLiveAfterRetry: false,
      providerCallsAtDeadline, providerCallsAfterCleanup: remote.providerRequests(),
      retry: { id: retried.run.id, state: retried.run.state, retryOfRunId: accepted.run.id,
        sameRequestText: retried.run.requestText === accepted.run.requestText },
    }, null, 2) + "\n", { mode: 0o600 });
    await repository.cancel(owner, retried.run.id);
    await repository.finishCancelled(owner, retried.run.id, { cleanupState: "confirmed", summary: "隔离夹具已结束。" });
    await models.releaseForRun(owner, retried.run.credentialLeaseId);
  }, 60_000);

  function controlDisposablePostgres(action: "stop" | "start") {
    const url = new URL(process.env.DATABASE_URL ?? "");
    const directory = process.env.PIVLOOM_RC03_PGDATA ?? "";
    const ctl = process.env.PIVLOOM_RC03_PG_CTL ?? "";
    if (process.env.PIVLOOM_RC03_DB_OUTAGE !== "1" || process.env.PIVLOOM_ENVIRONMENT_ID !== "rc03-local-fault-e2e"
      || url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/pivloom_executor_test_rc03"
      || !directory.endsWith("/.cache/rc03-fault-e2e/pgdata") || !ctl.endsWith("/pg_ctl"))
      throw Error("Refusing to control any database other than the explicit disposable RC03 local PostgreSQL");
    const args = action === "stop" ? ["-D", directory, "-m", "fast", "stop"]
      : ["-D", directory, "-o", "-p 55439 -h 127.0.0.1", "-l", resolve(directory, "../postgres.log"), "start"];
    execFileSync(ctl, args, { stdio: "ignore", timeout: 30_000 });
  }

  test.skipIf(process.env.PIVLOOM_RC03_DB_OUTAGE !== "1")(
    "a real local PostgreSQL outage retains a failed terminal transition until the service returns", async () => {
      let stopped = false;
      let markStopped!: () => void;
      const outageStarted = new Promise<void>((resolve) => { markStopped = resolve; });
      const remote = await fixture("model-fails", { settlementRetryMs: 50, observeTerminalWrites: true,
        beforeModelFailure: async () => { controlDisposablePostgres("stop"); stopped = true; markStopped(); } });
      const project = await createProjectRepository(database).create(owner, prefix);
      projects.push(project.id);
      const accepted = await repository.accept(owner, project.id, {
        idempotencyKey: randomUUID(), text: "故障后仍能保存失败", expectedCurrentRevisionId: null,
        modelProfileId: model.id, modelConfigVersion: model.configVersion,
      });
      leases.push(accepted.run.credentialLeaseId);
      try {
        remote.executor.start(accepted.run);
        await outageStarted;
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(remote.providerRequests()).toBe(1);
        expect(remote.remotes.size).toBe(0);
        controlDisposablePostgres("start"); stopped = false;
        const by = Date.now() + 30_000;
        let settled = await repository.getRun(owner, accepted.run.id);
        while (settled.state !== "failed" && Date.now() < by) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          settled = await repository.getRun(owner, accepted.run.id);
        }
        expect(settled).toMatchObject({ state: "failed", cleanupState: "confirmed",
          error: { code: "MODEL_FAILED" } });
        expect(remote.terminalDbFailures()).toBeGreaterThanOrEqual(1);
        expect(remote.failedWrites()).toBeGreaterThanOrEqual(2);
        expect(remote.providerRequests()).toBe(1);
        expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [project.id])).rows[0].operation_id).toBeNull();
        if (process.env.PIVLOOM_RC03_EVIDENCE_FILE) {
          const row = { runId: accepted.run.id, state: settled.state, cleanupState: settled.cleanupState,
            errorCode: settled.error?.code, providerCalls: remote.providerRequests(), projectUnlocked: true,
            terminalDbFailures: remote.terminalDbFailures(), terminalWriteAttempts: remote.failedWrites(),
            outage: "actual local PostgreSQL service stopped for at least 600ms" };
          await writeFile(process.env.PIVLOOM_RC03_EVIDENCE_FILE, JSON.stringify({ failed: row }, null, 2) + "\n", { mode: 0o600 });
        }
      } finally { if (stopped) controlDisposablePostgres("start"); }
    }, 60_000);

  test.skipIf(process.env.PIVLOOM_RC03_DB_OUTAGE !== "1")(
    "a real local PostgreSQL outage retains cancellation and does not replay the Builder", async () => {
      let stopped = false;
      const remote = await fixture("cancel-builder", { settlementRetryMs: 50, cleanupSweepMs: 100,
        observeTerminalWrites: true });
      const project = await createProjectRepository(database).create(owner, prefix);
      projects.push(project.id);
      const accepted = await repository.accept(owner, project.id, {
        idempotencyKey: randomUUID(), text: "取消后仍能保存终态", expectedCurrentRevisionId: null,
        modelProfileId: model.id, modelConfigVersion: model.configVersion,
      });
      leases.push(accepted.run.credentialLeaseId);
      try {
        remote.executor.start(accepted.run);
        await remote.builderStarted;
        expect((await repository.cancel(owner, accepted.run.id)).state).toBe("cancel_requested");
        const callsAtStop = remote.providerRequests();
        controlDisposablePostgres("stop"); stopped = true;
        expect(remote.executor.cancel(accepted.run.id)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(remote.providerRequests()).toBe(callsAtStop);
        controlDisposablePostgres("start"); stopped = false;
        const recoveredAt = Date.now();
        const by = Date.now() + 30_000;
        let settled = await repository.getRun(owner, accepted.run.id);
        while ((settled.state !== "cancelled" || settled.cleanupState !== "confirmed") && Date.now() < by) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          settled = await repository.getRun(owner, accepted.run.id);
        }
        expect(settled).toMatchObject({ state: "cancelled", cleanupState: "confirmed",
          error: { code: "CANCELLED" } });
        expect(remote.terminalDbFailures()).toBeGreaterThanOrEqual(1);
        expect(remote.cancelledWrites()).toBeGreaterThanOrEqual(2);
        expect(remote.providerRequests()).toBe(callsAtStop);
        expect(Date.now() - recoveredAt).toBeLessThan(5_000);
        expect([...remote.remotes.values()].map((sandbox) => sandbox.live)).toEqual([false]);
        expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [project.id])).rows[0].operation_id).toBeNull();
        if (process.env.PIVLOOM_RC03_EVIDENCE_FILE) {
          const prior = JSON.parse(await readFile(process.env.PIVLOOM_RC03_EVIDENCE_FILE, "utf8"));
          const row = { runId: accepted.run.id, state: settled.state, cleanupState: settled.cleanupState,
            errorCode: settled.error?.code, providerCalls: remote.providerRequests(), projectUnlocked: true,
            terminalDbFailures: remote.terminalDbFailures(), terminalWriteAttempts: remote.cancelledWrites(),
            remoteFixtureDestroyed: true, cleanupConfirmationMsAfterDbRestart: Date.now() - recoveredAt,
            outage: "actual local PostgreSQL service stopped for at least 600ms" };
          await writeFile(process.env.PIVLOOM_RC03_EVIDENCE_FILE,
            JSON.stringify({ ...prior, cancelled: row }, null, 2) + "\n", { mode: 0o600 });
        }
      } finally { if (stopped) controlDisposablePostgres("start"); }
    }, 60_000);

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
