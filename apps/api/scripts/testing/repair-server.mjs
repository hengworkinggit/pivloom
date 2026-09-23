// Isolated E16/E22/E23 launcher. Production's server.ts never imports this file.
// Run from apps/api after build; TEST_PROFILE points to a private JSON manifest.
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApp } from '../../dist/app.js';
import { PivloomDatabase } from '../../dist/data/database.js';

const databaseName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (process.env.NODE_ENV !== 'test' || !/^pivloom_e2e_test_[a-z0-9_]+$/.test(databaseName))
  throw Error('An explicitly isolated E2E database is required');
const manifestPath = process.env.TEST_PROFILE;
if (!manifestPath) throw Error('A private fixture manifest is required');
const casesSchema = z.array(z.strictObject({
  id:z.uuid(), ownerId:z.uuid(), projectId:z.uuid(),
  scenario:z.enum(['INVALID_TS_FIRST_ATTEMPT','BROKEN_FILTER_FIRST_ATTEMPT','PERSISTENT_BROKEN_FILTER']),
  expiresAt:z.iso.datetime(), applied:z.array(z.strictObject({runId:z.uuid(),attempt:z.number().int().min(0).max(2),at:z.iso.datetime()})).max(3),
})).max(3);
const pool = new Pool({connectionString:process.env.DATABASE_URL,max:1});
const database = new PivloomDatabase(process.env.DATABASE_URL);
const actual = (await pool.query('SELECT current_database() AS name')).rows[0].name;
if (actual !== databaseName) throw Error('Isolated database mismatch');
const brokenSource = await readFile(new URL('./fixtures/broken-filter.tsx.txt',import.meta.url),'utf8');
const app = createApp({ env:process.env, logger:false,
  previewListen:{host:'127.0.0.1',port:Number(process.env.PREVIEW_PORT)},
  generationBoundaries:{async afterBuilderOutput({runId,attempt,workspace,handle,signal}) {
    const cases = casesSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));
    let row, profile;
    for (const candidate of cases) {
      const result = await database.owned(candidate.ownerId, client => client.query(
        'SELECT attempt FROM nano.runs WHERE owner_id=$1 AND project_id=$2 AND id=$3',
        [candidate.ownerId,candidate.projectId,runId]));
      if (result.rows[0]) {row=result.rows[0];profile=candidate;break;}
    }
    if (!profile) return;
    if (Date.parse(profile.expiresAt)<=Date.now() || row.attempt!==attempt) throw Error('Fixture expired or attempt changed');
    if (profile.scenario!=='PERSISTENT_BROKEN_FILTER'&&attempt!==0) return;
    if (profile.applied.length && profile.applied[0].runId!==runId) return;
    if (profile.applied.some(p=>p.runId===runId&&p.attempt===attempt)||profile.applied.length>=3) throw Error('Fixture already applied');
    // Mark before I/O; a failed/unknown write is never silently applied again.
    profile.applied.push({runId,attempt,at:new Date().toISOString()});
    await writeFile(manifestPath,JSON.stringify(cases,null,2)+'\n',{mode:0o600});
    signal.throwIfAborted();
    if(profile.scenario==='INVALID_TS_FIRST_ATTEMPT') {
      const original=Buffer.from(await workspace.read(handle,'src/App.tsx')).toString('utf8');
      await workspace.write(handle,'src/App.tsx',Buffer.from(original+'\nexport const brokenFixture: = ;\n'));
    } else await workspace.write(handle,'src/App.tsx',Buffer.from(brokenSource));
    signal.throwIfAborted();
    console.info(JSON.stringify({fixtureId:profile.id,scenario:profile.scenario,runId,attempt,boundary:'Builder output before trusted build'}));
  }},
});
// API and preview remain loopback-only; the developer reaches them by SSH.
await app.ready();
await app.recoverStaleRuns();
await app.listen({host:'127.0.0.1',port:Number(process.env.API_PORT)});
for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>void app.close().then(()=>Promise.all([pool.end(),database.close()])).then(()=>process.exit(0)));
console.info('Isolated repair E2E API ready');
