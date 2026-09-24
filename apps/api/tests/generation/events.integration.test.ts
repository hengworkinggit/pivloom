import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Pool, type PoolClient } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { RunEvent } from "@pivloom/contracts";
import { PivloomDatabase } from "../../src/data/database.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createGenerationRepository, type GenerationRepository } from "../../src/data/generation.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createGenerationService } from "../../src/generation/service.js";
import { registerGenerationRoutes } from "../../src/routes/generation.js";
import { createIdentityVerifier } from "../../src/auth/supabase.js";
import { readIdentityConfig } from "../../src/config/identity.js";
import { ApiFailure } from "../../src/routes/errors.js";
import type { RunEventLimits } from "../../src/generation/events.js";

// This delays the result of one real PostgreSQL SELECT, never repository code.
class EventReadBoundaryDatabase extends PivloomDatabase {
  afterEventRead?: () => Promise<void>;
  readonly queryTimings: { operation: string; durationMs: number }[] = [];
  override owned<T>(ownerId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return super.owned(ownerId, (client) => operation(new Proxy(client, {
      get: (target, property) => property === "query" ? async (...args: unknown[]) => {
        const started = performance.now();
        let result;
        try { result = await Reflect.apply(target.query, target, args); }
        finally {
          this.queryTimings.push({
            operation: typeof args[0] === "string" && args[0].includes("AS events_json") ? "run_snapshot" : typeof args[0] === "string" ? args[0].trim().split(/\s/, 1)[0] : "query",
            durationMs: Math.round(performance.now() - started),
          });
        }
        if (typeof args[0] === "string" && /^SELECT/i.test(args[0]) && args[0].includes("nano.run_events") && this.afterEventRead) {
          const boundary = this.afterEventRead;
          this.afterEventRead = undefined;
          await boundary();
        }
        return result;
      } : Reflect.get(target, property, target),
    })));
  }
}

describe.skipIf(process.env.PIVLOOM_EVENTS_INTEGRATION !== "1")("durable generation events with real Postgres", () => {
  let database: EventReadBoundaryDatabase;
  let admin: Pool;
  let models: ReturnType<typeof createModelProfileService>;
  let ownerId: string;
  let profile: { id: string; configVersion: number };
  let manifestPath: string;
  const prefix = `events-fixture-${randomUUID()}`;
  const projectIds: string[] = [];
  const runIds: string[] = [];
  const leaseIds: string[] = [];
  let cleanupVerifiedAt: string | null = null;
  let tokenA: string;
  let tokenB: string;
  /** One process boot id: a claimed task only accepts progress events from the
   *  boot that dispatched it, and every fixture service here is that same boot. */
  let bootId: string;
  let service: ReturnType<typeof createGenerationService>;
  let app: FastifyInstance;
  let origin: string;
  const authTimingsMs: number[] = [];
  const snapshotTimingsMs: number[] = [];
  const httpTimingsMs: number[] = [];

  const saveManifest = () => writeFile(manifestPath, JSON.stringify({ prefix, ownerId, projectIds, runIds, leaseIds, cleanupVerifiedAt,
    timings: { authTimingsMs, snapshotTimingsMs, httpTimingsMs, queries: database.queryTimings } }, null, 2), { mode: 0o600 });
  beforeAll(async () => {
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environmentId || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY) throw Error("Explicit integration target required");
    const identity = JSON.parse(await readFile(resolve("../../.cache/identity", environmentId, "manifest.json"), "utf8"));
    if (identity.environmentId !== environmentId) throw Error("Identity manifest mismatch");
    ownerId = identity.users.find((user: { label: string }) => user.label === "A").id;
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
    const target = await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true");
    if (target.rows[0]?.environment_id !== environmentId) throw Error("Database target mismatch");
    database = new EventReadBoundaryDatabase(process.env.DATABASE_URL);
    models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY));
    const verified = (await models.list(ownerId)).find((model) => model.isDefault && model.capabilities.streaming === "verified" && model.capabilities.tools === "verified" && model.capabilities.vision === "verified");
    if (!verified) throw Error("A verified default profile is required; fixtures never change model configuration");
    profile = verified;
    const directory = resolve("../../.cache/events", environmentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    manifestPath = resolve(directory, `${prefix}.json`);
    await saveManifest();
    const configuration = readIdentityConfig(process.env);
    if (!configuration.ready) throw Error("Real Auth configuration required");
    const auth = createClient(configuration.value.supabaseUrl, configuration.value.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth;
    const tokens = await Promise.all(["A", "B"].map(async (label) => {
      const credentials = identity.users.find((user: { label: string }) => user.label === label);
      const result = await auth.signInWithPassword({ email: credentials.email, password: credentials.password });
      if (!result.data.session) throw Error("Fixture identity could not authenticate");
      return result.data.session.access_token;
    }));
    [tokenA, tokenB] = tokens;
    bootId = randomUUID();
    service = createGenerationService({ database, models, identity: configuration.value, bootId, maxSandboxes: 2,
      dailyLimitByOwner: { [ownerId]: 1000 },
      previewOrigin: "http://localhost:45311", sandbox: { baseUrl: "http://127.0.0.1:1", apiKey: "never-used-fixture-sandbox-key", image: "never-create-sandbox" } });
    app = Fastify();
    app.decorateRequest("identity", null);
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiFailure ? error.statusCode : 500).send({ error: { code: error instanceof ApiFailure ? error.code : "INTERNAL_ERROR" } }));
    const verifier = createIdentityVerifier(configuration.value);
    await registerGenerationRoutes(app, { generation: service, verifyIdentity: async (request) => {
      const started = performance.now();
      try { await verifier.verify(request); }
      finally { authTimingsMs.push(Math.round(performance.now() - started)); }
    } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("HTTP fixture unavailable");
    origin = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  async function project() {
    const item = await createProjectRepository(database).create(ownerId, prefix);
    projectIds.push(item.id);
    await saveManifest();
    return item.id;
  }

  /** Claims one specific queued task exactly as the scheduler does, so this suite
   *  can drive the repository directly. Returns null when capacity or the project
   *  is busy. */
  async function claimForTest(repo: GenerationRepository, runId: string) {
    const claimed = await repo.claimNextQueuedRun(runId);
    if (!claimed) return null;
    const prepared = await repo.prepareDispatch(ownerId, claimed.id);
    if (prepared.outcome !== "ready") throw Error(`fixture task parked: ${prepared.run.error?.code ?? "unknown"}`);
    return prepared.run;
  }

  afterAll(async () => {
    await app?.close();
    await service?.close();
    if (admin && projectIds.length) {
      const found = await admin.query("SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3", [projectIds, ownerId, prefix]);
      if (found.rowCount !== projectIds.length) throw Error("Refusing cleanup outside the fixture manifest");
      const recorded = await admin.query("SELECT id,credential_lease_id FROM nano.runs WHERE owner_id=$1 AND project_id=ANY($2::uuid[])", [ownerId, projectIds]);
      runIds.push(...recorded.rows.map((run) => run.id));
      leaseIds.push(...recorded.rows.map((run) => run.credential_lease_id));
      await saveManifest();
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET operation_id=NULL,operation_kind=NULL WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.run_events WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.messages WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.role_runs WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.runs WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.model_credential_leases WHERE owner_id=$1 AND id=ANY($2::uuid[])", [ownerId, leaseIds]);
        await admin.query("DELETE FROM nano.projects WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      const remaining = await admin.query(`SELECT
        (SELECT count(*)::int FROM nano.projects WHERE id=ANY($1::uuid[])) AS projects,
        (SELECT count(*)::int FROM nano.runs WHERE id=ANY($2::uuid[])) AS runs,
        (SELECT count(*)::int FROM nano.model_credential_leases WHERE id=ANY($3::uuid[])) AS leases`, [projectIds, runIds, leaseIds]);
      expect(remaining.rows[0]).toEqual({ projects: 0, runs: 0, leases: 0 });
      cleanupVerifiedAt = new Date().toISOString();
      await saveManifest();
    }
    await database?.close();
    await admin?.end();
  }, 30_000);

  test("accepted, phase and terminal notifications are visible only after commit and do not await subscribers", async () => {
    const observed: RunEvent[] = [];
    const durableReads: Promise<RunEvent[]>[] = [];
    const publish = (owner: string, event: RunEvent) => {
      expect(owner).toBe(ownerId);
      observed.push(event);
      durableReads.push(generation.listEvents(owner, event.runId));
      // An ordinary subscriber cannot hold a committed state transition hostage.
      return new Promise<void>(() => {});
    };
    const generation = createGenerationRepository(database, models, { executorBootId: randomUUID(),
      maxSandboxes: 5, dailyLimitByOwner: { [ownerId]: 1000 }, onCommittedEvent: publish });
    const accepted = await generation.accept(ownerId, await project(), {
      text: "durable event boundary", expectedCurrentRevisionId: null, idempotencyKey: randomUUID(),
      modelProfileId: profile.id, modelConfigVersion: profile.configVersion,
    });
    expect(observed.map((event) => event.type)).toEqual(["run.accepted"]);
    // Admission is durable but not dispatched; only a claim turns the task into a
    // run whose executor may append committed progress.
    expect(accepted.run.state).toBe("queued");
    const claimed = await claimForTest(generation, accepted.run.id);
    expect(claimed).toMatchObject({ id: accepted.run.id, state: "accepted" });
    // The payload alone fits 16 KiB, but the complete durable envelope does not.
    await expect(generation.appendEvent(ownerId, accepted.run.id, { type: "tool.output", payload: { message: "x".repeat(16_250) } }))
      .rejects.toMatchObject({ code: "EVENT_TOO_LARGE" });
    expect(observed.map((event) => event.type)).toEqual(["run.accepted"]);
    const failingDatabase = {
      owned: <T>(owner: string, operation: (client: PoolClient) => Promise<T>) => database.owned(owner, async (client) => {
        await operation(client);
        throw Error("injected external commit failure");
      }),
    };
    const rolledBack = createGenerationRepository(failingDatabase, models, { executorBootId: randomUUID(), onCommittedEvent: publish });
    await expect(rolledBack.setPhase(ownerId, accepted.run.id, { state: "building", phase: "implement" })).rejects.toThrow("injected external commit failure");
    expect(observed.map((event) => event.type)).toEqual(["run.accepted"]);
    await generation.setPhase(ownerId, accepted.run.id, { state: "building", phase: "implement" });
    await generation.finishFailed(ownerId, accepted.run.id, { code: "FIXTURE_COMPLETE", message: "No model or sandbox was called", retryable: false, cleanupState: "confirmed" });
    expect(observed.map((event) => event.type)).toEqual(["run.accepted", "run.phase", "run.finished"]);
    const durable = await Promise.all(durableReads);
    observed.forEach((event, index) => expect(durable[index].some((saved) => saved.eventId === event.eventId)).toBe(true));
    // The queue claim writes one extra durable run.accepted event through the
    // dispatch connection. It is never published to this hub, so the published
    // stream is exactly the durable stream without it, in the same order, with no
    // duplicate and no trace of the rolled-back transaction.
    const stored = await generation.listEvents(ownerId, accepted.run.id);
    expect(stored.map((event) => event.type)).toEqual(["run.accepted", "run.accepted", "run.phase", "run.finished"]);
    expect(stored.filter((event) => event.payload.dispatched !== true).map((event) => event.eventId)).toEqual(observed.map((event) => event.eventId));
  }, 60_000);

  test("a terminal commit during the history handoff is delivered once and a reconnect resumes its durable cursor", async () => {
    const accepted = await service.repository.accept(ownerId, await project(), {
      text: "history handoff fixture", expectedCurrentRevisionId: null, idempotencyKey: randomUUID(),
      modelProfileId: profile.id, modelConfigVersion: profile.configVersion,
    });
    const [initial] = await service.repository.listEvents(ownerId, accepted.run.id);
    let releaseRead!: () => void;
    let reachedRead!: () => void;
    const released = new Promise<void>((resolve) => { releaseRead = resolve; });
    const reached = new Promise<void>((resolve) => { reachedRead = resolve; });
    database.afterEventRead = async () => { reachedRead(); await released; };
    const responsePromise = fetch(`${origin}/api/v1/runs/${accepted.run.id}/events?after=${initial.eventId}`, {
      headers: { Authorization: `Bearer ${tokenA}` }, signal: AbortSignal.timeout(30_000),
    });
    await reached;
    try {
      // The terminal write must not wait for the stream: a queued task with no
      // remote work settles immediately and durably.
      const cancelled = await service.repository.cancel(ownerId, accepted.run.id);
      expect(cancelled).toMatchObject({ state: "cancelled", cleanupState: "confirmed" });
    } finally { releaseRead(); }
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as RunEvent);
    expect(events.map((event) => event.type)).toEqual(["run.finished"]);
    const reconnect = await fetch(`${origin}/api/v1/runs/${accepted.run.id}/events?after=${events[0].eventId}`, {
      headers: { Authorization: `Bearer ${tokenA}` }, signal: AbortSignal.timeout(15_000),
    });
    expect(await reconnect.text()).not.toContain("data:");
    const forbidden = await fetch(`${origin}/api/v1/runs/${accepted.run.id}/events`, { headers: { Authorization: `Bearer ${tokenB}` }, signal: AbortSignal.timeout(15_000) });
    expect(forbidden.status).toBe(404);
  }, 60_000);

  test("bounded buffers, future cursors, heartbeat and expiry protect one live run without cancelling it", async () => {
    const accepted = await service.repository.accept(ownerId, await project(), {
      text: "SSE transport limits fixture", expectedCurrentRevisionId: null, idempotencyKey: randomUUID(),
      modelProfileId: profile.id, modelConfigVersion: profile.configVersion,
    });
    // Progress events belong to the boot that dispatched the task, so this run is
    // claimed exactly as the scheduler would claim it before any event is written.
    const claimed = await claimForTest(service.repository, accepted.run.id);
    expect(claimed).toMatchObject({ id: accepted.run.id, state: "accepted" });
    const configuration = readIdentityConfig(process.env);
    if (!configuration.ready) throw Error("Identity configuration unavailable");
    const identity = configuration.value;
    const endpoint = `/api/v1/runs/${accepted.run.id}/events`;
    const future = await fetch(`${origin}${endpoint}?after=999999999999999999`, { headers: { Authorization: `Bearer ${tokenA}` }, signal: AbortSignal.timeout(15_000) });
    expect(future.status).toBe(422);
    expect(future.headers.get("content-type")).not.toContain("text/event-stream");

    async function fixtureServer(eventLimits?: RunEventLimits, authOrigin?: string) {
      // The same boot id as the claim above: these listeners are the same process
      // with smaller stream limits, not a second executor.
      const generation = createGenerationService({ database, models, identity, bootId, maxSandboxes: 2,
        previewOrigin: "http://localhost:45311", eventLimits,
        sandbox: { baseUrl: "http://127.0.0.1:1", apiKey: "never-used-fixture-sandbox-key", image: "never-create-sandbox" } });
      const http = Fastify();
      http.decorateRequest("identity", null);
      http.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiFailure ? error.statusCode : 500).send({ error: { code: error instanceof ApiFailure ? error.code : "INTERNAL_ERROR" } }));
      await registerGenerationRoutes(http, { generation, verifyIdentity: createIdentityVerifier(authOrigin ? { ...identity, supabaseUrl: authOrigin, supabaseSecretKey: "isolated-auth-fixture-key" } : identity).verify });
      await http.listen({ host: "127.0.0.1", port: 0 });
      const address = http.server.address();
      if (!address || typeof address === "string") throw Error("Fixture listener unavailable");
      return { generation, origin: `http://127.0.0.1:${address.port}`, close: async () => { await http.close(); await generation.close(); } };
    }

    // Small limits at the isolated service configuration boundary exercise both
    // branches without creating hundreds of events or changing production limits.
    for (const eventLimits of [
      { maxBufferedEvents: 1, maxBufferedBytes: 256 * 1024 },
      { maxBufferedEvents: 128, maxBufferedBytes: 1 },
    ]) {
      const limited = await fixtureServer(eventLimits);
      let release!: () => void;
      let reached!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const read = new Promise<void>((resolve) => { reached = resolve; });
      database.afterEventRead = async () => { reached(); await held; };
      const response = fetch(`${limited.origin}${endpoint}`, { headers: { Authorization: `Bearer ${tokenA}` }, signal: AbortSignal.timeout(30_000) });
      try {
        await read;
        await limited.generation.repository.appendEvent(ownerId, accepted.run.id, { type: "tool.output", payload: { message: "first committed buffered output" } });
        if (eventLimits.maxBufferedEvents === 1) await limited.generation.repository.appendEvent(ownerId, accepted.run.id, { type: "tool.output", payload: { message: "second committed buffered output" } });
        release();
        expect((await response).status).toBe(503);
        // Overflow tears down the subscription; it does not reject later commits.
        await limited.generation.repository.appendEvent(ownerId, accepted.run.id, { type: "tool.completed", payload: { message: "committed after stream closure" } });
      } finally { release(); await limited.close(); }
    }

    // The finite-expiry Auth response is an explicit external HTTP fixture. A/B
    // ownership above used real Supabase tokens; no JWT secret is read or changed.
    const auth = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: ownerId, email: "events-fixture@example.test", aud: "authenticated", role: "authenticated", user_metadata: {} }));
    });
    await new Promise<void>((resolve) => auth.listen(0, "127.0.0.1", resolve));
    const authAddress = auth.address();
    if (!authAddress || typeof authAddress === "string") throw Error("Auth boundary unavailable");
    const expiring = await fixtureServer(undefined, `http://127.0.0.1:${authAddress.port}`);
    try {
      const head = await service.repository.readEventHead(ownerId, accepted.run.id);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const expiry = Math.floor(Date.now() / 1000) + 22;
      const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: ownerId, exp: expiry })}.fixture`;
      const started = Date.now();
      const response = await fetch(`${expiring.origin}${endpoint}?after=${head.eventId}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(28_000) });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(await response.text()).toContain(": heartbeat\n\n");
      expect(Date.now() - started).toBeGreaterThanOrEqual(15_000);
      expect(Date.now()).toBeLessThan(expiry * 1000 + 1000);
      // The claimed run keeps its dispatch state across a heartbeat stream and an
      // aborted one: reading events never cancels or settles the task.
      expect((await service.repository.getRun(ownerId, accepted.run.id)).state).toBe("accepted");
      const departed = new AbortController();
      const connection = await fetch(`${origin}${endpoint}?after=${head.eventId}`, { headers: { Authorization: `Bearer ${tokenA}` }, signal: departed.signal });
      expect(connection.status).toBe(200);
      departed.abort();
      expect((await service.repository.getRun(ownerId, accepted.run.id)).state).toBe("accepted");
    } finally {
      await expiring.close();
      auth.closeAllConnections();
      await new Promise<void>((resolve, reject) => auth.close((error) => error ? reject(error) : resolve()));
    }
    await service.repository.finishFailed(ownerId, accepted.run.id, { code: "FIXTURE_COMPLETE", message: "Only durable HTTP event transport was exercised", retryable: false, cleanupState: "confirmed" });
    const durable = await service.repository.listEvents(ownerId, accepted.run.id);
    const replay = await fetch(`${origin}${endpoint}`, { headers: { Authorization: `Bearer ${tokenA}` }, signal: AbortSignal.timeout(15_000) });
    const replayed = (await replay.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as RunEvent);
    expect(replayed.map((event) => event.eventId)).toEqual(durable.map((event) => event.eventId));
    expect(new Set(replayed.map((event) => event.eventId)).size).toBe(replayed.length);
  }, 150_000);

  test("reopening a terminal run returns its last 200 durable events in ascending order", async () => {
    const projectId = await project(), runId = randomUUID(), roleId = randomUUID();
    // Explicit terminal database fixture: no active generation slot, model call,
    // sandbox or invented accepted execution. It exercises the public read seam.
    await database.owned(ownerId, async (client) => {
      const lease = await models.freezeInTransaction(client, ownerId, profile.id, profile.configVersion, runId);
      await client.query(`INSERT INTO nano.runs
        (id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,model_profile_id,model_config_version,
         credential_lease_id,builder_role_run_id,state,phase,cleanup_state,error_code,error_message,error_retryable,budget_json,deadline_at,executor_boot_id,finished_at)
        VALUES ($1,$2,$3,$4,$5,$6,'generate',$7,$8,$9,$10,'failed','cleanup','confirmed','HISTORY_FIXTURE',
          'Terminal read fixture; no generation was executed',false,'{}',now(),$11,now())`,
      [runId, ownerId, projectId, randomUUID(), "0".repeat(64), prefix, profile.id, profile.configVersion, lease.id, roleId, randomUUID()]);
      await client.query(`INSERT INTO nano.role_runs (id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json,finished_at)
        VALUES ($1,$2,$3,$4,'builder',0,$5,'failed','{"historyFixture":true}',now())`, [roleId, ownerId, projectId, runId, randomUUID()]);
      await client.query(`INSERT INTO nano.run_events(owner_id,project_id,run_id,role_run_id,attempt,type,payload_json)
        SELECT $1,$2,$3,$4,0,CASE WHEN ordinal=206 THEN 'run.finished' ELSE 'tool.output' END,
          jsonb_build_object('ordinal',ordinal,'message','history fixture '||ordinal)
        FROM generate_series(1,206) AS ordinal ORDER BY ordinal`, [ownerId, projectId, runId, roleId]);
    });
    const startedSnapshot = performance.now();
    const snapshot = await service.repository.readRunSnapshot(ownerId, runId);
    snapshotTimingsMs.push(Math.round(performance.now() - startedSnapshot));
    expect(snapshot.run.state).toBe("failed");
    expect(snapshot.events).toHaveLength(200);
    expect(snapshot.events[0].payload.ordinal).toBe(7);
    expect(snapshot.events.at(-1)).toMatchObject({ type: "run.finished", payload: { ordinal: 206 } });
    expect(snapshot.events.map((event) => event.payload.ordinal)).toEqual(Array.from({ length: 200 }, (_value, index) => index + 7));
    const startedHttp = performance.now();
    try {
      const response = await fetch(`${origin}/api/v1/runs/${runId}`, { headers: { Authorization: `Bearer ${tokenA}` }, signal: AbortSignal.timeout(15_000) });
      expect(response.status).toBe(200);
      const detail = await response.json();
      expect(detail.events.map((event: RunEvent) => event.eventId)).toEqual(snapshot.events.map((event) => event.eventId));
    } finally { httpTimingsMs.push(Math.round(performance.now() - startedHttp)); }
  }, 60_000);
});
