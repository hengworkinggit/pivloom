import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

interface Identity { label: "A" | "B"; email: string; password: string; id?: string }
interface Manifest {
  environmentId: string;
  prefix: string;
  users: Identity[];
  projects: string[];
  modelProfiles?: string[];
  objects: { bucket: string; key: string }[];
}

class MaintenanceFailure extends Error {}
function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new MaintenanceFailure(`缺少 ${name}。`);
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["migrate", "seed", "verify", "cleanup"].includes(command)) {
    throw new MaintenanceFailure("用法：manage.ts migrate|seed|verify|cleanup --environment-id <已配置环境ID>");
  }
  const expected = args[args.indexOf("--environment-id") + 1];
  const environmentId = required("PIVLOOM_ENVIRONMENT_ID");
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(environmentId) || !args.includes("--environment-id") || expected !== environmentId) {
    throw new MaintenanceFailure("目标环境 ID 不匹配；未执行任何操作。");
  }
  const dbUrl = required("MIGRATION_DATABASE_URL");
  const supabaseUrl = required("SUPABASE_URL");
  const secret = required("SUPABASE_SECRET_KEY");
  const directory = resolve(fileURLToPath(new URL("../../../../.cache/identity/", import.meta.url)), environmentId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const manifestPath = resolve(directory, "manifest.json");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.environmentId !== environmentId) throw new MaintenanceFailure("资源 manifest 与目标不符。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (command === "cleanup" || command === "verify") throw new MaintenanceFailure("当前环境没有 seed manifest，未执行操作。");
    const prefix = `pivloom-${randomUUID().slice(0, 8)}`;
    manifest = { environmentId, prefix, users: ["A", "B"].map((label) => ({
      label: label as "A" | "B", email: `${prefix}-${label.toLowerCase()}@example.test`,
      password: randomBytes(24).toString("base64url"),
    })), projects: [], modelProfiles: [], objects: [] };
  }
  const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await save();
  const pool = new Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const admin = createClient(supabaseUrl, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    // The expected environment is persisted in this DB, not inferred from a tunnel host/port.
    await pool.query("CREATE SCHEMA IF NOT EXISTS nano");
    await pool.query("REVOKE ALL ON SCHEMA nano FROM PUBLIC, anon, authenticated");
    await pool.query("CREATE TABLE IF NOT EXISTS nano.environment_identity (id boolean PRIMARY KEY DEFAULT true CHECK(id), environment_id text NOT NULL)");
    const target = await pool.query<{ environment_id: string }>("SELECT environment_id FROM nano.environment_identity WHERE id = true");
    if (target.rows[0] && target.rows[0].environment_id !== environmentId) {
      throw new MaintenanceFailure("数据库实际环境 ID 不匹配；已停止。");
    }
    if (!target.rows[0]) {
      if (command !== "migrate") throw new MaintenanceFailure("数据库尚未登记环境 ID，请先 migrate。");
      await pool.query("INSERT INTO nano.environment_identity (environment_id) VALUES ($1)", [environmentId]);
    }
    if (command === "migrate") {
      await pool.query("CREATE TABLE IF NOT EXISTS nano.schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
      const directory = fileURLToPath(new URL("../../../../migrations/", import.meta.url));
      for (const name of (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()) {
        const sql = await readFile(resolve(directory, name), "utf8");
        const sha256 = createHash("sha256").update(sql).digest("hex");
        const prior = await pool.query<{ sha256: string }>("SELECT sha256 FROM nano.schema_migrations WHERE name = $1", [name]);
        if (prior.rows[0]) {
          if (prior.rows[0].sha256 !== sha256) throw new MaintenanceFailure(`迁移 ${name} 内容与已执行版本不同。`);
          continue;
        }
        await pool.query("BEGIN");
        try {
          await pool.query(sql);
          await pool.query("INSERT INTO nano.schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha256]);
          await pool.query("COMMIT");
        } catch (error) { await pool.query("ROLLBACK"); throw error; }
      }
      const bucket = await admin.storage.getBucket("pivloom-private");
      if (bucket.error) {
        const created = await admin.storage.createBucket("pivloom-private", { public: false, fileSizeLimit: 10 * 1024 * 1024 });
        if (created.error) throw new MaintenanceFailure("创建私有 Storage bucket 失败。");
      } else if (bucket.data.public) {
        throw new MaintenanceFailure("同名 bucket 已公开，拒绝继续；需要先检查已有资源。");
      }
    }
    if (command === "seed") {
      for (const identity of manifest.users) {
        if (identity.id) {
          const found = await admin.auth.admin.getUserById(identity.id);
          if (!found.error && found.data.user?.email === identity.email) continue;
          throw new MaintenanceFailure("已登记的测试身份不匹配，请检查 manifest；不会覆盖身份。");
        }
        let existing: { id: string; email?: string; app_metadata: Record<string, unknown> } | undefined;
        for (let page = 1; page <= 100; page++) {
          const listed = await admin.auth.admin.listUsers({ page, perPage: 100 });
          if (listed.error) throw new MaintenanceFailure("读取测试身份失败。");
          existing = listed.data.users.find((user) => user.email === identity.email);
          if (existing || listed.data.users.length < 100) break;
        }
        if (existing) {
          if (existing.app_metadata.pivloom_test_prefix !== manifest.prefix) throw new MaintenanceFailure("测试邮箱已被其他身份占用。");
          identity.id = existing.id;
        } else {
          const created = await admin.auth.admin.createUser({
            email: identity.email, password: identity.password, email_confirm: true,
            user_metadata: { display_name: `Tester ${identity.label}` },
            app_metadata: { pivloom_test_prefix: manifest.prefix, pivloom_environment: environmentId },
          });
          if (created.error || !created.data.user) throw new MaintenanceFailure("创建测试身份失败。");
          identity.id = created.data.user.id;
        }
        await save();
      }
    }
    if (command === "verify") {
      const publishableKey = required("SUPABASE_PUBLISHABLE_KEY");
      const signedInClients: (typeof admin)[] = [];
      for (const identity of manifest.users) {
        const client = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
        const signedIn = await client.auth.signInWithPassword({ email: identity.email, password: identity.password });
        if (signedIn.error || signedIn.data.user?.id !== identity.id) throw new MaintenanceFailure(`测试身份 ${identity.label} 登录验证失败。`);
        signedInClients.push(client);
      }
      const object = { bucket: "pivloom-private", key: `${manifest.users[0].id}/${manifest.prefix}/storage-probe.txt` };
      if (!manifest.objects.some((item) => item.key === object.key)) manifest.objects.push(object);
      await save();
      const content = `Storage roundtrip ${manifest.prefix}`;
      const uploaded = await admin.storage.from(object.bucket).upload(object.key, content, { contentType: "text/plain", upsert: true });
      if (uploaded.error) throw new MaintenanceFailure("Storage 上传失败。");
      const downloaded = await admin.storage.from(object.bucket).download(object.key);
      if (downloaded.error || await downloaded.data.text() !== content) throw new MaintenanceFailure("Storage 下载内容验证失败。");
      const anonymous = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
      if (!(await anonymous.storage.from(object.bucket).download(object.key)).error) throw new MaintenanceFailure("匿名用户可读取私有工件，验证失败。");
      for (const client of signedInClients) {
        if (!(await client.storage.from(object.bucket).download(object.key)).error) throw new MaintenanceFailure("用户能直接绕过 API 读取 Storage 私有工件，验证失败。");
      }
    }
    if (command === "cleanup") {
      // Exact manifest ownership and the Auth metadata must agree before any deletion.
      for (const identity of manifest.users) {
        if (!identity.id) continue;
        const found = await admin.auth.admin.getUserById(identity.id);
        if (found.error || found.data.user?.email !== identity.email || found.data.user.app_metadata.pivloom_test_prefix !== manifest.prefix) {
          throw new MaintenanceFailure("测试身份归属不匹配；未执行清理。");
        }
      }
      const owners = manifest.users.map((identity) => identity.id).filter(Boolean);
      for (const [table, ids] of [["projects", manifest.projects], ["model_profiles", manifest.modelProfiles ?? []]] as const) {
        if (!ids.length) continue;
        const owned = await pool.query<{ id: string }>(`SELECT id FROM nano.${table} WHERE id = ANY($1::uuid[]) AND owner_id = ANY($2::uuid[])`, [ids, owners]);
        if (new Set(ids).size !== owned.rows.length) throw new MaintenanceFailure("资源 manifest 与测试 owner 不匹配；未执行清理。");
      }
      for (const object of manifest.objects) {
        if (object.bucket !== "pivloom-private" || !owners.some((owner) => object.key.startsWith(`${owner}/${manifest.prefix}/`))) {
          throw new MaintenanceFailure("工件 manifest 越界；未执行清理。");
        }
      }
      for (const object of manifest.objects) {
        if ((await admin.storage.from(object.bucket).remove([object.key])).error) throw new MaintenanceFailure("清理测试工件失败。");
      }
      await pool.query("BEGIN");
      try {
        const profiles = manifest.modelProfiles ?? [];
        await pool.query("DELETE FROM nano.model_credential_leases WHERE profile_id = ANY($1::uuid[]) AND owner_id = ANY($2::uuid[])", [profiles, owners]);
        await pool.query("DELETE FROM nano.model_credentials WHERE profile_id = ANY($1::uuid[]) AND owner_id = ANY($2::uuid[])", [profiles, owners]);
        await pool.query("DELETE FROM nano.model_profile_versions WHERE profile_id = ANY($1::uuid[]) AND owner_id = ANY($2::uuid[])", [profiles, owners]);
        await pool.query("DELETE FROM nano.model_profiles WHERE id = ANY($1::uuid[]) AND owner_id = ANY($2::uuid[])", [profiles, owners]);
        await pool.query("DELETE FROM nano.projects WHERE id = ANY($1::uuid[]) AND owner_id = ANY($2::uuid[])", [manifest.projects, owners]);
        await pool.query("COMMIT");
      } catch (error) { await pool.query("ROLLBACK"); throw error; }
      // Auth users are intentionally retained for idempotent seed and repeat E2E.
      manifest.objects = [];
      manifest.projects = [];
      manifest.modelProfiles = [];
      await save();
    }
    process.stdout.write(`${command}: PASS (${environmentId}); local manifest: ${manifestPath}\n`);
  } finally { await pool.end(); }
}

main().catch((error) => {
  process.stderr.write(error instanceof MaintenanceFailure ? `${error.message}\n` : "维护操作失败；未输出连接或凭据详情。\n");
  process.exitCode = 1;
});
