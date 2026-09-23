import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Pool, type PoolClient } from "pg";
import { expect, test } from "vitest";
import { GroupedPlanSchema } from "@pivloom/contracts";
import { PivloomDatabase } from "../../src/data/database.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import type { ModelProfileService } from "../../src/models/service.js";
import { createSourceStore, prepareSourceSnapshot } from "../../src/storage/source.js";
import { runReview } from "../../src/generation/review.js";
import { REACT_TEMPLATE_VERSION } from "../../src/runtime/snapshot.js";
import type { SandboxConnection } from "../../src/runtime/workspace.js";

test.skipIf(process.env.PIVLOOM_GROUPS_INTEGRATION !== "1")(
  "five service-derived blocked groups persist with the exact version and never promote current",
  async () => {
    const env = process.env;
    if (!env.PIVLOOM_ENVIRONMENT_ID || !env.DATABASE_URL || !env.MIGRATION_DATABASE_URL || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)
      throw Error("Explicit isolated integration target required");
    const identity = JSON.parse(await readFile(resolve("../../.cache/identity", env.PIVLOOM_ENVIRONMENT_ID, "manifest.json"), "utf8"));
    if (identity.environmentId !== env.PIVLOOM_ENVIRONMENT_ID) throw Error("Identity manifest mismatch");
    const ownerA = identity.users.find((user: { label: string }) => user.label === "A")?.id as string;
    const ownerB = identity.users.find((user: { label: string }) => user.label === "B")?.id as string;
    const admin = new Pool({ connectionString: env.MIGRATION_DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    const database = new PivloomDatabase(env.DATABASE_URL);
    const sources = createSourceStore({ url: env.SUPABASE_URL, secret: env.SUPABASE_SECRET_KEY });
    const title = `rc06-groups-${randomUUID()}`;
    const projectIds: string[] = [], runIds: string[] = [], leaseIds: string[] = [], sourceKeys: string[] = [];
    let evidence: Record<string, unknown> | null = null;
    const directory = resolve("../../.cache/technical-recheck");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifestPath = resolve(directory, `${title}.json`);
    const save = (cleaned = false) => writeFile(manifestPath,
      JSON.stringify({ environmentId: env.PIVLOOM_ENVIRONMENT_ID, ownerA, title, projectIds, runIds, leaseIds, sourceKeys, cleaned }, null, 2) + "\n", { mode: 0o600 });
    await save();
    try {
      const target = await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true");
      if (target.rows[0]?.environment_id !== env.PIVLOOM_ENVIRONMENT_ID) throw Error("Database target mismatch");
      const migrated = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='nano' AND table_name='checks' AND column_name='group_results_json'");
      if (migrated.rowCount !== 1) throw Error("Group migration 015 is required");
      const profile = (await admin.query("SELECT profile_id,config_version FROM nano.model_profile_versions WHERE owner_id=$1 ORDER BY config_version DESC LIMIT 1", [ownerA])).rows[0];
      if (!profile) throw Error("A fixture profile version is required; no model will be called");
      const models = {
        async freezeInTransaction(client: PoolClient, ownerId: string, profileId: string, configVersion: number, runId: string) {
          if (ownerId !== ownerA || profileId !== profile.profile_id || configVersion !== profile.config_version) throw Error("Fixture model scope mismatch");
          const leaseId = randomUUID();
          await client.query(`INSERT INTO nano.model_credential_leases(id,owner_id,profile_id,config_version,reference_id)
            VALUES($1,$2,$3,$4,$5)`, [leaseId, ownerId, profileId, configVersion, runId]);
          leaseIds.push(leaseId); await save();
          return { id: leaseId };
        },
        async releaseInTransaction(client: PoolClient, ownerId: string, leaseId: string) {
          await client.query("UPDATE nano.model_credential_leases SET released_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, leaseId]);
        },
      } as unknown as ModelProfileService;
      const repository = createGenerationRepository(database, models, { executorBootId: randomUUID() });
      const project = await createProjectRepository(database).create(ownerA, title);
      projectIds.push(project.id); await save();
      const accepted = await repository.accept(ownerA, project.id, { idempotencyKey: randomUUID(), text: "仅用于五组检查事务的诊断夹具",
        expectedCurrentRevisionId: null, modelProfileId: profile.profile_id, modelConfigVersion: profile.config_version });
      runIds.push(accepted.run.id); await save();
      const plan = GroupedPlanSchema.parse({ schemaVersion: 2, goal: "诊断夹具", changeSummary: "验证五组持久化", assumptions: [], outOfScope: [],
        behaviors: ["B01", "B02", "B03", "B04", "B05"].map((id) => ({ id, title: `检查 ${id}`,
          precondition: "页面已打开", action: `操作 ${id}`, expected: `观察 ${id}`, required: true })),
        groups: ["G1", "G2", "G3", "G4", "G5"].map((id, index) => ({ id, title: `验收组 ${index + 1}`, behaviorIds: [`B0${index + 1}`] })), replacements: [] });
      const coordinator = await repository.startCoordinator(ownerA, accepted.run.id);
      await repository.submitPlan(ownerA, accepted.run.id, { roleRunId: coordinator.id, attempt: 0, plan });
      await repository.startBuilder(ownerA, accepted.run.id);
      await repository.completeBuilder(ownerA, accepted.run.id, { summary: "Explicit build fixture; no compiler run" });
      const files = [{ path: "src/App.tsx", content: "export default function App(){return <main>fixture</main>}" }];
      const revisionId = randomUUID(), prepared = prepareSourceSnapshot(REACT_TEMPLATE_VERSION, files);
      sourceKeys.push(`${ownerA}/${project.id}/${revisionId}/${prepared.sourceHash}.json.gz`); await save();
      const source = await sources.save({ ownerId: ownerA, projectId: project.id, revisionId }, REACT_TEMPLATE_VERSION, files);
      const revision = await repository.saveCandidate(ownerA, accepted.run.id, { source, buildStatus: "passed", build: {
        schemaVersion: 1, sourceHash: source.sourceHash,
        typecheck: { command: "fixture typecheck", exitCode: 0, durationMs: 1, stdoutTail: "fixture", stderrTail: "" },
        build: { command: "fixture build", exitCode: 0, durationMs: 1, stdoutTail: "fixture", stderrTail: "" },
      } });
      const sandboxId = `rc06-fixture-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      await repository.registerSandbox(ownerA, accepted.run.id, { sandboxId, expiresAt });
      await repository.bindPreview(ownerA, accepted.run.id, { sandboxId, revisionId, sourceHash: revision.sourceHash,
        expiresAt, markerVerified: true, writeRevoked: true, chromeClosed: true });
      await repository.queueReviewer(ownerA, accepted.run.id, { revisionId });
      const execution = await repository.startReviewer(ownerA, accepted.run.id);
      const staged = new Map<string, Record<string, unknown>>();
      const connection: SandboxConnection = {
        sandboxId, kill: async () => {}, isRunning: async () => true, renew: async () => {}, close: async () => {},
        endpoint: async () => ({ url: "http://preview-fixture.invalid", headers: {} }),
        read: async () => new Uint8Array(),
        write: async (path, data) => { staged.set(path, JSON.parse(Buffer.from(data).toString())); },
        run: async (command) => {
          const path = /^node \/opt\/pivloom\/source-io\.mjs '([^']+)'$/.exec(command)?.[1];
          const request = path ? staged.get(path) : undefined;
          const stdoutTail = request?.op === "list" ? JSON.stringify({ files: files.map((file) => file.path) })
            : request?.op === "read" ? JSON.stringify({ data: Buffer.from(files.find((file) => file.path === request.path)!.content).toString("base64") })
              : JSON.stringify({ success: true, data: {} });
          return { id: randomUUID(), interrupt: async () => {}, wait: async () => ({ exitCode: 0, stdoutTail, stderrTail: "" }) };
        },
      };
      const review = await runReview({ binding: execution.scope, sessionId: execution.role.sessionId,
        handoff: execution.handoff, expiresAt, source, sources,
        artifacts: { save: async () => { throw Error("Blocked review must not save screenshots"); }, load: async () => { throw Error("No screenshots") } },
        sandboxConfig: { baseUrl: "http://sandbox-fixture.invalid", apiKey: "fixture", image: "fixture" },
        modelConfig: { provider: "fixture", id: "fixture", api: "openai-completions", baseUrl: "https://model-fixture.invalid/v1", apiKey: "fixture" },
        signal: new AbortController().signal,
        assertActive: () => repository.assertRoleActive(ownerA, accepted.run.id, { roleRunId: execution.role.id, attempt: 0, role: "reviewer" }),
      }, { sandboxConnector: { create: async () => connection, connect: async () => connection },
        previewFetch: async () => Response.json({ revisionId: randomUUID(), sourceHash: source.sourceHash }) });
      expect(review.receipt.markerVerified).toBe(false);
      expect(review.receipt.result.items).toHaveLength(5);
      const finished = await repository.finishReview(ownerA, accepted.run.id, { receipt: review.receipt });
      expect(finished.run.state).toBe("failed");
      expect(finished.check.verdict).toBe("blocked");
      expect(finished.check.groups).toHaveLength(5);
      expect(finished.check.groups?.map((group) => group.verdict)).toEqual(["blocked", "blocked", "blocked", "blocked", "blocked"]);
      expect((await repository.getRunCheck(ownerA, accepted.run.id))?.groups?.map((group) => group.behaviorIds)).toEqual([
        ["B01"], ["B02"], ["B03"], ["B04"], ["B05"],
      ]);
      expect((await createProjectRepository(database).get(ownerA, project.id)).currentRevisionId).toBeNull();
      await expect(repository.getCheck(ownerB, finished.check.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      const stored = await admin.query("SELECT group_results_json FROM nano.checks WHERE id=$1 AND project_id=$2", [finished.check.id, project.id]);
      expect(stored.rows[0].group_results_json).toHaveLength(5);
      evidence = { environmentId: env.PIVLOOM_ENVIRONMENT_ID, at: new Date().toISOString(),
        fixture: "isolated PostgreSQL + private Storage; model/build/browser/sandbox responses were explicit fixtures",
        projectId: project.id, runId: accepted.run.id, revisionId, sourceHash: revision.sourceHash,
        modelCalls: 0, realSandboxCreated: false, currentRevisionId: null, check: finished.check,
        databaseGroups: stored.rows[0].group_results_json };
    } finally {
      if (projectIds.length) {
        const found = await admin.query("SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3", [projectIds, ownerA, title]);
        if (found.rowCount !== projectIds.length) throw Error("Refusing cleanup outside group fixture");
        const client = await admin.connect();
        try {
          await client.query("BEGIN"); await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query("UPDATE nano.projects SET current_revision_id=NULL,operation_id=NULL,operation_kind=NULL WHERE id=ANY($1::uuid[])", [projectIds]);
          for (const table of ["checks", "run_events", "messages", "sandboxes", "role_runs", "revisions", "runs"])
            await client.query(`DELETE FROM nano.${table} WHERE project_id=ANY($1::uuid[])`, [projectIds]);
          await client.query("DELETE FROM nano.model_credential_leases WHERE owner_id=$1 AND id=ANY($2::uuid[])", [ownerA, leaseIds]);
          await client.query("DELETE FROM nano.projects WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND title=$3", [projectIds, ownerA, title]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      }
      await database.close();
      if (sourceKeys.length) {
        if (!sourceKeys.every((key) => projectIds.some((id) => key.startsWith(`${ownerA}/${id}/`)))) throw Error("Source cleanup scope mismatch");
        const removed = await createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
          .storage.from("pivloom-private").remove(sourceKeys);
        if (removed.error) throw Error("Exact source cleanup failed");
        const remaining = (await Promise.all(projectIds.map((id) => sources.listObjects(ownerA, id)))).flat();
        expect(remaining.filter((object) => sourceKeys.includes(object.key))).toEqual([]);
      }
      if (projectIds.length) {
        const remaining = await admin.query(`SELECT
          (SELECT count(*)::int FROM nano.projects WHERE id=ANY($1::uuid[])) AS projects,
          (SELECT count(*)::int FROM nano.runs WHERE id=ANY($2::uuid[])) AS runs,
          (SELECT count(*)::int FROM nano.model_credential_leases WHERE id=ANY($3::uuid[])) AS leases`,
        [projectIds, runIds, leaseIds]);
        expect(remaining.rows[0]).toEqual({ projects: 0, runs: 0, leases: 0 });
      }
      if (evidence) await writeFile(resolve("../../artifacts/technical-recheck-2026-09-23/rc06-groups-isolated.json"),
        JSON.stringify({ ...evidence, cleanup: { projects: 0, runs: 0, leases: 0, sourceObjects: 0 } }, null, 2) + "\n");
      await save(true);
      await admin.end();
    }
  }, 120_000,
);
