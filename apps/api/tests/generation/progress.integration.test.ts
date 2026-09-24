import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';
import { PivloomDatabase } from '../../src/data/database.js';
import { createProjectRepository } from '../../src/data/projects.js';
import { createGenerationRepository } from '../../src/data/generation.js';
import type { ModelProfileService } from '../../src/models/service.js';

describe.skipIf(process.env.PIVLOOM_PROGRESS_INTEGRATION !== '1')('rolling Run progress in isolated PostgreSQL', () => {
  test('only the active role can advance an inactivity deadline with a real progress event', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const adminUrl = process.env.MIGRATION_DATABASE_URL;
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!databaseUrl || !adminUrl || !environmentId) throw Error('Explicit integration target required');
    const databaseName = new URL(adminUrl).pathname.slice(1);
    if (!/^pivloom_[a-z]+_test_[a-z0-9_]+$/.test(databaseName)
      || new URL(databaseUrl).pathname !== `/${databaseName}`) throw Error('Isolated test database required');
    const manifest = JSON.parse(await readFile(resolve('../../.cache/identity', environmentId, 'manifest.json'), 'utf8'));
    if (manifest.environmentId !== environmentId) throw Error('Identity manifest mismatch');
    const ownerId: string = manifest.users.find((user: { label: string }) => user.label === 'A').id;
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    const database = new PivloomDatabase(databaseUrl);
    const bootId = randomUUID();
    const repo = createGenerationRepository(database, {} as ModelProfileService, { executorBootId: bootId });
    let projectId: string | undefined;
    let runId: string | undefined;
    try {
      const identity = await admin.query('SELECT environment_id FROM nano.environment_identity WHERE id=true');
      if (identity.rows[0]?.environment_id !== environmentId) throw Error('Database environment mismatch');
      const profile = await admin.query(`SELECT p.id, max(v.config_version)::int AS version FROM nano.model_profiles p
        JOIN nano.model_profile_versions v ON v.profile_id=p.id AND v.owner_id=p.owner_id
        WHERE p.owner_id=$1 GROUP BY p.id LIMIT 1`, [ownerId]);
      if (!profile.rows[0]) throw Error('Fixture profile missing');
      const project = await createProjectRepository(database).create(ownerId, `progress-fixture-${randomUUID()}`);
      projectId = project.id;
      runId = randomUUID();
      const roleId = randomUUID(),leaseId = randomUUID();
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO nano.model_credential_leases(id,owner_id,profile_id,config_version,reference_id)
          VALUES($1,$2,$3,$4,$5)`, [leaseId, ownerId, profile.rows[0].id, profile.rows[0].version, runId]);
        await client.query(`INSERT INTO nano.runs(id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,
          model_profile_id,model_config_version,credential_lease_id,coordinator_role_run_id,
          state,phase,budget_json,deadline_at,executor_boot_id,planning_context_json)
          VALUES($1,$2,$3,$4,repeat('a',64),'进展夹具','generate',$5,$6,$7,$8,'planning','plan','{}'::jsonb,
            now()+interval '1 minute',$9,$10)`, [runId, ownerId, projectId, randomUUID(),profile.rows[0].id,
          profile.rows[0].version,leaseId,roleId,bootId,JSON.stringify({schemaVersion:1,project:{id:projectId,title:'进展夹具'},
            requestText:'进展夹具',originalRequest:'进展夹具',clarificationTurns:[],baseRevisionId:null,previousPlan:null})]);
        await client.query(`INSERT INTO nano.role_runs(id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json)
          VALUES($1,$2,$3,$4,'coordinator',0,$5,'running','{}'::jsonb)`, [roleId,ownerId,projectId,runId,randomUUID()]);
        await client.query(`UPDATE nano.projects SET operation_kind='generate',operation_id=$2,operation_started_at=now()
          WHERE owner_id=$1 AND id=$3`, [ownerId,runId,projectId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }

      const before = await repo.getRun(ownerId, runId);
      const progress = await repo.appendEvent(ownerId, runId, { type:'tool.completed',roleRunId:roleId,
        progress:true,payload:{toolName:'project_summary',success:true} });
      const advanced = await repo.getRun(ownerId, runId);
      expect(progress.type).toBe('tool.completed');
      expect(Date.parse(advanced.deadlineAt) - Date.now()).toBeGreaterThan(5 * 60_000);
      expect(Date.parse(advanced.deadlineAt)).toBeGreaterThan(Date.parse(before.deadlineAt));
      await repo.appendEvent(ownerId, runId, { type:'tool.completed',roleRunId:roleId,
        payload:{toolName:'project_summary',success:false} });
      for (let repeated = 0; repeated < 3; repeated++) await repo.appendEvent(ownerId, runId, {
        type:'tool.completed',roleRunId:roleId,payload:{toolName:'browser_observe',success:true},
      });
      expect((await repo.getRun(ownerId, runId)).deadlineAt).toBe(advanced.deadlineAt);
      await admin.query("UPDATE nano.runs SET deadline_at=now()+interval '1 minute' WHERE id=$1", [runId]);
      const beforeRetry = await repo.getRun(ownerId, runId);
      await repo.appendEvent(ownerId, runId, { type:'tool.output',roleRunId:roleId,progress:true,
        payload:{progressKind:'provider_retry',success:false,retryRequestNumber:2,retryAttempt:1,retryMaxAttempts:6,retryDelayMs:1000} });
      expect(Date.parse((await repo.getRun(ownerId, runId)).deadlineAt)).toBeGreaterThan(Date.parse(beforeRetry.deadlineAt));
      await expect(repo.appendEvent(ownerId, runId, { type:'tool.output',roleRunId:roleId,progress:true,
        payload:{progressKind:'provider_retry',success:false,retryRequestNumber:2,retryAttempt:7,retryMaxAttempts:7,retryDelayMs:9000} }))
        .rejects.toMatchObject({code:'INVALID_PROGRESS'});
      await admin.query("UPDATE nano.runs SET state='building',phase='implement',deadline_at=now()-interval '1 second' WHERE id=$1", [runId]);
      await expect(repo.setPhase(ownerId, runId, { phase:'build',state:'building' }))
        .rejects.toMatchObject({code:'RUN_TIMEOUT'});
      expect(Date.parse((await repo.getRun(ownerId, runId)).deadlineAt)).toBeLessThan(Date.now());
      await repo.cancel(ownerId, runId);
      await expect(repo.appendEvent(ownerId, runId, { type:'tool.completed',roleRunId:roleId,
        progress:true,payload:{toolName:'project_summary',success:true} })).rejects.toMatchObject({code:'RUN_NOT_ACTIVE'});
      await expect(repo.appendEvent(ownerId, runId, { type:'tool.output',roleRunId:roleId,progress:true,
        payload:{progressKind:'provider_retry',success:false,retryRequestNumber:3,retryAttempt:2,retryMaxAttempts:6,retryDelayMs:2000} }))
        .rejects.toMatchObject({code:'RUN_NOT_ACTIVE'});
    } finally {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        if (runId) {
          await client.query('DELETE FROM nano.run_events WHERE run_id=$1', [runId]);
          await client.query('DELETE FROM nano.messages WHERE run_id=$1', [runId]);
          await client.query('DELETE FROM nano.role_runs WHERE run_id=$1', [runId]);
          await client.query('DELETE FROM nano.runs WHERE id=$1', [runId]);
          await client.query('DELETE FROM nano.model_credential_leases WHERE reference_id=$1', [runId]);
        }
        if (projectId) await client.query('DELETE FROM nano.projects WHERE id=$1', [projectId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); await admin.end(); await database.close(); }
    }
  }, 120_000);
});
