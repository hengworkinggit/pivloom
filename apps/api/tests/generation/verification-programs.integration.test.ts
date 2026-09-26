import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { GroupedPlanSchema, type GroupedPlan } from '@pivloom/contracts';
import { PivloomDatabase } from '../../src/data/database.js';
import { createGenerationRepository } from '../../src/data/generation.js';
import { createProjectRepository } from '../../src/data/projects.js';
import { createModelProfileService } from '../../src/models/service.js';
import { createCredentialVault } from '../../src/models/credentials.js';
import { createSourceStore } from '../../src/storage/source.js';
import { REACT_TEMPLATE_VERSION } from '../../src/runtime/snapshot.js';
import { VerificationProgramSpecSchema, verificationProgramHash, verificationRequirementHash,
  type VerificationProgramAsset } from '../../src/runtime/verification-program-contract.js';

describe.skipIf(process.env.PIVLOOM_VERIFICATION_PROGRAM_INTEGRATION !== '1')('immutable verification programs through the real repository', () => {
  const ownerA = randomUUID(), ownerB = randomUUID(), profileId = randomUUID();
  const prefix = `verification-program-fixture-${randomUUID()}`;
  let admin: Pool, database: PivloomDatabase, generation: ReturnType<typeof createGenerationRepository>;
  let targetVerified = false;
  const plan = GroupedPlanSchema.parse({ schemaVersion: 2, goal: '保存书名', changeSummary: '建立书名列表', assumptions: [], outOfScope: [],
    behaviors: Array.from({ length: 5 }, (_, index) => ({ id: `B0${index + 1}`, title: `书名操作 ${index + 1}`,
      precondition: '空书单已打开', action: '输入书名并点击添加', expected: `显示书名 ${index + 1}`, required: true })),
    groups: Array.from({ length: 5 }, (_, index) => ({ id: `G${index + 1}`, title: `书名分组 ${index + 1}`, behaviorIds: [`B0${index + 1}`] })),
    replacements: [] });
  const program = VerificationProgramSpecSchema.parse({ initialState: 'fresh', evidence: 'text',
    steps: [{ type: 'open', path: '/' }, { type: 'fill', role: 'textbox', name: '书名', text: '银河' }, { type: 'click', role: 'button', name: '添加' }],
    assertions: [{ kind: 'target-text', target: { role: 'list', name: '书单' }, text: '银河', match: 'contains', negated: false }] });
  const objects = new Map<string, Uint8Array>();
  const sources = createSourceStore({ url: 'http://fixture.invalid', secret: 'fixture', objects: {
    upload: async (key, bytes) => { objects.set(key, bytes); }, download: async key => objects.get(key)!, list: async () => [],
  } });

  beforeAll(async () => {
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environmentId || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL) throw Error('Explicit integration target required');
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
    if (!(await admin.query('SELECT current_database() AS name')).rows[0].name.startsWith('pivloom_e2e_test_')) throw Error('An isolated e2e database is required');
    if ((await admin.query('SELECT environment_id FROM nano.environment_identity WHERE id=true')).rows[0]?.environment_id !== environmentId) throw Error('Database target mismatch');
    targetVerified = true;
    database = new PivloomDatabase(process.env.DATABASE_URL);
    const vault = createCredentialVault(randomBytes(32).toString('base64'));
    const credential = vault.seal('fixture-only-unused-key', { ownerId: ownerA, profileId, version: 1 });
    await admin.query('BEGIN');
    try {
    await admin.query('INSERT INTO auth.users(id) VALUES($1),($2)', [ownerA, ownerB]);
    await admin.query('INSERT INTO nano.model_profiles(id,owner_id,current_version,is_default) VALUES($1,$2,1,true)', [profileId, ownerA]);
    await admin.query(`INSERT INTO nano.model_profile_versions(profile_id,owner_id,config_version,name,provider,base_url,model_id,key_mask,capabilities)
      VALUES($1,$2,1,'Verification fixture','openai-completions','https://fixture.invalid/v1','fixture','masked',
        '{"streaming":"verified","tools":"verified","vision":"verified"}')`, [profileId, ownerA]);
    await admin.query('INSERT INTO nano.model_credentials(profile_id,owner_id,config_version,ciphertext,nonce,auth_tag) VALUES($1,$2,1,$3,$4,$5)',
      [profileId, ownerA, credential.ciphertext, credential.nonce, credential.authTag]);
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
    generation = createGenerationRepository(database, createModelProfileService(database, vault), {
      executorBootId: randomUUID(), maxSandboxes: 20, dailyLimitByOwner: { [ownerA]: 1000 },
    });
  });

  async function planning(projectId: string, sealedPlan: GroupedPlan = plan, selectedBaseRevisionId?: string) {
    const accepted = await generation.accept(ownerA, projectId, { idempotencyKey: randomUUID(), text: '增加书名操作', expectedCurrentRevisionId: null,
      modelProfileId: profileId, modelConfigVersion: 1, ...(selectedBaseRevisionId ? { selectedBaseRevisionId } : {}) });
    const claimed = await generation.claimNextQueuedRun(accepted.run.id);
    if (!claimed || (await generation.prepareDispatch(ownerA, claimed.id)).outcome !== 'ready') throw Error('Fixture was not dispatched');
    const coordinator = await generation.startCoordinator(ownerA, claimed.id);
    return { run: claimed, coordinator, submit: () => generation.submitPlan(ownerA, claimed.id, { roleRunId: coordinator.id, attempt: 0, plan: sealedPlan }) };
  }

  async function reviewer(sealedPlan: GroupedPlan = plan) {
    const project = await createProjectRepository(database).create(ownerA, prefix);
    const pending = await planning(project.id, sealedPlan);
    await pending.submit();
    await generation.startBuilder(ownerA, pending.run.id);
    await generation.completeBuilder(ownerA, pending.run.id);
    const source = await sources.save({ ownerId: ownerA, projectId: project.id, revisionId: randomUUID() }, REACT_TEMPLATE_VERSION,
      [{ path: 'src/App.tsx', content: 'export default function App(){return <main>fixture</main>}' }]);
    const revision = await generation.saveCandidate(ownerA, pending.run.id, { source, buildStatus: 'passed', build: {
      schemaVersion: 1, sourceHash: source.sourceHash,
      typecheck: { command: 'node /workspace/node_modules/typescript/bin/tsc --noEmit', exitCode: 0, durationMs: 1, stdoutTail: '', stderrTail: '' },
      build: { command: 'node /workspace/node_modules/vite/bin/vite.js build', exitCode: 0, durationMs: 1, stdoutTail: '', stderrTail: '' },
    } });
    const sandbox = { sandboxId: `verification-program-${randomUUID()}`, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    await generation.registerSandbox(ownerA, pending.run.id, sandbox);
    await generation.bindPreview(ownerA, pending.run.id, { ...sandbox, revisionId: revision.id, sourceHash: revision.sourceHash,
      markerVerified: true, writeRevoked: true, chromeClosed: true });
    await generation.queueReviewer(ownerA, pending.run.id, { revisionId: revision.id });
    const execution = await generation.startReviewer(ownerA, pending.run.id);
    const asset: VerificationProgramAsset = { behaviorId: 'B01', requirementHash: verificationRequirementHash(sealedPlan.behaviors[0]),
      program, programHash: verificationProgramHash(program), sourceHash: revision.sourceHash };
    const input = { roleRunId: execution.role.id, attempt: 0, revisionId: revision.id, sourceHash: revision.sourceHash, assets: [asset] };
    return { project, run: pending.run, revision, asset, input };
  }

  afterEach(async () => {
    if (!targetVerified || !generation) return;
    for (const run of (await admin.query(`SELECT id,state FROM nano.runs WHERE owner_id=$1
      AND state IN ('queued','accepted','planning','building','verifying','repairing','finalizing','cancel_requested')`, [ownerA])).rows) {
      if (run.state === 'queued') await generation.cancel(ownerA, run.id);
      else await generation.finishFailed(ownerA, run.id, { code: 'FIXTURE_ENDED', message: 'No model or browser was invoked', retryable: false, cleanupState: 'confirmed' });
    }
  });

  afterAll(async () => {
    if (admin && targetVerified) {
      await admin.query('BEGIN');
      try {
        await admin.query('SET CONSTRAINTS ALL DEFERRED');
        await admin.query('UPDATE nano.projects SET current_revision_id=NULL,operation_id=NULL,operation_kind=NULL WHERE owner_id=ANY($1::uuid[])', [[ownerA, ownerB]]);
        if ((await admin.query("SELECT to_regclass('nano.verification_programs') AS relation")).rows[0].relation)
          await admin.query('DELETE FROM nano.verification_programs WHERE owner_id=ANY($1::uuid[])', [[ownerA, ownerB]]);
        for (const table of ['run_events', 'messages', 'sandboxes', 'role_runs', 'revisions', 'runs', 'model_credential_leases', 'projects', 'model_credentials', 'model_profile_versions', 'model_profiles'])
          await admin.query(`DELETE FROM nano.${table} WHERE owner_id=ANY($1::uuid[])`, [[ownerA, ownerB]]);
        await admin.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
        await admin.query('COMMIT');
      } catch (error) { await admin.query('ROLLBACK'); throw error; }
    }
    await database?.close(); await admin?.end();
  });

  test('a reviewer can save a source-bound program and load it for the same project requirement', async () => {
    const fixture = await reviewer();
    expect(await generation.saveVerificationPrograms(ownerA, fixture.run.id, fixture.input)).toEqual([fixture.asset]);
    expect(await generation.loadVerificationPrograms(ownerA, fixture.project.id, plan)).toEqual([fixture.asset]);
  });

  test('a later candidate continuation gives the saved program to planning and Builder without changing the requirement', async () => {
    const fixture = await reviewer();
    await generation.saveVerificationPrograms(ownerA, fixture.run.id, fixture.input);
    await generation.finishFailed(ownerA, fixture.run.id, { code: 'CHECK_BLOCKED', message: 'Explicit fixture ended', retryable: true, cleanupState: 'confirmed' });
    const continuation = await planning(fixture.project.id, plan, fixture.revision.id);
    const context = await generation.getPlanningContext(ownerA, continuation.run.id);
    expect(context.previousPlan?.behaviors[0]).toEqual({ ...plan.behaviors[0], ...program });
    const submitted = await continuation.submit();
    expect(submitted.handoff.plan.behaviors[0]).toEqual({ ...plan.behaviors[0], ...program });
    expect(submitted.run.plan?.behaviors[0]).toEqual({ ...plan.behaviors[0], ...program });
    expect((await generation.startBuilder(ownerA, continuation.run.id)).input?.plan.behaviors[0]).toEqual({ ...plan.behaviors[0], ...program });
  });

  test('owners and projects cannot borrow or mutate another project program', async () => {
    const fixture = await reviewer();
    await generation.saveVerificationPrograms(ownerA, fixture.run.id, fixture.input);
    await expect(generation.loadVerificationPrograms(ownerB, fixture.project.id, plan)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(generation.saveVerificationPrograms(ownerB, fixture.run.id, fixture.input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const otherProject = await createProjectRepository(database).create(ownerA, prefix);
    const otherOwnerProject = await createProjectRepository(database).create(ownerB, prefix);
    expect(await generation.loadVerificationPrograms(ownerA, otherProject.id, plan)).toEqual([]);
    expect(await generation.loadVerificationPrograms(ownerB, otherOwnerProject.id, plan)).toEqual([]);
    // The database boundary itself also enforces RLS and append-only privileges.
    const hidden = await database.owned(ownerB, client => client.query('SELECT behavior_id FROM nano.verification_programs WHERE project_id=$1', [fixture.project.id]));
    expect(hidden.rows).toEqual([]);
    await expect(database.owned(ownerA, client => client.query('UPDATE nano.verification_programs SET program_hash=$1 WHERE project_id=$2', ['a'.repeat(64), fixture.project.id])))
      .rejects.toMatchObject({ code: '42501' });
  });

  test('changed requirements cannot load or save an old program under their new meaning', async () => {
    const fixture = await reviewer();
    await generation.saveVerificationPrograms(ownerA, fixture.run.id, fixture.input);
    const changed = GroupedPlanSchema.parse({ ...plan, behaviors: [{ ...plan.behaviors[0], expected: '显示两个不同书名' }, ...plan.behaviors.slice(1)] });
    expect(await generation.loadVerificationPrograms(ownerA, fixture.project.id, changed)).toEqual([]);
    await expect(generation.saveVerificationPrograms(ownerA, fixture.run.id, { ...fixture.input,
      assets: [{ ...fixture.asset, requirementHash: verificationRequirementHash(changed.behaviors[0]) }] })).rejects.toMatchObject({ code: 'INVALID_VERIFICATION_PROGRAM' });
    expect(await generation.loadVerificationPrograms(ownerA, fixture.project.id, plan)).toEqual([fixture.asset]);
  });

  test('the first saved program wins even if a later compiler proposes different criteria', async () => {
    const fixture = await reviewer();
    await generation.saveVerificationPrograms(ownerA, fixture.run.id, fixture.input);
    const alternate = VerificationProgramSpecSchema.parse({ ...program,
      assertions: [{ kind: 'target-count', target: { role: 'listitem', within: { role: 'list', name: '书单' } }, count: 10, negated: false }] });
    expect(await generation.saveVerificationPrograms(ownerA, fixture.run.id, { ...fixture.input,
      assets: [{ ...fixture.asset, program: alternate, programHash: verificationProgramHash(alternate) }] })).toEqual([fixture.asset]);
    expect(await generation.loadVerificationPrograms(ownerA, fixture.project.id, plan)).toEqual([fixture.asset]);
  });

  test('program hashes, source versions and active reviewer identities are required before any write', async () => {
    const fixture = await reviewer();
    await expect(generation.saveVerificationPrograms(ownerA, fixture.run.id, { ...fixture.input, revisionId: randomUUID() })).rejects.toMatchObject({ code: 'REVIEW_BINDING_MISMATCH' });
    await expect(generation.saveVerificationPrograms(ownerA, fixture.run.id, { ...fixture.input, sourceHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'REVIEW_BINDING_MISMATCH' });
    await expect(generation.saveVerificationPrograms(ownerA, fixture.run.id, { ...fixture.input, attempt: 1 })).rejects.toMatchObject({ code: 'STALE_ATTEMPT' });
    await expect(generation.saveVerificationPrograms(ownerA, fixture.run.id, { ...fixture.input, roleRunId: randomUUID() })).rejects.toMatchObject({ code: 'STALE_ROLE' });
    await expect(generation.saveVerificationPrograms(ownerA, fixture.run.id, { ...fixture.input, assets: [{ ...fixture.asset, programHash: 'a'.repeat(64) }] })).rejects.toMatchObject({ code: 'INVALID_VERIFICATION_PROGRAM' });
    await expect(generation.saveVerificationPrograms(ownerA, fixture.run.id, { ...fixture.input, assets: [{ ...fixture.asset, sourceHash: 'b'.repeat(64) }] })).rejects.toMatchObject({ code: 'INVALID_VERIFICATION_PROGRAM' });
    expect(await generation.loadVerificationPrograms(ownerA, fixture.project.id, plan)).toEqual([]);
    await generation.cancel(ownerA, fixture.run.id);
    await expect(generation.saveVerificationPrograms(ownerA, fixture.run.id, fixture.input)).rejects.toMatchObject({ code: 'RUN_NOT_ACTIVE' });
    expect(await generation.loadVerificationPrograms(ownerA, fixture.project.id, plan)).toEqual([]);
  });

  test.each(['interactive', 'embedded'] as const)('cached programs preserve an existing %s plan', async kind => {
    const embedded = VerificationProgramSpecSchema.parse({ ...program,
      steps: [{ type: 'open', path: '/' }, { type: 'fill', role: 'textbox', name: '保留书名', text: '长江' }, { type: 'click', role: 'button', name: '保存书名' }],
      assertions: [{ kind: 'target-text', target: { role: 'list', name: '保留书单' }, text: '长江', match: 'contains', negated: false }] });
    const preservedPlan = GroupedPlanSchema.parse(kind === 'interactive' ? { ...plan, verificationMode: 'interactive' }
      : { ...plan, behaviors: [{ ...plan.behaviors[0], ...embedded }, ...plan.behaviors.slice(1)] });
    const fixture = await reviewer(preservedPlan);
    await generation.saveVerificationPrograms(ownerA, fixture.run.id, fixture.input);
    await generation.finishFailed(ownerA, fixture.run.id, { code: 'CHECK_BLOCKED', message: 'Explicit fixture ended', retryable: true, cleanupState: 'confirmed' });
    const continuation = await planning(fixture.project.id, preservedPlan, fixture.revision.id);
    expect((await generation.getPlanningContext(ownerA, continuation.run.id)).previousPlan).toEqual(preservedPlan);
    expect((await continuation.submit()).handoff.plan).toEqual(preservedPlan);
  });

  test('a repair Builder receives the program compiled after its original handoff', async () => {
    const fixture = await reviewer();
    await generation.saveVerificationPrograms(ownerA, fixture.run.id, fixture.input);
    // The failed Check transition is fixture setup; this test exercises the
    // repository's repair handoff, without starting a model or a browser.
    await admin.query("UPDATE nano.runs SET state='repairing',phase='implement' WHERE owner_id=$1 AND id=$2", [ownerA, fixture.run.id]);
    await admin.query("UPDATE nano.role_runs SET state='succeeded',finished_at=now() WHERE owner_id=$1 AND id=$2", [ownerA, fixture.input.roleRunId]);
    const repair = await generation.startRepairBuilder(ownerA, fixture.run.id, { attempt: 1, previousRevisionId: fixture.revision.id, failedChecks: ['书单没有显示银河'] });
    expect(repair.input?.plan.behaviors[0]).toEqual({ ...plan.behaviors[0], ...program });
  });
});
