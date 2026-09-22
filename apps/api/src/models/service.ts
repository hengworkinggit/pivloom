import { createHash, randomUUID } from "node:crypto";
import {
  ModelProfileSchema, ModelTestResultSchema,
  type CreateModelProfile, type UpdateModelProfile, type ModelProfile, type ModelTestResult,
} from "@pivloom/contracts";
import type { PoolClient } from "pg";
import type { PivloomDatabase } from "../data/database.js";
import { ApiFailure } from "../routes/errors.js";
import type { CredentialVault } from "./credentials.js";
import { createModelFetch, validateModelEndpoint } from "./transport.js";
import { testModelConnection } from "./probe.js";

interface Row {
  id: string; owner_id: string; current_version: number; is_default: boolean;
  created_at: Date; updated_at: Date; deleted_at: Date | null;
  name: string; provider: CreateModelProfile["provider"]; base_url: string; model_id: string;
  key_mask: string; capabilities: ModelProfile["capabilities"]; last_test: ModelTestResult | null;
}
export interface ModelCredentialLease {
  id: string;
  profileId: string;
  configVersion: number;
  referenceId: string;
}
interface LeaseRow {
  id: string; profile_id: string; config_version: number; reference_id: string; released_at: Date | null;
}
function leaseReference(row: LeaseRow): ModelCredentialLease {
  return { id: row.id, profileId: row.profile_id, configVersion: row.config_version, referenceId: row.reference_id };
}
const select = `SELECT p.id, p.owner_id, p.current_version, p.is_default, p.created_at, p.updated_at, p.deleted_at,
  v.name, v.provider, v.base_url, v.model_id, v.key_mask, v.capabilities, v.last_test
  FROM nano.model_profiles p JOIN nano.model_profile_versions v
  ON v.profile_id = p.id AND v.config_version = p.current_version`;
const unknown = { streaming: "unknown", tools: "unknown", vision: "unknown" } as const;
function publicProfile(row: Row): ModelProfile {
  return ModelProfileSchema.parse({
    id: row.id, name: row.name, provider: row.provider, baseUrl: row.base_url, modelId: row.model_id,
    configVersion: row.current_version, keyMask: row.key_mask, isDefault: row.is_default,
    capabilities: row.capabilities, lastTest: row.last_test,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}

export function createModelProfileService(database: PivloomDatabase, vault: CredentialVault) {
  const proofs = new Map<string, { result: ModelTestResult; expiresAt: number }>();
  const limits = new Map<string, { count: number; until: number; running: boolean }>();
  const digest = (owner: string, input: Pick<CreateModelProfile, "provider" | "baseUrl" | "modelId" | "apiKey">) =>
    createHash("sha256").update(JSON.stringify([owner, input.provider, input.baseUrl, input.modelId, input.apiKey])).digest("hex");
  function proof(owner: string, input: CreateModelProfile) {
    const found = proofs.get(digest(owner, input));
    return found && found.expiresAt > Date.now() ? found.result : null;
  }
  async function find(client: PoolClient, ownerId: string, id: string, lock = false) {
    const result = await client.query<Row>(`${select} WHERE p.owner_id = $1 AND p.id = $2 AND p.deleted_at IS NULL ${lock ? "FOR UPDATE OF p" : ""}`, [ownerId, id]);
    if (!result.rows[0]) throw new ApiFailure(404, "NOT_FOUND", "找不到这个模型配置。");
    return result.rows[0];
  }
  async function credential(client: PoolClient, ownerId: string, profileId: string, version: number) {
    const result = await client.query<{ ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer }>(
      "SELECT ciphertext, nonce, auth_tag FROM nano.model_credentials WHERE owner_id=$1 AND profile_id=$2 AND config_version=$3",
      [ownerId, profileId, version],
    );
    if (!result.rows[0]) throw new ApiFailure(503, "MODEL_CREDENTIAL_UNAVAILABLE", "这个模型版本的凭据不可用。");
    return vault.open({ ...result.rows[0], authTag: result.rows[0].auth_tag }, { ownerId, profileId, version });
  }
  async function saveVersion(client: PoolClient, ownerId: string, profileId: string, version: number, input: CreateModelProfile, test: ModelTestResult | null) {
    const encrypted = vault.seal(input.apiKey, { ownerId, profileId, version });
    await client.query(`INSERT INTO nano.model_profile_versions
      (profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask,capabilities,last_test)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      profileId, ownerId, version, input.name, input.provider, input.baseUrl, input.modelId,
      `••••${input.apiKey.slice(-4)}`, test?.capabilities ?? unknown, test,
    ]);
    await client.query(`INSERT INTO nano.model_credentials
      (profile_id,config_version,owner_id,ciphertext,nonce,auth_tag) VALUES ($1,$2,$3,$4,$5,$6)`,
    [profileId, version, ownerId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag]);
  }
  async function ownerLock(client: PoolClient, ownerId: string) {
    // Serializes version edits, deletion and credential leases for this account.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 731))", [ownerId]);
  }
  async function reclaimDeletedCredentials(client: PoolClient, ownerId: string, profileId: string) {
    await client.query(`DELETE FROM nano.model_credentials c
      USING nano.model_profiles p
      WHERE c.owner_id=$1 AND c.profile_id=$2 AND p.id=c.profile_id AND p.owner_id=c.owner_id
        AND p.deleted_at IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM nano.model_credential_leases l
          WHERE l.owner_id=c.owner_id AND l.profile_id=c.profile_id
            AND l.config_version=c.config_version AND l.released_at IS NULL
        )`, [ownerId, profileId]);
  }
  /** Call inside database.owned so a run and its credential reference can commit atomically. */
  async function freezeInTransaction(client: PoolClient, ownerId: string, profileId: string, configVersion: number, referenceId: string) {
    const scoped = await client.query<{ owned: boolean }>(`SELECT current_user='nano_api'
      AND nullif(current_setting('request.jwt.claim.sub', true), '')::uuid=$1 AS owned`, [ownerId]);
    if (!scoped.rows[0]?.owned) throw new Error("Credential leases require an owner-scoped transaction");
    await ownerLock(client, ownerId);
    const previous = await client.query<LeaseRow>(`SELECT id,profile_id,config_version,reference_id,released_at
      FROM nano.model_credential_leases WHERE owner_id=$1 AND reference_id=$2`, [ownerId, referenceId]);
    const existing = previous.rows[0];
    if (existing) {
      if (existing.profile_id !== profileId || existing.config_version !== configVersion) {
        throw new ApiFailure(409, "MODEL_LEASE_CONFLICT", "同一任务不能切换已接受的模型配置。");
      }
      if (existing.released_at) throw new ApiFailure(409, "MODEL_LEASE_RELEASED", "这个任务的模型凭据引用已经释放。");
      return leaseReference(existing);
    }
    const current = await find(client, ownerId, profileId, true);
    if (current.current_version !== configVersion) {
      throw new ApiFailure(409, "MODEL_CONFIGURATION_CHANGED", "模型配置已更新，请刷新后重试。");
    }
    if (current.capabilities.streaming !== "verified" || current.capabilities.tools !== "verified") {
      throw new ApiFailure(422, "MODEL_NOT_VERIFIED", "请先在模型设置中通过连接和工具调用测试。");
    }
    const available = await client.query(`SELECT 1 FROM nano.model_credentials
      WHERE owner_id=$1 AND profile_id=$2 AND config_version=$3`, [ownerId, profileId, configVersion]);
    if (!available.rows[0]) throw new ApiFailure(503, "MODEL_CREDENTIAL_UNAVAILABLE", "这个模型版本的凭据不可用。");
    const inserted = await client.query<LeaseRow>(`INSERT INTO nano.model_credential_leases
      (owner_id,profile_id,config_version,reference_id) VALUES ($1,$2,$3,$4)
      RETURNING id,profile_id,config_version,reference_id,released_at`, [ownerId, profileId, configVersion, referenceId]);
    return leaseReference(inserted.rows[0]);
  }
  async function test(ownerId: string, input: Pick<CreateModelProfile, "provider" | "baseUrl" | "modelId" | "apiKey">) {
    const now = Date.now();
    for (const [key, entry] of limits) if (entry.until < now && !entry.running) limits.delete(key);
    let limit = limits.get(ownerId);
    if (!limit) { limit = { count: 0, until: now + 60_000, running: false }; limits.set(ownerId, limit); }
    if (limit.running || limit.count >= 5) throw new ApiFailure(429, "MODEL_TEST_RATE_LIMITED", "连接测试过于频繁，请稍后重试。", true);
    limit.count++; limit.running = true;
    try {
      const result = await testModelConnection(input);
      for (const [key, value] of proofs) if (value.expiresAt < now) proofs.delete(key);
      if (proofs.size >= 100) proofs.delete(proofs.keys().next().value!);
      proofs.set(digest(ownerId, input), { result, expiresAt: Date.now() + 5 * 60_000 });
      return result;
    } finally { limit.running = false; }
  }
  return {
    async list(ownerId: string) {
      return database.owned(ownerId, async (client) => {
        const result = await client.query<Row>(`${select} WHERE p.owner_id=$1 AND p.deleted_at IS NULL ORDER BY p.is_default DESC, p.created_at DESC`, [ownerId]);
        return result.rows.map(publicProfile);
      });
    },
    async create(ownerId: string, input: CreateModelProfile) {
      input = { ...input, baseUrl: await validateModelEndpoint(input.baseUrl) };
      return database.owned(ownerId, async (client) => {
        await ownerLock(client, ownerId);
        const count = await client.query<{ count: number }>("SELECT count(*)::int count FROM nano.model_profiles WHERE owner_id=$1 AND deleted_at IS NULL", [ownerId]);
        if (count.rows[0].count >= 20) throw new ApiFailure(422, "MODEL_PROFILE_LIMIT", "最多保存 20 个模型配置。");
        const isDefault = input.isDefault ?? count.rows[0].count === 0;
        if (isDefault) await client.query("UPDATE nano.model_profiles SET is_default=false WHERE owner_id=$1 AND is_default", [ownerId]);
        const id = randomUUID();
        await client.query("INSERT INTO nano.model_profiles (id,owner_id,current_version,is_default) VALUES ($1,$2,1,$3)", [id, ownerId, isDefault]);
        await saveVersion(client, ownerId, id, 1, input, proof(ownerId, input));
        return publicProfile(await find(client, ownerId, id));
      });
    },
    async update(ownerId: string, id: string, changes: UpdateModelProfile) {
      if (changes.baseUrl) changes = { ...changes, baseUrl: await validateModelEndpoint(changes.baseUrl) };
      return database.owned(ownerId, async (client) => {
        await ownerLock(client, ownerId);
        const current = await find(client, ownerId, id, true);
        if (changes.isDefault === true) await client.query("UPDATE nano.model_profiles SET is_default=false WHERE owner_id=$1 AND is_default", [ownerId]);
        const editsConfig = Object.keys(changes).some((key) => key !== "isDefault");
        let version = current.current_version;
        if (editsConfig) {
          const oldKey = await credential(client, ownerId, id, version);
          const input: CreateModelProfile = {
            name: changes.name ?? current.name, provider: changes.provider ?? current.provider,
            baseUrl: changes.baseUrl ?? current.base_url, modelId: changes.modelId ?? current.model_id,
            apiKey: changes.apiKey ?? oldKey,
          };
          version++;
          const sameConnection = input.provider === current.provider && input.baseUrl === current.base_url && input.modelId === current.model_id && input.apiKey === oldKey;
          await saveVersion(client, ownerId, id, version, input, sameConnection ? current.last_test : proof(ownerId, input));
        }
        await client.query("UPDATE nano.model_profiles SET current_version=$3, is_default=$4, updated_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, id, version, changes.isDefault ?? current.is_default]);
        return publicProfile(await find(client, ownerId, id));
      });
    },
    async remove(ownerId: string, id: string) {
      return database.owned(ownerId, async (client) => {
        await ownerLock(client, ownerId);
        await find(client, ownerId, id, true);
        await client.query("UPDATE nano.model_profiles SET deleted_at=now(), is_default=false, updated_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, id]);
        await reclaimDeletedCredentials(client, ownerId, id);
      });
    },
    async testDraft(ownerId: string, input: CreateModelProfile) {
      return test(ownerId, { ...input, baseUrl: new URL(input.baseUrl).toString().replace(/\/$/, "") });
    },
    async testSaved(ownerId: string, id: string) {
      const frozen = await database.owned(ownerId, async (client) => {
        const current = await find(client, ownerId, id);
        return { current, apiKey: await credential(client, ownerId, id, current.current_version) };
      });
      const result = await test(ownerId, {
        provider: frozen.current.provider, baseUrl: frozen.current.base_url, modelId: frozen.current.model_id, apiKey: frozen.apiKey,
      });
      await database.owned(ownerId, async (client) => {
        await client.query("UPDATE nano.model_profile_versions SET capabilities=$4,last_test=$5 WHERE owner_id=$1 AND profile_id=$2 AND config_version=$3",
          [ownerId, id, frozen.current.current_version, result.capabilities, ModelTestResultSchema.parse(result)]);
      });
      return result;
    },
    freezeInTransaction,
    async freezeForRun(ownerId: string, profileId: string, configVersion: number, referenceId: string) {
      return database.owned(ownerId, (client) => freezeInTransaction(client, ownerId, profileId, configVersion, referenceId));
    },
    async resolveLease(ownerId: string, leaseId: string) {
      return database.owned(ownerId, async (client) => {
        await ownerLock(client, ownerId);
        const result = await client.query<Row>(`SELECT p.id,p.owner_id,v.config_version AS current_version,
          p.is_default,p.created_at,p.updated_at,p.deleted_at,v.name,v.provider,v.base_url,v.model_id,
          v.key_mask,v.capabilities,v.last_test
          FROM nano.model_credential_leases l
          JOIN nano.model_profiles p ON p.id=l.profile_id AND p.owner_id=l.owner_id
          JOIN nano.model_profile_versions v ON v.profile_id=l.profile_id
            AND v.owner_id=l.owner_id AND v.config_version=l.config_version
          WHERE l.owner_id=$1 AND l.id=$2 AND l.released_at IS NULL`, [ownerId, leaseId]);
        const frozen = result.rows[0];
        if (!frozen) throw new ApiFailure(404, "NOT_FOUND", "找不到有效的模型凭据引用。");
        return {
          profile: publicProfile(frozen),
          apiKey: await credential(client, ownerId, frozen.id, frozen.current_version),
          fetch: createModelFetch(frozen.base_url),
        };
      });
    },
    async releaseForRun(ownerId: string, leaseId: string) {
      return database.owned(ownerId, async (client) => {
        await ownerLock(client, ownerId);
        const released = await client.query<{ profile_id: string }>(`UPDATE nano.model_credential_leases
          SET released_at=coalesce(released_at,now()) WHERE owner_id=$1 AND id=$2 RETURNING profile_id`, [ownerId, leaseId]);
        if (!released.rows[0]) throw new ApiFailure(404, "NOT_FOUND", "找不到这个模型凭据引用。");
        await reclaimDeletedCredentials(client, ownerId, released.rows[0].profile_id);
      });
    },
  };
}
export type ModelProfileService = ReturnType<typeof createModelProfileService>;
