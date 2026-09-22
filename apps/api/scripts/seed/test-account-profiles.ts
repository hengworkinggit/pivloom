/**
 * Idempotent operator seed for the A/B test accounts.
 *
 * The second test account exists so isolation and per-account quota can be
 * exercised for real, which requires both accounts to own a working model
 * profile. This clones the configuration (never a shared row) of the first
 * account's default profile into its own owner-scoped, separately encrypted
 * credential, then runs the same live capability test the settings page runs.
 *
 * Run: node --env-file=.env.local --import tsx scripts/seed/test-account-profiles.ts
 * It prints only labels and capability states, never key material.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PivloomDatabase } from "../../src/data/database.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createModelProfileService } from "../../src/models/service.js";

const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
const masterKey = process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY;
if (!environmentId || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL || !masterKey)
  throw new Error("PIVLOOM_ENVIRONMENT_ID, DATABASE_URL, MIGRATION_DATABASE_URL and MODEL_CREDENTIALS_ENCRYPTION_KEY are required");

// Resolved from the repository root so the script behaves the same from any cwd.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, ".cache/identity", environmentId, "manifest.json"), "utf8")) as {
  environmentId: string; users: Array<{ label: string; id: string }>;
};
if (manifest.environmentId !== environmentId) throw new Error("Identity manifest does not match PIVLOOM_ENVIRONMENT_ID");
const ownerA = manifest.users.find((user) => user.label === "A")?.id;
const ownerB = manifest.users.find((user) => user.label === "B")?.id;
if (!ownerA || !ownerB) throw new Error("Identity manifest needs both A and B test accounts");

const database = new PivloomDatabase(process.env.DATABASE_URL);
const vault = createCredentialVault(masterKey);
const models = createModelProfileService(database, vault);

const source = (await models.list(ownerA)).find((profile) => profile.isDefault && profile.capabilities.streaming === "verified");
if (!source) throw new Error("Account A has no verified default profile to clone");

const existing = (await models.list(ownerB)).find((profile) => profile.capabilities.streaming === "verified" && profile.capabilities.tools === "verified");
if (existing) {
  console.log(`account B already has a verified profile (${existing.id}); nothing to do`);
} else {
  // The source credential is decrypted only inside this process and re-sealed
  // under account B's own scope, so no two owners ever share a credential row.
  const sourceKey = await database.owned(ownerA, async (client) => {
    const row = (await client.query<{ ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer }>(
      "SELECT ciphertext,nonce,auth_tag FROM nano.model_credentials WHERE owner_id=$1 AND profile_id=$2 AND config_version=$3",
      [ownerA, source.id, source.configVersion])).rows[0];
    if (!row) throw new Error("Account A's default profile has no stored credential");
    return vault.open({ ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag },
      { ownerId: ownerA, profileId: source.id, version: source.configVersion });
  });
  const created = await models.create(ownerB, {
    name: "测试账号默认模型", provider: source.provider, baseUrl: source.baseUrl,
    modelId: source.modelId, apiKey: sourceKey, isDefault: true,
  });
  const tested = await models.testSaved(ownerB, created.id);
  console.log(`account B profile ${created.id} test: ${tested.status} streaming=${tested.capabilities.streaming} tools=${tested.capabilities.tools}`);
  if (tested.status !== "passed") throw new Error("Cloned profile did not pass the live capability test");
}

await database.close();
