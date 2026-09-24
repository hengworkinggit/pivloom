// Disposable GitHub Actions PostgreSQL setup. Never imports a local env file.
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

/**
 * Gives the queue suite two owners it can admit work for. The profile versions
 * are marked verified because dispatch checks the frozen configuration before
 * handing a task over; the credential is sealed with the run's own key so the
 * row is a real encrypted record rather than a placeholder. No provider is ever
 * contacted by the scheduler cases.
 */
async function seedQueueOwners(pool, owners, masterKey, environmentId, root) {
  // Same envelope as apps/api/src/models/credentials.ts (AES-256-GCM with the
  // scope as additional authenticated data). It is written out here because this
  // script runs under plain node and cannot import that TypeScript module.
  const key = Buffer.from(masterKey, 'base64');
  const seal = (apiKey, scope) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`pivloom:model:v1:${scope.ownerId}:${scope.profileId}:${scope.version}`, 'utf8'));
    return { ciphertext: Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]), nonce, authTag: cipher.getAuthTag() };
  };
  const users = [];
  for (const [index, owner] of owners.entries()) {
    const profile = randomUUID();
    const label = index === 0 ? 'A' : 'B';
    await pool.query('ALTER TABLE nano.model_profiles DISABLE TRIGGER ALL');
    try {
      await pool.query('INSERT INTO nano.model_profiles(id,owner_id,current_version,is_default) VALUES($1,$2,1,true)',
        [profile, owner]);
    } finally { await pool.query('ALTER TABLE nano.model_profiles ENABLE TRIGGER ALL'); }
    await pool.query(`INSERT INTO nano.model_profile_versions
      (profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask,capabilities,last_test)
      VALUES($1,$2,1,$3,'openai-completions','https://queue-fixture.invalid/v1','queue-fixture','sk-…ture',
        '{"streaming":"verified","tools":"verified","vision":"verified"}',
        $4)`,
    [profile, owner, `queue-fixture-${label}`, JSON.stringify({ status: 'passed', message: 'CI capability fixture',
      testedAt: new Date().toISOString(), capabilities: { streaming: 'verified', tools: 'verified', vision: 'verified' } })]);
    const sealed = seal('ci-queue-fixture-key', { ownerId: owner, profileId: profile, version: 1 });
    await pool.query(`INSERT INTO nano.model_credentials(profile_id,config_version,owner_id,ciphertext,nonce,auth_tag)
      VALUES($1,1,$2,$3,$4,$5)`, [profile, owner, sealed.ciphertext, sealed.nonce, sealed.authTag]);
    users.push({ label, email: `queue-fixture-${label.toLowerCase()}-${owner.slice(0, 8)}@ci.test`, password: randomBytes(24).toString('base64url'), id: owner });
  }
  const directory = `${root}/.cache/identity/${environmentId}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/manifest.json`, `${JSON.stringify({
    environmentId, prefix: 'pivloom-ci-queue', users, projects: [], modelProfiles: [], objects: [],
  }, null, 2)}\n`, { mode: 0o600 });
}

let stage = 'configuration';

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true' || !process.env.GITHUB_ENV)
    throw Error('This preparation script requires an explicit GitHub Actions environment');
  const connection = new URL(process.env.PIVLOOM_CI_POSTGRES_URL ?? '');
  if (connection.protocol !== 'postgres:' || connection.hostname !== '127.0.0.1' || connection.port !== '5432'
    || connection.pathname !== '/postgres' || connection.search || connection.hash)
    throw Error('Only the runner-local disposable postgres service is supported');
  const databases = ['pivloom_repair_test_ci', 'pivloom_recovery_test_ci', 'pivloom_rollback_test_ci', 'pivloom_executor_test_ci', 'pivloom_e2e_test_ci_review', 'pivloom_queue_test_ci'];
  const executorOwnerId = randomUUID();
  const executorEnvironmentId = `pivloom-ci-executor-${randomUUID()}`;
  const reviewEnvironmentId = `pivloom-ci-review-${randomUUID()}`;
  const queueEnvironmentId = `pivloom-ci-queue-${randomUUID()}`;
  const queueOwners = [randomUUID(), randomUUID()];
  // One key seals the queue fixture credential and is handed to the test steps,
  // which need it to open the lease the repository creates for each task.
  const masterKey = randomBytes(32).toString('base64');
  const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
  const admin = new Pool({ connectionString: connection.href, max: 1, connectionTimeoutMillis: 5000 });
  try {
    stage = 'fresh service check';
    const existing = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [databases]);
    if (existing.rowCount !== 0) throw Error('CI databases already exist; use a fresh service, never reset existing data');
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$`);
    const migrations = new URL('../../../../migrations/', import.meta.url);
    const names = (await readdir(migrations)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (!names.length) throw Error('Repository migrations are missing');
    const urls = [];
    for (const name of databases) {
      stage = `create ${name}`;
      // Names are fixed constants above, never shell or user input.
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(connection);
      url.pathname = `/${name}`;
      const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
      try {
        await pool.query('CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY)');
        for (const migration of names) {
          stage = `${name}: ${migration}`;
          await pool.query('BEGIN');
          try {
            await pool.query(await readFile(new URL(migration, migrations), 'utf8'));
            await pool.query('COMMIT');
          } catch (error) {
            await pool.query('ROLLBACK');
            throw error;
          }
        }
        if (name === 'pivloom_executor_test_ci' || name === 'pivloom_e2e_test_ci_review' || name === 'pivloom_queue_test_ci') {
          await pool.query(`CREATE TABLE nano.environment_identity
            (id boolean PRIMARY KEY DEFAULT true CHECK(id), environment_id text NOT NULL)`);
          await pool.query('INSERT INTO nano.environment_identity(id,environment_id) VALUES(true,$1)',
            [name === 'pivloom_executor_test_ci' ? executorEnvironmentId
              : name === 'pivloom_queue_test_ci' ? queueEnvironmentId : reviewEnvironmentId]);
          if (name === 'pivloom_executor_test_ci') await pool.query('INSERT INTO auth.users(id) VALUES($1)', [executorOwnerId]);
        }
        if (name === 'pivloom_queue_test_ci') {
          // The queue suite needs two owners whose default configuration really
          // passed streaming, tools and image checks, because dispatch validates
          // the frozen configuration before it hands a task to the executor.
          // This is a capability fixture, never a provider probe: the scheduler
          // cases never call a model.
          for (const owner of queueOwners) await pool.query('INSERT INTO auth.users(id) VALUES($1)', [owner]);
          await seedQueueOwners(pool, queueOwners, masterKey, queueEnvironmentId, root);
        }
        urls.push(url.href);
        console.info(`Prepared ${name}: ${names.length} repository migrations; no application data`);
      } finally { await pool.end(); }
    }
    // GITHUB_ENV is the runner's private step handoff, not a committed env file.
    stage = 'runner environment handoff';
    await appendFile(process.env.GITHUB_ENV,
      `DATABASE_URL=${urls[0]}\nMIGRATION_DATABASE_URL=${urls[0]}\nPIVLOOM_RECOVERY_DATABASE_URL=${urls[1]}\nPIVLOOM_ROLLBACK_DATABASE_URL=${urls[2]}\n`
      + `PIVLOOM_EXECUTOR_DATABASE_URL=${urls[3]}\nPIVLOOM_EXECUTOR_OWNER_ID=${executorOwnerId}\n`
      + `PIVLOOM_EXECUTOR_ENVIRONMENT_ID=${executorEnvironmentId}\n`
      + `PIVLOOM_REVIEW_DATABASE_URL=${urls[4]}\nPIVLOOM_REVIEW_ENVIRONMENT_ID=${reviewEnvironmentId}\n`
      + `PIVLOOM_QUEUE_DATABASE_URL=${urls[5]}\nPIVLOOM_QUEUE_ENVIRONMENT_ID=${queueEnvironmentId}\n`
      + `MODEL_CREDENTIALS_ENCRYPTION_KEY=${masterKey}\n`);
  } finally { await admin.end(); }
}

main().catch((error) => {
  // Avoid dumping database connection details, including on configuration errors.
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? ` (${error.code})` : '';
  console.error(`CI PostgreSQL preparation failed at ${stage}${code}.`);
  process.exitCode = 1;
});
