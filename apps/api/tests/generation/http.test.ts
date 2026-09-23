import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { PivloomDatabase } from "../../src/data/database.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";
import {
  createSourceStore,
  prepareSourceSnapshot,
} from "../../src/storage/source.js";
import {
  CreateProjectResponseSchema,
  CreateRunResponseSchema,
  ProjectDetailResponseSchema,
  RunDetailResponseSchema,
  TerminalRunStates,
} from "@pivloom/contracts";

describe("anonymous generation HTTP boundaries", () => {
  let app: FastifyInstance;
  const outboundRequests: string[] = [];
  let databaseConnections = 0;
  const upstream = createServer((request, response) => {
    outboundRequests.push(`${request.method} ${request.url}`);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end('{"error":"external boundary must not be reached"}');
  });
  const postgres = createTcpServer((socket) => {
    databaseConnections++;
    socket.destroy();
  });
  const projectId = randomUUID(),
    runId = randomUUID(),
    revisionId = randomUUID();

  beforeAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => postgres.listen(0, "127.0.0.1", resolve)),
    ]);
    const httpAddress = upstream.address(),
      databaseAddress = postgres.address();
    if (
      !httpAddress ||
      typeof httpAddress === "string" ||
      !databaseAddress ||
      typeof databaseAddress === "string"
    )
      throw new Error("External fixture listeners unavailable");
    const externalOrigin = `http://127.0.0.1:${httpAddress.port}`;
    app = createApp({
      logger: false,
      env: {
        APP_ORIGIN: "http://localhost:45231",
        SUPABASE_URL: externalOrigin,
        SUPABASE_SECRET_KEY: "fixture-auth-secret-never-real",
        DATABASE_URL: `postgresql://fixture:fixture@127.0.0.1:${databaseAddress.port}/fixture`,
        MODEL_CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        OPENSANDBOX_BASE_URL: externalOrigin,
        OPENSANDBOX_API_KEY: "fixture-sandbox-secret-never-real",
        OPENSANDBOX_IMAGE: "fixture-must-not-be-created",
        PREVIEW_BASE_URL: "http://localhost:45311",
      },
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    upstream.closeAllConnections();
    await Promise.all(
      [upstream, postgres].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  // Real app and route/auth code, external HTTP/TCP traps only. No repository,
  // executor or model implementation is mocked, and no paid network is reached.
  test.each([
    {
      method: "POST" as const,
      url: `/api/v1/projects/${projectId}/runs`,
      payload: {
        text: "生成读书清单",
        expectedCurrentRevisionId: null,
        modelProfileId: randomUUID(),
        modelConfigVersion: 1,
      },
    },
    { method: "GET" as const, url: `/api/v1/runs/${runId}` },
    { method: "GET" as const, url: `/api/v1/runs/${runId}/events` },
    { method: "GET" as const, url: `/api/v1/revisions/${revisionId}/files` },
    { method: "GET" as const, url: `/api/v1/projects/${projectId}/revisions` },
    { method: "GET" as const, url: `/api/v1/projects/${projectId}/revisions/diff?from=${revisionId}&to=${runId}` },
    {
      method: "GET" as const,
      url: `/api/v1/revisions/${revisionId}/file?path=src%2FApp.tsx`,
    },
    {
      method: "GET" as const,
      url: `/api/v1/projects/${projectId}/preview?revisionId=${revisionId}`,
    },
  ])(
    "$method $url refuses missing identity before external side effects",
    async (request) => {
      const response = await app.inject({
        ...request,
        headers: { "idempotency-key": randomUUID() },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "UNAUTHENTICATED" },
      });
      expect(response.body).not.toContain("fixture-auth-secret-never-real");
      expect(response.body).not.toContain("fixture-sandbox-secret-never-real");
      expect(outboundRequests).toEqual([]);
      expect(databaseConnections).toBe(0);
    },
  );
});

interface IdentityManifest {
  environmentId: string;
  users: Array<{ label: string; id: string; email: string; password: string }>;
}

// Explicit opt-in; normal unit runs neither connect to the shared environment
// nor claim an Auth/Postgres/Storage pass. Fixture records are terminal failures,
// never accepted/executed generations or claims of a real model/build result.
describe.skipIf(process.env.PIVLOOM_GENERATION_HTTP_INTEGRATION !== "1")(
  "real generation Auth/Postgres/Storage HTTP boundaries",
  () => {
    const prefix = `generation-http-${randomUUID()}`;
    const runId = randomUUID(),
      revisionId = randomUUID(),
      roleId = randomUUID();
    const privateSource = `HTTP boundary fixture ${prefix}; never generated or compiled`;
    const projectIds: string[] = [],
      sourceKeys: string[] = [];
    const observations: Array<{
      label: string;
      actor: "A" | "B";
      status: number | null;
      elapsedMs: number;
      error?: string;
    }> = [];
    let cleanupCounts:
      | { projects: number; runs: number; leases: number; objects: number }
      | undefined;
    let app: FastifyInstance | undefined;
    let database: PivloomDatabase | undefined;
    let admin: Pool | undefined;
    let models: ReturnType<typeof createModelProfileService> | undefined;
    let ownerA: string, ownerB: string, tokenA: string, tokenB: string;
    let origin: string,
      artifactPath: string | undefined,
      leaseId: string | undefined;
    let bootId: string | undefined;
    let modelId: string, modelVersion: number, sourceHash: string;
    let sandboxRequests = 0;
    const sandboxTrap = createServer((_request, response) => {
      sandboxRequests++;
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end('{"error":"HTTP boundary tests never provision a sandbox"}');
    });

    async function record(status: "prepared" | "running" | "cleaned") {
      if (!artifactPath) return;
      await writeFile(
        artifactPath,
        JSON.stringify(
          {
            prefix,
            runId,
            revisionId,
            projectIds,
            sourceKeys,
            ownerA,
            ownerB,
            node: process.version,
            apiOrigin: origin,
            apiBootId: bootId,
            build: process.env.PIVLOOM_BUILD_ID ?? "working-tree",
            at: new Date().toISOString(),
            status,
            observations,
            fixture:
              "terminal failure records and text snapshot; no model, build, or sandbox execution",
            sandboxRequests,
            cleanupCounts,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    }
    async function api(path: string, token: string, init: RequestInit = {}) {
      const started = Date.now();
      const label = `${init.method ?? "GET"} ${path}`;
      const actor = token === tokenA ? ("A" as const) : ("B" as const);
      try {
        const response = await fetch(`${origin}/api/v1${path}`, {
          ...init,
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
        });
        observations.push({
          label,
          actor,
          status: response.status,
          elapsedMs: Date.now() - started,
        });
        return response;
      } catch (error) {
        observations.push({
          label,
          actor,
          status: null,
          elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.name : "HTTP_ERROR",
        });
        throw error;
      }
    }

    beforeAll(async () => {
      const env = process.env;
      const environmentId = env.PIVLOOM_ENVIRONMENT_ID;
      if (
        !environmentId ||
        !env.DATABASE_URL ||
        !env.MIGRATION_DATABASE_URL ||
        !env.SUPABASE_URL ||
        !env.SUPABASE_PUBLISHABLE_KEY ||
        !env.SUPABASE_SECRET_KEY ||
        !env.MODEL_CREDENTIALS_ENCRYPTION_KEY
      )
        throw new Error("Explicit HTTP integration target is required");
      const identity: IdentityManifest = JSON.parse(
        await readFile(
          resolve("../../.cache/identity", environmentId, "manifest.json"),
          "utf8",
        ),
      );
      if (identity.environmentId !== environmentId)
        throw new Error("Identity target mismatch");
      const a = identity.users.find((user) => user.label === "A"),
        b = identity.users.find((user) => user.label === "B");
      if (!a || !b) throw new Error("Prepared A/B identities are required");
      ownerA = a.id;
      ownerB = b.id;
      admin = new Pool({
        connectionString: env.MIGRATION_DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5_000,
      });
      const target = await admin.query(
        "SELECT environment_id FROM nano.environment_identity WHERE id=true",
      );
      if (target.rows[0]?.environment_id !== environmentId)
        throw new Error("Database target mismatch");
      const signIn = async (identity: IdentityManifest["users"][number]) => {
        const client = createClient(
          env.SUPABASE_URL!,
          env.SUPABASE_PUBLISHABLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );
        const result = await client.auth.signInWithPassword({
          email: identity.email,
          password: identity.password,
        });
        if (result.error || !result.data.session)
          throw new Error(`HTTP test identity ${identity.label} login failed`);
        return result.data.session.access_token;
      };
      tokenA = await signIn(a);
      tokenB = await signIn(b);
      database = new PivloomDatabase(env.DATABASE_URL);
      models = createModelProfileService(
        database,
        createCredentialVault(env.MODEL_CREDENTIALS_ENCRYPTION_KEY),
      );
      const profile = (await models.list(ownerA)).find(
        (item) =>
          item.isDefault &&
          item.capabilities.streaming === "verified" &&
          item.capabilities.tools === "verified",
      );
      if (!profile)
        throw new Error(
          "A genuinely verified default profile is required; no capability fixture is substituted",
        );
      modelId = profile.id;
      modelVersion = profile.configVersion;
      const directory = resolve("../../.cache/generation-http", environmentId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      artifactPath = resolve(directory, `${prefix}.json`);
      await record("prepared");
      for (let i = 0; i < 2; i++) {
        const project = await createProjectRepository(database).create(
          ownerA,
          prefix,
        );
        projectIds.push(project.id);
        await record("prepared");
      }
      const lease = await models.freezeForRun(
        ownerA,
        modelId,
        modelVersion,
        runId,
      );
      leaseId = lease.id;
      const files = [{ path: "README.md", content: privateSource }];
      const prepared = prepareSourceSnapshot("http-boundary-fixture-v1", files);
      sourceHash = prepared.sourceHash;
      sourceKeys.push(
        `${ownerA}/${projectIds[0]}/${revisionId}/${sourceHash}.json.gz`,
      );
      await record("prepared");
      const source = await createSourceStore({
        url: env.SUPABASE_URL,
        secret: env.SUPABASE_SECRET_KEY,
      }).save(
        { ownerId: ownerA, projectId: projectIds[0], revisionId },
        "http-boundary-fixture-v1",
        files,
      );
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO nano.runs
        (id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,model_profile_id,model_config_version,
         credential_lease_id,builder_role_run_id,state,phase,cleanup_state,error_code,error_message,error_retryable,
         budget_json,deadline_at,executor_boot_id,finished_at,result_revision_id)
        VALUES ($1,$2,$3,$4,$5,$6,'generate',$7,$8,$9,$10,'failed','cleanup','confirmed','HTTP_FIXTURE',
          'Fixture record only; no generation was executed',false,'{}',now(),$11,now(),$12)`,
          [
            runId,
            ownerA,
            projectIds[0],
            randomUUID(),
            createHash("sha256").update(prefix).digest("hex"),
            prefix,
            modelId,
            modelVersion,
            leaseId,
            roleId,
            randomUUID(),
            revisionId,
          ],
        );
        await client.query(
          `INSERT INTO nano.role_runs (id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json,finished_at)
        VALUES ($1,$2,$3,$4,'builder',0,$5,'failed','{"httpFixture":true}',now())`,
          [roleId, ownerA, projectIds[0], runId, randomUUID()],
        );
        await client.query(
          `INSERT INTO nano.revisions
        (id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,template_version,manifest_json,
         source_bytes,compressed_bytes,build_status,build_json,status)
        VALUES ($1,$2,$3,$4,1,0,$5,$6,$7,$8,$9,$10,'failed','{"httpFixture":true,"notCompiled":true}','candidate')`,
          [
            revisionId,
            ownerA,
            projectIds[0],
            runId,
            source.key,
            source.sourceHash,
            source.templateVersion,
            JSON.stringify(source.manifest),
            source.sourceBytes,
            source.compressedBytes,
          ],
        );
        await client.query(
          `INSERT INTO nano.run_events(owner_id,project_id,run_id,role_run_id,attempt,type,payload_json)
        VALUES($1,$2,$3,$4,0,'run.finished',$5)`,
          [
            ownerA,
            projectIds[0],
            runId,
            roleId,
            JSON.stringify({ state: "failed", httpFixture: true }),
          ],
        );
        await client.query(
          `INSERT INTO nano.messages(owner_id,project_id,run_id,kind,content,created_at)
        VALUES ($1,$2,$3,'user',$4,now()),($1,$2,$3,'result','HTTP fixture result; no generation was executed',now()+interval '1 millisecond')`,
          [ownerA, projectIds[0], runId, prefix],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await models.releaseForRun(ownerA, leaseId);
      await new Promise<void>((resolve) =>
        sandboxTrap.listen(0, "127.0.0.1", resolve),
      );
      const address = sandboxTrap.address();
      if (!address || typeof address === "string")
        throw new Error("Sandbox trap unavailable");
      app = createApp({
        logger: false,
        env: {
          ...env,
          OPENSANDBOX_BASE_URL: `http://127.0.0.1:${address.port}`,
          OPENSANDBOX_API_KEY: "http-fixture-no-sandbox",
        },
      });
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const health = await fetch(`${origin}/api/v1/health/live`, {
        signal: AbortSignal.timeout(5_000),
      });
      const healthBody = (await health.json()) as { bootId?: string };
      bootId = healthBody.bootId;
      if (!health.ok || !bootId)
        throw new Error("HTTP integration API boot identity unavailable");
      await record("running");
    }, 90_000);

    afterAll(async () => {
      if (app) await app.close();
      if (models && leaseId) await models.releaseForRun(ownerA, leaseId);
      if (admin && projectIds.length) {
        const found = await admin.query(
          "SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3",
          [projectIds, ownerA, prefix],
        );
        if (found.rowCount !== projectIds.length)
          throw new Error("Refusing HTTP fixture cleanup: ownership mismatch");
        const client = await admin.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query(
            "UPDATE nano.runs SET result_revision_id=NULL WHERE id=$1 AND owner_id=$2",
            [runId, ownerA],
          );
          for (const table of [
            "run_events",
            "messages",
            "sandboxes",
            "role_runs",
            "revisions",
            "runs",
          ])
            await client.query(
              `DELETE FROM nano.${table} WHERE project_id=ANY($1::uuid[]) AND owner_id=$2`,
              [projectIds, ownerA],
            );
          await client.query(
            "DELETE FROM nano.model_credential_leases WHERE reference_id=$1 AND owner_id=$2",
            [runId, ownerA],
          );
          await client.query(
            "DELETE FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3",
            [projectIds, ownerA, prefix],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
      if (sourceKeys.length) {
        if (
          !sourceKeys.every((key) =>
            projectIds.some((projectId) =>
              key.startsWith(`${ownerA}/${projectId}/`),
            ),
          )
        )
          throw new Error("Refusing object cleanup outside HTTP fixture scope");
        const removed = await createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SECRET_KEY!,
          { auth: { persistSession: false } },
        )
          .storage.from("pivloom-private")
          .remove(sourceKeys);
        if (removed.error)
          throw new Error("Exact HTTP fixture object cleanup failed");
      }
      if (admin && projectIds.length) {
        const remaining = await admin.query(
          `SELECT
        (SELECT count(*) FROM nano.projects WHERE id=ANY($1::uuid[])) AS projects,
        (SELECT count(*) FROM nano.runs WHERE project_id=ANY($1::uuid[])) AS runs,
        (SELECT count(*) FROM nano.model_credential_leases WHERE reference_id=$2) AS leases`,
          [projectIds, runId],
        );
        const objects = createSourceStore({
          url: process.env.SUPABASE_URL!,
          secret: process.env.SUPABASE_SECRET_KEY!,
        });
        const remainingObjects = (
          await Promise.all(
            projectIds.map((projectId) =>
              objects.listObjects(ownerA, projectId),
            ),
          )
        ).flat();
        cleanupCounts = {
          projects: Number(remaining.rows[0].projects),
          runs: Number(remaining.rows[0].runs),
          leases: Number(remaining.rows[0].leases),
          objects: remainingObjects.length,
        };
        expect(cleanupCounts).toEqual({
          projects: 0,
          runs: 0,
          leases: 0,
          objects: 0,
        });
      }
      if (database) await database.close();
      if (admin) await admin.end();
      if (sandboxTrap.listening) {
        sandboxTrap.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          sandboxTrap.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await record("cleaned");
    }, 90_000);

    test("owner A reads the exact failed diagnostic source and a terminal SSE event without private execution fields", async () => {
      const run = await api(`/runs/${runId}`, tokenA);
      expect(run.status).toBe(200);
      const detail = await run.json();
      expect(detail).toMatchObject({
        run: { id: runId, state: "failed", resultRevisionId: revisionId },
      });
      for (const field of [
        "ownerId",
        "credentialLeaseId",
        "executorBootId",
        "builderRoleRunId",
      ])
        expect(detail.run).not.toHaveProperty(field);
      const project = await api(`/projects/${projectIds[0]}`, tokenA);
      expect(project.status).toBe(200);
      expect(await project.json()).toMatchObject({
        project: { id: projectIds[0], currentRevisionId: null },
        latestRun: { id: runId, resultRevisionId: revisionId, state: "failed" },
        latestCandidate: { id: revisionId, runId, buildStatus: "failed" },
        currentRevision: null,
        activeRun: null,
        messages: [
          { kind: "user", runId, content: prefix },
          {
            kind: "result",
            runId,
            content: "HTTP fixture result; no generation was executed",
          },
        ],
      });
      const history = await api(`/projects/${projectIds[0]}/revisions`, tokenA);
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({
        projectId: projectIds[0], currentRevisionId: null,
        revisions: [{ id: revisionId, runId, revisionNo: 1, status: "candidate", sourceHash }],
      });
      const sameVersionDiff = await api(
        `/projects/${projectIds[0]}/revisions/diff?from=${revisionId}&to=${revisionId}`, tokenA,
      );
      expect(sameVersionDiff.status).toBe(200);
      expect(await sameVersionDiff.json()).toMatchObject({
        fromRevision: { id: revisionId, manifest: [{ path: "README.md" }] },
        toRevision: { id: revisionId, manifest: [{ path: "README.md" }] },
        unchangedCount: 1, changes: [],
      });
      const files = await api(`/revisions/${revisionId}/files`, tokenA);
      expect(files.status).toBe(200);
      expect(await files.json()).toMatchObject({
        revisionId,
        sourceHash,
        files: [
          {
            path: "README.md",
            bytes: Buffer.byteLength(privateSource),
            sha256: createHash("sha256").update(privateSource).digest("hex"),
          },
        ],
      });
      const file = await api(
        `/revisions/${revisionId}/file?path=README.md`,
        tokenA,
      );
      expect(file.status).toBe(200);
      expect(await file.json()).toMatchObject({
        revisionId,
        path: "README.md",
        content: privateSource,
      });
      const events = await api(`/runs/${runId}/events`, tokenA);
      expect(events.status).toBe(200);
      expect(events.headers.get("content-type")).toContain("text/event-stream");
      const reader = events.body!.getReader();
      let text = "";
      try {
        while (
          !(
            text.includes("run.finished") &&
            text.includes(runId) &&
            text.includes("\n\n")
          )
        ) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += new TextDecoder().decode(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      expect(text).toContain("run.finished");
      expect(text).toContain(runId);
      expect(sandboxRequests).toBe(0);
    }, 45_000);

    test("B cannot read A's run, events, files or preview and a different project cannot borrow its revision", async () => {
      for (const path of [
        `/runs/${runId}`,
        `/runs/${runId}/events`,
        `/revisions/${revisionId}/files`,
        `/revisions/${revisionId}/file?path=README.md`,
        `/projects/${projectIds[0]}/revisions`,
        `/projects/${projectIds[0]}/revisions/diff?from=${revisionId}&to=${revisionId}`,
        `/projects/${projectIds[0]}/preview?revisionId=${revisionId}`,
      ]) {
        const response = await api(path, tokenB);
        expect(response.status, path).toBe(404);
        const body = await response.text();
        expect(body).not.toContain(privateSource);
        expect(body).not.toContain(sourceKeys[0]);
      }
      const misplaced = await api(
        `/projects/${projectIds[1]}/preview?revisionId=${revisionId}`,
        tokenA,
      );
      expect(misplaced.status).toBe(404);
      const misplacedDiff = await api(
        `/projects/${projectIds[1]}/revisions/diff?from=${revisionId}&to=${revisionId}`,
        tokenA,
      );
      expect(misplacedDiff.status).toBe(404);
      expect(sandboxRequests).toBe(0);
    }, 45_000);

    test("invalid generation requests return 422 without accepting a run or provisioning a sandbox", async () => {
      const validShape = {
        text: "创建读书清单",
        expectedCurrentRevisionId: null,
        modelProfileId: randomUUID(),
        modelConfigVersion: 1,
      };
      const cases = [
        { payload: { ...validShape, text: "   " }, key: randomUUID() },
        {
          payload: { ...validShape, text: "书".repeat(8001) },
          key: randomUUID(),
        },
        { payload: { ...validShape, ownerId: ownerB }, key: randomUUID() },
        {
          payload: { ...validShape, modelConfigVersion: 0 },
          key: randomUUID(),
        },
        { payload: validShape, key: "not-an-idempotency-uuid" },
      ];
      for (const entry of cases) {
        const response = await api(`/projects/${projectIds[1]}/runs`, tokenA, {
          method: "POST",
          headers: { "idempotency-key": entry.key },
          body: JSON.stringify(entry.payload),
        });
        expect(response.status).toBe(422);
        await response.body?.cancel();
      }
      const project = await api(`/projects/${projectIds[1]}`, tokenA);
      expect(project.status).toBe(200);
      expect(await project.json()).toMatchObject({
        messages: [],
        activeRun: null,
        currentRevision: null,
      });
      const runs = await admin!.query(
        "SELECT id FROM nano.runs WHERE project_id=$1",
        [projectIds[1]],
      );
      expect(runs.rowCount).toBe(0);
      expect(sandboxRequests).toBe(0);
    }, 45_000);
  },
);

// This opt-in uses the global generation slot. Run it only when real user runs
// are idle. Auth/Postgres and HTTP are real. An isolated non-default model
// profile points to forbidden loopback so execution fails before any model call.
describe.skipIf(process.env.PIVLOOM_GENERATION_DISCONNECT_INTEGRATION !== "1")(
  "accepted generation survives a disconnected HTTP caller",
  () => {
    const prefix = `generation-disconnect-${randomUUID()}`;
    const projectIds: string[] = [];
    const runIds: string[] = [];
    const observations: Record<string, unknown>[] = [];
    const sandboxRequests: string[] = [];
    let app: FastifyInstance | undefined;
    let admin: Pool | undefined;
    let ownerId = "",
      token = "",
      origin = "",
      artifactPath = "";
    let modelProfileId = "",
      modelConfigVersion = 0;
    let cleanupCounts:
      | { projects: number; runs: number; leases: number; modelProfiles?: number; modelCredentials?: number }
      | undefined;
    const sandboxFault = createServer((request, response) => {
      sandboxRequests.push(`${request.method} ${request.url}`);
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        '{"code":"HTTP_TEST_SANDBOX_DISABLED","message":"External fixture rejects provisioning before model execution"}',
      );
    });
    const pause = (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    async function record(status: "prepared" | "running" | "cleaned") {
      if (!artifactPath) return;
      await writeFile(
        artifactPath,
        JSON.stringify(
          {
            prefix,
            status,
            at: new Date().toISOString(),
            node: process.version,
            apiOrigin: origin,
            ownerId,
            fixtureModelProfileId: modelProfileId || null,
            projectIds,
            runIds,
            sandboxRequests,
            observations,
            cleanupCounts,
            fixture:
              "real Auth/Postgres/public HTTP; non-default fixture profile has random encrypted key and explicit fixture capability metadata; production SSRF rejects its loopback Base URL before a provider call; no real model or sandbox execution",
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    }
    async function api(path: string, init: RequestInit = {}) {
      const started = Date.now();
      const response = await fetch(`${origin}/api/v1${path}`, {
        ...init,
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
      observations.push({
        request: `${init.method ?? "GET"} ${path}`,
        status: response.status,
        elapsedMs: Date.now() - started,
      });
      return response;
    }
    async function terminal(runId: string) {
      const deadline = Date.now() + 45_000;
      for (;;) {
        const response = await api(`/runs/${runId}`);
        expect(response.status).toBe(200);
        const detail = RunDetailResponseSchema.parse(await response.json());
        if (
          TerminalRunStates.has(detail.run.state) &&
          detail.run.cleanupState !== "pending"
        )
          return detail;
        if (Date.now() >= deadline)
          throw new Error(
            "The accepted run did not reach a confirmed terminal state",
          );
        await pause(300);
      }
    }

    beforeAll(async () => {
      const env = process.env;
      const environmentId = env.PIVLOOM_ENVIRONMENT_ID;
      if (
        !environmentId ||
        !env.DATABASE_URL ||
        !env.MIGRATION_DATABASE_URL ||
        !env.SUPABASE_URL ||
        !env.SUPABASE_PUBLISHABLE_KEY ||
        !env.SUPABASE_SECRET_KEY ||
        !env.MODEL_CREDENTIALS_ENCRYPTION_KEY
      ) {
        throw new Error("Explicit disconnect integration target is required");
      }
      const manifest: IdentityManifest = JSON.parse(
        await readFile(
          resolve("../../.cache/identity", environmentId, "manifest.json"),
          "utf8",
        ),
      );
      const identity = manifest.users.find((user) => user.label === "A");
      if (manifest.environmentId !== environmentId || !identity)
        throw new Error("Prepared identity target mismatch");
      ownerId = identity.id;
      admin = new Pool({
        connectionString: env.MIGRATION_DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 5_000,
      });
      const target = await admin.query(
        "SELECT environment_id FROM nano.environment_identity WHERE id=true",
      );
      if (target.rows[0]?.environment_id !== environmentId)
        throw new Error("Database target mismatch");
      const occupied = await admin.query(
        "SELECT id FROM nano.runs WHERE state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested') OR cleanup_state='pending'",
      );
      if (occupied.rowCount)
        throw new Error(
          "The global generation slot is occupied; do not interrupt another run",
        );
      const client = createClient(
        env.SUPABASE_URL,
        env.SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      const signedIn = await client.auth.signInWithPassword({
        email: identity.email,
        password: identity.password,
      });
      if (signedIn.error || !signedIn.data.session)
        throw new Error("Disconnect test identity login failed");
      token = signedIn.data.session.access_token;
      await new Promise<void>((resolve) =>
        sandboxFault.listen(0, "127.0.0.1", resolve),
      );
      const address = sandboxFault.address();
      if (!address || typeof address === "string")
        throw new Error("Sandbox fault fixture unavailable");
      app = createApp({
        logger: false,
        env: {
          ...env,
          OPENSANDBOX_BASE_URL: `http://127.0.0.1:${address.port}`,
          OPENSANDBOX_API_KEY: "disconnect-test-no-real-sandbox",
          OPENSANDBOX_IMAGE: "fixture-never-created",
        },
      });
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const directory = resolve("../../.cache/generation-http", environmentId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      artifactPath = resolve(directory, `${prefix}.json`);
      await record("prepared");
      // This metadata is an explicit boundary fixture, never a claim that a
      // provider was verified. It cannot contact a real provider or use a user key.
      modelProfileId = randomUUID();
      modelConfigVersion = 1;
      await record("prepared");
      const encrypted = createCredentialVault(env.MODEL_CREDENTIALS_ENCRYPTION_KEY).seal(randomBytes(32).toString("base64url"), {
        ownerId, profileId: modelProfileId, version: modelConfigVersion,
      });
      await admin.query("BEGIN");
      try {
        await admin.query("INSERT INTO nano.model_profiles(id,owner_id,current_version,is_default) VALUES($1,$2,1,false)", [modelProfileId, ownerId]);
        await admin.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask,capabilities)
          VALUES($1,$2,1,$3,'openai-completions','https://127.0.0.1/v1','fixture-never-called','fixture',
            '{"streaming":"verified","tools":"verified","vision":"verified"}')`, [modelProfileId, ownerId, prefix]);
        await admin.query("INSERT INTO nano.model_credentials(profile_id,config_version,owner_id,ciphertext,nonce,auth_tag) VALUES($1,1,$2,$3,$4,$5)",
          [modelProfileId, ownerId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
      const created = await api("/projects", {
        method: "POST",
        body: JSON.stringify({ title: prefix }),
      });
      expect(created.status).toBe(201);
      projectIds.push(
        CreateProjectResponseSchema.parse(await created.json()).project.id,
      );
      await record("running");
    }, 60_000);

    afterAll(async () => {
      if (app) await app.close();
      if (admin && projectIds.length) {
        const scope = await admin.query(
          "SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3",
          [projectIds, ownerId, prefix],
        );
        if (scope.rowCount !== projectIds.length)
          throw new Error(
            "Refusing cleanup outside the exact disconnect fixture scope",
          );
        const ownedRuns = await admin.query(
          "SELECT id FROM nano.runs WHERE project_id=ANY($1::uuid[]) AND owner_id=$2",
          [projectIds, ownerId],
        );
        const ownedRunIds = ownedRuns.rows.map((row: { id: string }) => row.id);
        const client = await admin.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query(
            "UPDATE nano.runs SET result_revision_id=NULL WHERE project_id=ANY($1::uuid[]) AND owner_id=$2",
            [projectIds, ownerId],
          );
          for (const table of [
            "run_events",
            "messages",
            "sandboxes",
            "role_runs",
            "revisions",
            "runs",
          ]) {
            await client.query(
              `DELETE FROM nano.${table} WHERE project_id=ANY($1::uuid[]) AND owner_id=$2`,
              [projectIds, ownerId],
            );
          }
          await client.query(
            "DELETE FROM nano.model_credential_leases WHERE reference_id=ANY($1::uuid[]) AND owner_id=$2",
            [ownedRunIds, ownerId],
          );
          await client.query(
            "DELETE FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3",
            [projectIds, ownerId, prefix],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        const remaining = await admin.query(
          `SELECT
          (SELECT count(*) FROM nano.projects WHERE id=ANY($1::uuid[])) AS projects,
          (SELECT count(*) FROM nano.runs WHERE project_id=ANY($1::uuid[])) AS runs,
          (SELECT count(*) FROM nano.model_credential_leases WHERE reference_id=ANY($2::uuid[])) AS leases`,
          [projectIds, ownedRunIds],
        );
        cleanupCounts = {
          projects: Number(remaining.rows[0].projects),
          runs: Number(remaining.rows[0].runs),
          leases: Number(remaining.rows[0].leases),
        };
        expect(cleanupCounts).toEqual({ projects: 0, runs: 0, leases: 0 });
      }
      if (admin && modelProfileId) {
        const profileScope = await admin.query(`SELECT p.id,p.is_default,v.name FROM nano.model_profiles p
          JOIN nano.model_profile_versions v ON v.profile_id=p.id AND v.owner_id=p.owner_id AND v.config_version=p.current_version
          WHERE p.id=$1 AND p.owner_id=$2`, [modelProfileId, ownerId]);
        if (profileScope.rows.some((row) => row.name !== prefix || row.is_default)) throw Error("Refusing model cleanup outside the disconnect fixture");
        await admin.query("BEGIN");
        try {
          await admin.query("DELETE FROM nano.model_credentials WHERE profile_id=$1 AND owner_id=$2", [modelProfileId, ownerId]);
          await admin.query("DELETE FROM nano.model_profile_versions WHERE profile_id=$1 AND owner_id=$2", [modelProfileId, ownerId]);
          await admin.query("DELETE FROM nano.model_profiles WHERE id=$1 AND owner_id=$2 AND is_default=false", [modelProfileId, ownerId]);
          await admin.query("COMMIT");
        } catch (error) { await admin.query("ROLLBACK"); throw error; }
        const remaining = await admin.query(`SELECT (SELECT count(*)::int FROM nano.model_profiles WHERE id=$1) AS profiles,
          (SELECT count(*)::int FROM nano.model_credentials WHERE profile_id=$1) AS credentials`, [modelProfileId]);
        expect(remaining.rows[0]).toEqual({ profiles: 0, credentials: 0 });
        cleanupCounts = { ...cleanupCounts!, modelProfiles: 0, modelCredentials: 0 };
      }
      if (admin) await admin.end();
      if (sandboxFault.listening) {
        sandboxFault.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          sandboxFault.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await record("cleaned");
    }, 60_000);

    test("a socket closed during acceptance still executes once, replays safely and releases the generation slot", async () => {
      const projectId = projectIds[0];
      const key = randomUUID();
      const payload = {
        text: `${prefix}: execute despite disconnected submitter`,
        expectedCurrentRevisionId: null,
        modelProfileId,
        modelConfigVersion,
      };
      const body = JSON.stringify(payload);
      const locker = await admin!.connect();
      let responseReceived = false;
      let closedBeforeCommit = false;
      try {
        await locker.query("BEGIN");
        await locker.query(
          "SELECT id FROM nano.projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [projectId, ownerId],
        );
        const lockPid = Number(
          (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        const request = httpRequest(
          `${origin}/api/v1/projects/${projectId}/runs`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              "Idempotency-Key": key,
            },
          },
          (response) => {
            responseReceived = true;
            response.resume();
          },
        );
        request.on("error", () => {});
        const closed = new Promise<void>((resolve) =>
          request.once("close", resolve),
        );
        request.end(body);
        try {
          // A real PostgreSQL row lock is the external synchronization boundary:
          // observe that this HTTP request reached acceptance, then disconnect.
          const deadline = Date.now() + 8_000;
          for (;;) {
            const blocked = await admin!.query(
              "SELECT count(*) AS count FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))",
              [lockPid],
            );
            if (Number(blocked.rows[0].count) > 0) break;
            if (Date.now() > deadline)
              throw new Error(
                "HTTP acceptance did not reach the controlled project lock",
              );
            await pause(50);
          }
          request.destroy();
          await closed;
          // Ensure the server observes close before the blocked transaction resumes.
          await pause(50);
          closedBeforeCommit = true;
        } finally {
          request.destroy();
        }
        await locker.query("COMMIT");
      } catch (error) {
        await locker.query("ROLLBACK");
        throw error;
      } finally {
        locker.release();
      }
      expect(closedBeforeCommit).toBe(true);
      expect(responseReceived).toBe(false);
      observations.push({
        disconnectedBeforeAcceptanceCommit: true,
        responseReceived,
      });

      const replay = await api(`/projects/${projectId}/runs`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body,
      });
      expect(replay.status).toBe(202);
      const accepted = CreateRunResponseSchema.parse(await replay.json());
      expect(accepted.replayed).toBe(true);
      runIds.push(accepted.runId);
      await record("running");
      const finished = await terminal(accepted.runId);
      expect(finished.run).toMatchObject({
        state: "failed",
        cleanupState: "confirmed",
        resultRevisionId: null,
        error: { code: "MODEL_ENDPOINT_NOT_ALLOWED" },
      });
      expect(
        finished.events.filter((event) => event.type === "role.started"),
      ).toHaveLength(0);
      expect(finished.roles).toMatchObject([{ role: "coordinator", state: "failed", startedAt: null }]);
      expect(
        finished.events.some((event) => event.type.startsWith("tool.")),
      ).toBe(false);
      expect(sandboxRequests).toEqual([]);

      const replayFinished = await api(`/projects/${projectId}/runs`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body,
      });
      expect(replayFinished.status).toBe(202);
      expect(
        CreateRunResponseSchema.parse(await replayFinished.json()),
      ).toMatchObject({
        runId: accepted.runId,
        replayed: true,
        state: "failed",
      });
      const projectResponse = await api(`/projects/${projectId}`);
      expect(projectResponse.status).toBe(200);
      const project = ProjectDetailResponseSchema.parse(
        await projectResponse.json(),
      );
      expect(project.activeRun).toBeNull();
      expect(
        project.messages.filter((message) => message.kind === "user"),
      ).toHaveLength(1);
      expect(
        project.messages.filter((message) => message.kind === "result"),
      ).toHaveLength(1);
      expect(sandboxRequests).toHaveLength(0);

      // A fresh accepted request proves the previous task released the real
      // project operation and database-enforced global slot, without DB mocks.
      const next = await api(`/projects/${projectId}/runs`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body,
      });
      expect(next.status).toBe(202);
      const nextRun = CreateRunResponseSchema.parse(await next.json());
      expect(nextRun.replayed).toBe(false);
      expect(nextRun.runId).not.toBe(accepted.runId);
      runIds.push(nextRun.runId);
      await record("running");
      expect((await terminal(nextRun.runId)).run).toMatchObject({
        state: "failed",
        cleanupState: "confirmed",
      });
      expect(sandboxRequests).toEqual([]);
      await record("running");
    }, 120_000);
  },
);
