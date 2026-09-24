// Disposable GitHub Actions PostgreSQL setup. Never imports a local env file.
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

let stage = 'configuration';

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true' || !process.env.GITHUB_ENV)
    throw Error('This preparation script requires an explicit GitHub Actions environment');
  const connection = new URL(process.env.PIVLOOM_CI_POSTGRES_URL ?? '');
  if (connection.protocol !== 'postgres:' || connection.hostname !== '127.0.0.1' || connection.port !== '5432'
    || connection.pathname !== '/postgres' || connection.search || connection.hash)
    throw Error('Only the runner-local disposable postgres service is supported');
  const databases = ['pivloom_repair_test_ci', 'pivloom_recovery_test_ci', 'pivloom_rollback_test_ci', 'pivloom_executor_test_ci', 'pivloom_e2e_test_ci_review'];
  const executorOwnerId = randomUUID();
  const executorEnvironmentId = `pivloom-ci-executor-${randomUUID()}`;
  const reviewEnvironmentId = `pivloom-ci-review-${randomUUID()}`;
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
        if (name === 'pivloom_executor_test_ci' || name === 'pivloom_e2e_test_ci_review') {
          await pool.query(`CREATE TABLE nano.environment_identity
            (id boolean PRIMARY KEY DEFAULT true CHECK(id), environment_id text NOT NULL)`);
          await pool.query('INSERT INTO nano.environment_identity(id,environment_id) VALUES(true,$1)',
            [name === 'pivloom_executor_test_ci' ? executorEnvironmentId : reviewEnvironmentId]);
          if (name === 'pivloom_executor_test_ci') await pool.query('INSERT INTO auth.users(id) VALUES($1)', [executorOwnerId]);
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
      + `MODEL_CREDENTIALS_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
  } finally { await admin.end(); }
}

main().catch((error) => {
  // Avoid dumping database connection details, including on configuration errors.
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? ` (${error.code})` : '';
  console.error(`CI PostgreSQL preparation failed at ${stage}${code}.`);
  process.exitCode = 1;
});
