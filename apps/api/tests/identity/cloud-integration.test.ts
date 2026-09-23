import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/app.js";
import { PivloomDatabase } from "../../src/data/database.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";

interface Manifest {
  environmentId: string; prefix: string;
  users: { label: string; email: string; password: string; id: string }[];
  projects: string[];
  modelProfiles?: string[];
}

// Explicit opt-in: skipped tests are BLOCKED/NOT_RUN, never a cloud PASS.
describe.skipIf(process.env.PIVLOOM_IDENTITY_INTEGRATION !== "1")("real self-hosted Supabase HTTP/DB/Storage identity seam", () => {
  let app: FastifyInstance;
  let origin: string;
  let manifest: Manifest;
  let manifestPath: string;
  let admin: Pool;
  let tokenA: string;
  let tokenB: string;
  const created: string[] = [];

  beforeAll(async () => {
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environmentId || !process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY || !process.env.MIGRATION_DATABASE_URL) throw new Error("Missing explicit test target configuration");
    manifestPath = resolve(fileURLToPath(new URL("../../../../.cache/identity/", import.meta.url)), environmentId, "manifest.json");
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.environmentId).toBe(environmentId);
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    const target = await admin.query<{ environment_id: string }>("SELECT environment_id FROM nano.environment_identity WHERE id=true");
    expect(target.rows[0].environment_id).toBe(environmentId);
    const signin = async (label: string) => {
      const identity = manifest.users.find((user) => user.label === label)!;
      const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const result = await client.auth.signInWithPassword({ email: identity.email, password: identity.password });
      if (result.error || !result.data.session) throw new Error(`Seed identity ${label} login failed`);
      return result.data.session.access_token;
    };
    tokenA = await signin("A"); tokenB = await signin("B");
    app = createApp({ logger: false });
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
  }, 30_000);

  afterAll(async () => { if (app) await app.close(); if (admin) await admin.end(); }, 30_000);
  const api = (path: string, token: string, init: RequestInit = {}) => fetch(`${origin}/api/v1${path}`, {
    ...init, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const owner = (label: string) => manifest.users.find((user) => user.label === label)!.id;

  test("A creates two independent persistent projects and B cannot observe or claim them", async () => {
    for (const title of [`${manifest.prefix} first`, `${manifest.prefix} second`]) {
      const response = await api("/projects", tokenA, { method: "POST", body: JSON.stringify({ title }) });
      expect(response.status).toBe(201);
      const body = await response.json();
      created.push(body.project.id);
      manifest.projects.push(body.project.id);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    }
    expect(new Set(created).size).toBe(2);
    const firstPage = await (await api("/projects?limit=1", tokenA)).json();
    expect(firstPage.projects).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await (await api(`/projects?limit=1&cursor=${firstPage.nextCursor}`, tokenA)).json();
    expect(secondPage.projects[0].id).not.toBe(firstPage.projects[0].id);

    await app.close();
    app = createApp({ logger: false });
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const id of created) {
      const reopened = await api(`/projects/${id}`, tokenA);
      expect(reopened.status).toBe(200);
      expect(await reopened.json()).toMatchObject({ project: { id }, messages: [], activeRun: null, currentRevision: null, preview: null });
      const forbidden = await api(`/projects/${id}`, tokenB);
      expect(forbidden.status).toBe(404);
      expect(await forbidden.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    const otherList = await (await api("/projects", tokenB)).json();
    expect(otherList.projects.some((project: { id: string }) => created.includes(project.id))).toBe(false);
    const forged = await api("/projects", tokenB, { method: "POST", body: JSON.stringify({ title: "forged", owner_id: owner("A") }) });
    expect(forged.status).toBe(422);
  }, 60_000);

  test("private schema permissions and RLS still deny direct cross-owner reads", async () => {
    const client = await admin.connect();
    try {
      for (const role of ["anon", "authenticated"]) {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await expect(client.query("SELECT id FROM nano.projects LIMIT 1")).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK");
      }
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nano_api");
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [owner("B")]);
      const invisible = await client.query("SELECT id FROM nano.projects WHERE id = ANY($1::uuid[])", [created]);
      expect(invisible.rows).toHaveLength(0);
      await expect(client.query("INSERT INTO nano.projects (owner_id,title) VALUES ($1,'forged')", [owner("A")])).rejects.toMatchObject({ code: "42501" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  test("model configuration secrets are encrypted, versioned and isolated by owner", async () => {
    const apiKey = `fixture-${randomBytes(24).toString("hex")}`;
    const response = await api("/model-profiles", tokenA, { method: "POST", body: JSON.stringify({
      name: `${manifest.prefix} model`, provider: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", modelId: "fixture-no-network-call", apiKey, isDefault: false,
    }) });
    expect(response.status).toBe(201);
    const { profile } = await response.json();
    manifest.modelProfiles ??= [];
    manifest.modelProfiles.push(profile.id);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    expect(profile.configVersion).toBe(1);
    expect(JSON.stringify(profile)).not.toContain(apiKey);
    const secrets = await admin.query<{ ciphertext: Buffer }>("SELECT ciphertext FROM nano.model_credentials WHERE profile_id=$1", [profile.id]);
    expect(secrets.rows[0].ciphertext.toString("utf8")).not.toContain(apiKey);
    const bList = await (await api("/model-profiles", tokenB)).json();
    expect(bList.profiles.some((item: { id: string }) => item.id === profile.id)).toBe(false);
    for (const [method, path, body] of [
      ["PATCH", `/model-profiles/${profile.id}`, { name: "intrusion" }],
      ["POST", `/model-profiles/${profile.id}/test`, {}],
      ["DELETE", `/model-profiles/${profile.id}`, undefined],
    ] as const) {
      const denied = await api(path, tokenB, { method, body: body ? JSON.stringify(body) : undefined });
      expect(denied.status).toBe(404);
    }
    const changed = await (await api(`/model-profiles/${profile.id}`, tokenA, { method: "PATCH", body: JSON.stringify({ name: "renamed" }) })).json();
    expect(changed.profile.configVersion).toBe(2);
    expect(changed.profile.keyMask).toBe(profile.keyMask);
    const masked = await api(`/model-profiles/${profile.id}`, tokenA, { method: "PATCH", body: JSON.stringify({ apiKey: profile.keyMask }) });
    expect(masked.status).toBe(422);
    const deleted = await api(`/model-profiles/${profile.id}`, tokenA, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const remainingCredentials = await admin.query("SELECT 1 FROM nano.model_credentials WHERE profile_id=$1", [profile.id]);
    expect(remainingCredentials.rows).toHaveLength(0);
    const deletedTest = await api(`/model-profiles/${profile.id}/test`, tokenA, { method: "POST", body: "{}" });
    expect(deletedTest.status).toBe(404);
  }, 60_000);

  test("a frozen credential survives profile rotation and deletion only until its final owner lease is released", async () => {
    const database = new PivloomDatabase(process.env.DATABASE_URL!);
    const models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY!));
    const originalKey = `fixture-${randomBytes(18).toString("hex")}`;
    try {
      const created = await api("/model-profiles", tokenA, { method: "POST", body: JSON.stringify({
        name: `${manifest.prefix} lease`, provider: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        modelId: "fixture-lease-no-provider-call", apiKey: originalKey, isDefault: false,
      }) });
      expect(created.status).toBe(201);
      const { profile } = await created.json();
      manifest.modelProfiles ??= [];
      manifest.modelProfiles.push(profile.id);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      // Test setup only: no real provider request is made or claimed by this lease lifecycle test.
      await admin.query(`UPDATE nano.model_profile_versions SET capabilities=
        '{"streaming":"verified","tools":"verified","vision":"unknown"}' WHERE profile_id=$1`, [profile.id]);
      const referenceId = randomUUID();
      await expect(models.freezeForRun(owner("A"), profile.id, 1, referenceId)).rejects.toMatchObject({ code: "MODEL_VISION_NOT_VERIFIED", statusCode: 422 });
      // This fixture tests lease behavior, not the external Provider. Mark its
      // capability explicitly only after proving an unverified run is refused.
      await admin.query(`UPDATE nano.model_profile_versions SET capabilities=
        '{"streaming":"verified","tools":"verified","vision":"verified"}' WHERE profile_id=$1`, [profile.id]);
      await expect(database.owned(owner("A"), (client) => models.freezeInTransaction(
        client, owner("A"), profile.id, 1, referenceId, "different-unprobed-model"))).rejects.toMatchObject({
        code: "MODEL_OVERRIDE_VISION_UNVERIFIED", statusCode: 422,
      });
      const lease = await models.freezeForRun(owner("A"), profile.id, 1, referenceId);
      expect(lease).toMatchObject({ profileId: profile.id, configVersion: 1, referenceId });
      expect(JSON.stringify(lease)).not.toContain(originalKey);
      expect(await models.freezeForRun(owner("A"), profile.id, 1, referenceId)).toEqual(lease);
      const rollbackReference = randomUUID();
      await expect(database.owned(owner("A"), async (client) => {
        await models.freezeInTransaction(client, owner("A"), profile.id, 1, rollbackReference);
        throw new Error("fixture task acceptance rolled back");
      })).rejects.toThrow("fixture task acceptance rolled back");
      const rolledBack = await admin.query("SELECT 1 FROM nano.model_credential_leases WHERE reference_id=$1", [rollbackReference]);
      expect(rolledBack.rows).toHaveLength(0);
      await Promise.all([
        expect(models.freezeForRun(owner("B"), profile.id, 1, randomUUID())).rejects.toMatchObject({ statusCode: 404 }),
        expect(models.resolveLease(owner("B"), lease.id)).rejects.toMatchObject({ statusCode: 404 }),
        expect(models.releaseForRun(owner("B"), lease.id)).rejects.toMatchObject({ statusCode: 404 }),
      ]);
      await expect(models.freezeForRun(owner("A"), profile.id, 2, referenceId)).rejects.toMatchObject({ code: "MODEL_LEASE_CONFLICT" });
      const otherLease = await models.freezeForRun(owner("A"), profile.id, 1, randomUUID());

      await models.update(owner("A"), profile.id, { apiKey: "fixture-rotated-not-real" });
      await models.remove(owner("A"), profile.id);
      expect((await models.list(owner("A"))).some((item) => item.id === profile.id)).toBe(false);
      const frozen = await models.resolveLease(owner("A"), lease.id);
      expect(frozen.profile.configVersion).toBe(1);
      expect(frozen.apiKey).toBe(originalKey);
      const credentials = await admin.query("SELECT config_version FROM nano.model_credentials WHERE profile_id=$1", [profile.id]);
      expect(credentials.rows).toEqual([{ config_version: 1 }]);
      await expect(models.freezeForRun(owner("A"), profile.id, 2, randomUUID())).rejects.toMatchObject({ statusCode: 404 });

      await models.releaseForRun(owner("A"), lease.id);
      await models.releaseForRun(owner("A"), lease.id);
      await expect(models.resolveLease(owner("A"), lease.id)).rejects.toMatchObject({ statusCode: 404 });
      expect((await models.resolveLease(owner("A"), otherLease.id)).apiKey).toBe(originalKey);
      await models.releaseForRun(owner("A"), otherLease.id);
      const reclaimed = await admin.query("SELECT 1 FROM nano.model_credentials WHERE profile_id=$1", [profile.id]);
      expect(reclaimed.rows).toHaveLength(0);
    } finally { await database.close(); }
  }, 120_000);
});
