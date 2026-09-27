import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createSourceStore } from "../../src/storage/source.js";
import { REACT_TEMPLATE_VERSION } from "../../src/runtime/snapshot.js";
import { starterPlan } from "../../src/starters/catalog.js";

describe.skipIf(process.env.PIVLOOM_TEMPLATE_INTEGRATION !== "1")("curated template import", () => {
  test("creates one model-free project, survives retries, and records an accepted source baseline", async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!new URL(url).pathname.startsWith("/pivloom_executor_test_")
      || !process.env.PIVLOOM_ENVIRONMENT_ID || !process.env.PIVLOOM_EXECUTOR_OWNER_ID
      || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY) throw new Error("An isolated executor database is required");
    const admin = new Pool({ connectionString: url, max: 1 });
    const identity = (await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true")).rows[0]?.environment_id;
    if (identity !== process.env.PIVLOOM_ENVIRONMENT_ID) throw new Error("Isolated database identity mismatch");
    const database = new PivloomDatabase(url);
    const owner = process.env.PIVLOOM_EXECUTOR_OWNER_ID;
    const models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY));
    const repository = createGenerationRepository(database, models, { executorBootId: randomUUID(), maxSandboxes: 5 });
    const projects = createProjectRepository(database);
    const objects = new Map<string, Uint8Array>();
    const sources = createSourceStore({ url: "http://fixture.invalid", secret: "fixture", objects: {
      upload: async (key, body) => { objects.set(key, body); },
      download: async (key) => objects.get(key)!, list: async () => [],
    } });
    try {
      const input = { slug: "reading-list", title: "读书清单", plan: starterPlan("reading-list"), idempotencyKey: randomUUID() };
      const first = await repository.createTemplateProject(owner, input);
      expect(first.replayed).toBe(false);
      expect(first.run).toMatchObject({ kind: "template", templateSlug: "reading-list", state: "queued",
        modelProfileId: null, modelConfigVersion: null, credentialLeaseId: "" });
      const replay = await repository.createTemplateProject(owner, input);
      expect(replay.replayed).toBe(true);
      expect(replay.project.id).toBe(first.project.id);
      await expect(repository.createTemplateProject(owner, { ...input, slug: "portfolio" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      const claimed = await repository.claimNextQueuedRun(first.run.id);
      expect(claimed?.id).toBe(first.run.id);
      expect((await repository.prepareDispatch(owner, first.run.id)).outcome).toBe("ready");
      await repository.setPhase(owner, first.run.id, { state: "building", phase: "provision" });
      const revisionId = randomUUID();
      const source = await sources.save({ ownerId: owner, projectId: first.project.id, revisionId },
        REACT_TEMPLATE_VERSION, [{ path: "src/App.tsx", content: "export default function App(){return <h1>Book shelf</h1>}\n" }]);
      const build = { schemaVersion: 1, sourceHash: source.sourceHash,
        typecheck: { command: "tsc", exitCode: 0, durationMs: 1, stdoutTail: "", stderrTail: "" },
        build: { command: "vite build", exitCode: 0, durationMs: 1, stdoutTail: "", stderrTail: "" } };
      const revision = await repository.saveCandidate(owner, first.run.id, { source, buildStatus: "passed", build });
      expect(revision.templateSlug).toBe("reading-list");
      const sandboxId = `template-fixture-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      await repository.registerSandbox(owner, first.run.id, { sandboxId, expiresAt });
      await repository.bindPreview(owner, first.run.id, { sandboxId, revisionId, sourceHash: source.sourceHash,
        expiresAt, markerVerified: true, writeRevoked: true, chromeClosed: true });
      const completed = await repository.completeTemplate(owner, first.run.id, { revisionId,
        sourceHash: source.sourceHash, sandboxId, pageVerified: true });
      expect(completed).toMatchObject({ state: "completed", kind: "template", resultRevisionId: revisionId });
      expect((await projects.get(owner, first.project.id)).currentRevisionId).toBe(revisionId);
      expect((await repository.getRevision(owner, revisionId)).status).toBe("accepted");
      expect((await repository.getRun(owner, first.run.id)).plan?.behaviors).toHaveLength(5);
      await repository.markDestroyed(owner, first.run.id, sandboxId);
    } finally { await database.close(); await admin.end(); }
  }, 30_000);
});
