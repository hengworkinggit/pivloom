import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createModelProfileService } from "../../src/models/service.js";
import { createCredentialVault } from "../../src/models/credentials.js";
import { createGenerationRepository } from "../../src/data/generation.js";
import { createGenerationScheduler } from "../../src/generation/scheduler.js";

/**
 * Real PostgreSQL queue acceptance. The executor is controlled by this test: it
 * records what the scheduler hands over and never calls a provider or a sandbox.
 * Capacity, claim competition, fairness, per-project serialization, restart
 * recovery and baseline freezing all run against the migrated schema.
 */
describe.skipIf(process.env.PIVLOOM_QUEUE_INTEGRATION !== "1")("durable generation queue", () => {
  let database: PivloomDatabase;
  let admin: Pool;
  let models: ReturnType<typeof createModelProfileService>;
  let ownerA: string;
  let ownerB: string;
  const profiles = new Map<string, { id: string; configVersion: number }>();
  const projectIds: string[] = [];
  const sandboxIds: string[] = [];
  const prefix = `queue-fixture-${randomUUID()}`;
  let manifestPath: string;

  function repository(maxSandboxes: number, bootId = randomUUID(), onCommittedEvent?: (ownerId: string, event: { type: string; payload: unknown }) => void) {
    // The daily acceptance quota is a product rule, not what this suite tests:
    // several cases deliberately queue more than the production default of 20
    // requests per owner, so the fixture states its own ceiling explicitly.
    return createGenerationRepository(database, models, {
      executorBootId: bootId, maxSandboxes, dailyLimitByOwner: { [ownerA]: 1000, [ownerB]: 1000 },
      ...(onCommittedEvent ? { onCommittedEvent: (ownerId, event) => { onCommittedEvent(ownerId, event); } } : {}),
    });
  }

  beforeAll(async () => {
    const environmentId = process.env.PIVLOOM_ENVIRONMENT_ID;
    if (!environmentId || !process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL
      || !process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY) throw Error("Explicit queue integration target required");
    const identity = JSON.parse(await readFile(resolve("../../.cache/identity", environmentId, "manifest.json"), "utf8"));
    if (identity.environmentId !== environmentId) throw Error("Identity manifest mismatch");
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
    const target = await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true");
    if (target.rows[0]?.environment_id !== environmentId) throw Error("Database target mismatch");
    const migrated = await admin.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname='claim_next_queued_run'");
    if (migrated.rows[0].n !== 1) throw Error("Queue migration 020 is not applied to this database");
    database = new PivloomDatabase(process.env.DATABASE_URL);
    models = createModelProfileService(database, createCredentialVault(process.env.MODEL_CREDENTIALS_ENCRYPTION_KEY));
    // Any two existing owners whose default configuration was really verified
    // (streaming, tools and image) can queue work. Their provider is never
    // called: the scheduler hands claimed runs to this test instead.
    const capable = await admin.query(`SELECT p.owner_id, p.id, p.current_version
      FROM nano.model_profiles p
      JOIN nano.model_profile_versions v ON v.profile_id=p.id AND v.config_version=p.current_version
      WHERE p.is_default AND v.capabilities->>'streaming'='verified' AND v.capabilities->>'tools'='verified'
        AND v.capabilities->>'vision'='verified'
        AND EXISTS (SELECT 1 FROM nano.model_credentials c WHERE c.profile_id=p.id AND c.config_version=p.current_version)
      ORDER BY p.owner_id`);
    const owners = [...new Set(capable.rows.map((row) => row.owner_id as string))];
    if (owners.length < 2) throw Error("Two owners with a really verified default profile are required; no capability fixture is substituted");
    ownerA = owners[0];
    ownerB = owners[1];
    for (const row of capable.rows)
      if (!profiles.has(row.owner_id)) profiles.set(row.owner_id, { id: row.id, configVersion: row.current_version });
    const directory = resolve("../../.cache/generation", environmentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    manifestPath = resolve(directory, `${prefix}.json`);
    await saveManifest();
  }, 30_000);

  async function saveManifest() {
    await writeFile(manifestPath, JSON.stringify({ prefix, ownerA, ownerB, projectIds, sandboxIds }, null, 2), { mode: 0o600 });
  }

  async function project(owner = ownerA) {
    const created = await createProjectRepository(database).create(owner, prefix);
    projectIds.push(created.id);
    await saveManifest();
    return created.id;
  }

  // Each case starts from an empty queue: a task this test left waiting must not
  // change the ordering another case observes. The controlled executor creates no
  // remote resource, so settling these fixtures is exact.
  afterEach(async () => {
    if (!projectIds.length) return;
    await admin.query(`UPDATE nano.runs SET state='cancelled',phase='cleanup',cleanup_state='confirmed',
      error_code='CANCELLED',error_message='queue fixture reset',error_retryable=true,finished_at=coalesce(finished_at,now())
      WHERE project_id=ANY($1::uuid[]) AND state IN ('queued','accepted','planning','building','verifying','repairing','finalizing','cancel_requested')`,
    [projectIds]);
    await admin.query(`UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL
      WHERE id=ANY($1::uuid[]) AND operation_id IS NOT NULL`, [projectIds]);
  });

  const request = (text = "生成活动报名页面", owner = ownerA) => {
    const profile = profiles.get(owner);
    if (!profile) throw Error("Fixture owner has no verified model configuration");
    return { idempotencyKey: randomUUID(), text, expectedCurrentRevisionId: null,
      modelProfileId: profile.id, modelConfigVersion: profile.configVersion };
  };

  /** One live sandbox row is a real occupied slot, exactly as production counts it. */
  async function occupy(owner: string, projectId: string, count = 1) {
    const repository_ = repository(2);
    for (let index = 0; index < count; index += 1) {
      const accepted = await repository_.accept(owner, projectId, request("占位任务"));
      await repository_.finishCancelled(owner, accepted.run.id, { cleanupState: "confirmed", summary: "queue fixture capacity" });
      const remoteId = randomUUID();
      sandboxIds.push(remoteId);
      await admin.query(`INSERT INTO nano.sandboxes(owner_id,project_id,run_id,attempt,remote_id,purpose,state,expires_at)
        VALUES($1,$2,$3,0,$4,'preview','active',now()+interval '10 minutes')`,
      [owner, projectId, accepted.run.id, remoteId]);
    }
    await saveManifest();
  }

  /** Exactly what nano.reserve_generation_capacity counts as an occupied slot. */
  async function occupiedSlots() {
    const row = (await admin.query(`SELECT
      (SELECT count(*)::int FROM nano.sandboxes s
        WHERE s.state IN ('creating','active') AND s.expires_at > now())
      + (SELECT count(*)::int FROM nano.runs r
        WHERE r.state IN ('accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
          AND NOT EXISTS (SELECT 1 FROM nano.sandboxes s WHERE s.run_id=r.id
            AND s.state IN ('creating','active') AND s.expires_at > now())) AS occupied`)).rows[0];
    return row.occupied as number;
  }
  async function activeSandboxes() {
    return (await admin.query("SELECT count(*)::int AS n FROM nano.sandboxes WHERE state IN ('creating','active') AND expires_at > now()"))
      .rows[0].n as number;
  }

  afterAll(async () => {
    if (admin && projectIds.length) {
      const found = await admin.query("SELECT id FROM nano.projects WHERE id=ANY($1::uuid[]) AND title=$2", [projectIds, prefix]);
      if (found.rowCount !== projectIds.length) throw Error("Refusing cleanup: fixture ownership mismatch");
      await admin.query("BEGIN");
      try {
        await admin.query("SET CONSTRAINTS ALL DEFERRED");
        await admin.query("UPDATE nano.projects SET current_revision_id=NULL,operation_id=NULL,operation_kind=NULL WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.run_events WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.messages WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.sandboxes WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.checks WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.role_runs WHERE project_id=ANY($1::uuid[])", [projectIds]);
        await admin.query("DELETE FROM nano.revisions WHERE project_id=ANY($1::uuid[])", [projectIds]);
        const runs = await admin.query("DELETE FROM nano.runs WHERE project_id=ANY($1::uuid[]) RETURNING id", [projectIds]);
        await admin.query("DELETE FROM nano.model_credential_leases WHERE reference_id=ANY($1::uuid[])", [runs.rows.map((run) => run.id)]);
        await admin.query("DELETE FROM nano.projects WHERE id=ANY($1::uuid[])", [projectIds]);
        await admin.query("COMMIT");
      } catch (error) { await admin.query("ROLLBACK"); throw error; }
    }
    if (database) await database.close();
    await admin?.end();
  }, 60_000);

  test("a full capacity persists queued work instead of refusing it, and dispatch is atomic", async () => {
    const before = await occupiedSlots();
    const sandboxesBefore = await activeSandboxes();
    const filler = await project();
    await occupy(ownerA, filler, 1);
    const capacity = repository(before + 1);
    const target = await project();
    const input = request("容量已满时排队");
    const accepted = await capacity.accept(ownerA, target, input);
    expect(accepted.run.state).toBe("queued");
    expect(accepted.replayed).toBe(false);
    const stored = await admin.query("SELECT state, queued_at, dispatched_at, executor_boot_id FROM nano.runs WHERE id=$1", [accepted.run.id]);
    expect(stored.rows[0].state).toBe("queued");
    expect(stored.rows[0].queued_at).not.toBeNull();
    expect(stored.rows[0].dispatched_at).toBeNull();
    // No sandbox, no model call and no execution budget were consumed by waiting.
    expect((await admin.query("SELECT count(*)::int AS n FROM nano.sandboxes WHERE run_id=$1", [accepted.run.id])).rows[0].n).toBe(0);
    expect(await activeSandboxes()).toBe(sandboxesBefore + 1);
    expect(await capacity.claimNextQueuedRun(accepted.run.id)).toBeNull();
    // Replays and refreshes read the same durable task.
    const replayed = await capacity.accept(ownerA, target, input);
    expect(replayed.replayed).toBe(true);
    expect(replayed.run.id).toBe(accepted.run.id);
    expect((await admin.query("SELECT count(*)::int AS n FROM nano.runs WHERE project_id=$1", [target])).rows[0].n).toBe(1);
    // Releasing one real slot lets the scheduler claim the waiting task: the row,
    // the project operation lock and the slot move together.
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE remote_id=$1", [sandboxIds.at(-1)]);
    const claimed = await capacity.claimNextQueuedRun(accepted.run.id);
    expect(claimed?.state).toBe("accepted");
    const dispatched = await admin.query("SELECT r.state, r.dispatched_at, p.operation_id FROM nano.runs r JOIN nano.projects p ON p.id=r.project_id WHERE r.id=$1", [accepted.run.id]);
    expect(dispatched.rows[0].state).toBe("accepted");
    expect(dispatched.rows[0].dispatched_at).not.toBeNull();
    expect(dispatched.rows[0].operation_id).toBe(accepted.run.id);
    // A second claimer cannot take the same task twice.
    expect(await capacity.claimNextQueuedRun(accepted.run.id)).toBeNull();
    await capacity.finishCancelled(ownerA, accepted.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
  }, 120_000);

  test("cancelling a queued task is immediate, durable and never dispatched", async () => {
    const before = await occupiedSlots();
    const filler = await project();
    await occupy(ownerA, filler, 1);
    const capacity = repository(before + 1);
    const target = await project();
    const accepted = await capacity.accept(ownerA, target, request("取消排队"));
    const cancelled = await capacity.cancel(ownerA, accepted.run.id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.cleanupState).toBe("confirmed");
    expect(cancelled.finishedAt).not.toBeNull();
    expect(await capacity.claimNextQueuedRun(accepted.run.id)).toBeNull();
    expect((await capacity.getRun(ownerA, accepted.run.id)).state).toBe("cancelled");
    // The preserved request keeps its message and a result, and the terminal
    // state is idempotent.
    expect((await capacity.listProjectMessages(ownerA, target)).map((message) => message.kind).sort()).toEqual(["result", "user"]);
    expect((await capacity.cancel(ownerA, accepted.run.id)).state).toBe("cancelled");
    expect((await capacity.listTasks(ownerA)).find((task) => task.runId === accepted.run.id)).toMatchObject({
      state: "cancelled", queuedAt: null, queuePosition: null, cancelable: false,
    });
  }, 120_000);

  test("a parked task can really be retried, while a task awaiting an answer cannot", async () => {
    const capacity = repository(await occupiedSlots() + 2);
    const target = await project();
    const parked = await capacity.accept(ownerA, target, request("被保留的任务"));
    const preserved = await capacity.parkQueuedRun(ownerA, parked.run.id, { code: "MODEL_NOT_VERIFIED", message: "模型配置需要重新测试。" });
    // The message promises a retry, so the retry entry must exist.
    expect(preserved.state).toBe("needs_input");
    expect(preserved.error?.retryable).toBe(true);
    const retried = await capacity.accept(ownerA, target, { ...request("被保留的任务"), retryOfRunId: parked.run.id,
      expectedCurrentRevisionId: null });
    expect(retried.run.retryOfRunId).toBe(parked.run.id);
    expect(retried.run.state).toBe("queued");
    await capacity.finishCancelled(ownerA, retried.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
    // A task that is waiting for the user's answer must be answered instead.
    const asking = await capacity.accept(ownerA, target, request("需要澄清的任务"));
    await admin.query("UPDATE nano.runs SET state='needs_input',clarification_json=$2 WHERE id=$1",
      [asking.run.id, { question: "需要几个页面？" }]);
    await expect(capacity.accept(ownerA, target, { ...request("需要澄清的任务"), retryOfRunId: asking.run.id, expectedCurrentRevisionId: null }))
      .rejects.toMatchObject({ code: "INVALID_RETRY_PARENT" });
  }, 120_000);

  test("a retry of a chained task still reuses its saved candidate", async () => {
    const capacity = repository(await occupiedSlots() + 2);
    const target = await project();
    // The failed predecessor: it saved a candidate and ended on a blocked check.
    const prior = await capacity.accept(ownerA, target, request("会被复用的任务"));
    const resultRevisionId = randomUUID();
    // The candidate revision has to exist before the run can point at it.
    await admin.query(`INSERT INTO nano.revisions(id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,
        template_version,manifest_json,source_bytes,compressed_bytes,build_status,build_json,status)
      VALUES($1,$2,$3,$4,1,0,$5,$6,'fixture','[]'::jsonb,1,1,'passed','{}'::jsonb,'candidate')`,
    [resultRevisionId, ownerA, target, prior.run.id, `${ownerA}/${target}/fixture.tar.gz`, "b".repeat(64)]);
    await admin.query(`UPDATE nano.runs SET state='failed',error_code='CHECK_BLOCKED',
        result_revision_id=$2,plan_json=$3,expected_current_revision_id=NULL,base_revision_id=NULL,finished_at=now()
      WHERE id=$1`, [prior.run.id, resultRevisionId, {
      schemaVersion: 2, goal: "复用已保存候选", changeSummary: "夹具计划",
      assumptions: [], outOfScope: [],
      behaviors: [1, 2, 3, 4, 5].map((index) => ({ id: `B0${index}`, title: `行为 ${index}`, precondition: "已打开页面",
        action: "点击按钮", expected: "界面正确响应", required: true })),
      groups: [1, 2, 3, 4, 5].map((index) => ({ id: `G${index}`, title: `组 ${index}`, behaviorIds: [`B0${index}`] })),
      replacements: [],
    }]);
    const reviewerRoleId = randomUUID();
    await admin.query("INSERT INTO nano.role_runs(id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json,started_at) VALUES($1,$2,$3,$4,'reviewer',0,$5,'failed','{}'::jsonb,now())",
      [reviewerRoleId, ownerA, target, prior.run.id, randomUUID()]);
    await admin.query(`INSERT INTO nano.checks(id,owner_id,project_id,run_id,role_run_id,attempt,revision_id,source_hash,
        sandbox_id,browser_session_id,verdict,items_json,artifacts_json,evidence_json,summary)
      VALUES($1,$2,$3,$4,$5,0,$6,$7,'fixture-sandbox',$8,'blocked','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'fixture')`,
    [randomUUID(), ownerA, target, prior.run.id, reviewerRoleId, resultRevisionId, "b".repeat(64), randomUUID()]);
    // The retry is queued behind a follow-up, so dispatch rewrites its baseline
    // the way a chained task is rewritten. The reuse decision must survive that.
    const queued = await capacity.accept(ownerA, target, { ...request("会被复用的任务"), retryOfRunId: prior.run.id,
      expectedCurrentRevisionId: null });
    const claimed = await capacity.claimNextQueuedRun(queued.run.id);
    expect(claimed?.state).toBe("accepted");
    const prepared = await capacity.prepareDispatch(ownerA, queued.run.id);
    expect(prepared.outcome).toBe("ready");
    // Dispatch kept the retry linked to its predecessor's base, so the saved
    // candidate is still reusable instead of forcing a full rebuild.
    const candidate = await capacity.getReviewRetryCandidate(ownerA, queued.run.id, prior.run.id);
    expect(candidate).not.toBeNull();
    await capacity.finishCancelled(ownerA, queued.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
  }, 120_000);

  test("a claim publishes a durable dispatch event so a waiting client stops reading queued", async () => {
    const before = await occupiedSlots();
    const filler = await project();
    await occupy(ownerA, filler, 1);
    // The claim writes the dispatch event on the dispatch connection rather than
    // a caller transaction, so it has to publish it itself; an already-open
    // stream would otherwise keep showing "已排队" until the next phase update.
    const published: { ownerId: string; type: string; payload: Record<string, unknown> }[] = [];
    const capacity = repository(before + 1, randomUUID(), (ownerId, event) => {
      published.push({ ownerId, type: event.type, payload: event.payload as Record<string, unknown> });
    });
    const target = await project();
    const accepted = await capacity.accept(ownerA, target, request("派发事件"));
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE remote_id=$1", [sandboxIds.at(-1)]);
    published.length = 0;
    const claimed = await capacity.claimNextQueuedRun(accepted.run.id);
    expect(claimed?.state).toBe("accepted");
    expect(published.filter((entry) => entry.type === "run.accepted" && entry.payload.dispatched === true))
      .toEqual([{ ownerId: ownerA, type: "run.accepted", payload: { state: "accepted", phase: "plan", dispatched: true } }]);
    // Waiting is only observable through this event: without it a streaming
    // client would keep showing "已排队" until the next phase update arrives.
    const events = await admin.query("SELECT type, payload_json FROM nano.run_events WHERE run_id=$1 ORDER BY id", [accepted.run.id]);
    const dispatch = events.rows.filter((row) => row.type === "run.accepted").map((row) => row.payload_json);
    expect(dispatch.some((payload) => payload.dispatched === true && payload.state === "accepted")).toBe(true);
    // A queued task never advertised a deadline it could not meet while waiting.
    const timing = await admin.query("SELECT deadline_at > queued_at AS deadline_after_queue FROM nano.runs WHERE id=$1", [accepted.run.id]);
    expect(timing.rows[0].deadline_after_queue).toBe(true);
    await capacity.finishCancelled(ownerA, accepted.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
  }, 120_000);

  test("a claim whose handoff never finished is recovered instead of holding the project and slot until restart", async () => {
    const before = await occupiedSlots();
    const capacity = repository(before + 1);
    const target = await project();
    const accepted = await capacity.accept(ownerA, target, request("派发中断"));
    // Claim it and then stop: this is what the scheduler leaves behind when
    // prepareDispatch throws and parking that same claim also fails.
    const claimed = await capacity.claimNextQueuedRun(accepted.run.id);
    expect(claimed?.state).toBe("accepted");
    expect((await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [target])).rows[0].operation_id).toBe(accepted.run.id);
    // Nothing recovers a fresh claim: the handoff may still be in flight.
    expect(await capacity.recoverStrandedClaims()).toEqual([]);
    await admin.query("UPDATE nano.runs SET dispatched_at = now() - interval '10 minutes' WHERE id=$1", [accepted.run.id]);
    const recovered = await capacity.recoverStrandedClaims();
    expect(recovered.map((run) => run.id)).toEqual([accepted.run.id]);
    const after = await admin.query("SELECT r.state, r.error_code, r.cleanup_state, p.operation_id FROM nano.runs r JOIN nano.projects p ON p.id=r.project_id WHERE r.id=$1", [accepted.run.id]);
    expect(after.rows[0].state).toBe("needs_input");
    expect(after.rows[0].error_code).toBe("QUEUE_DISPATCH_STALLED");
    expect(after.rows[0].cleanup_state).toBe("confirmed");
    // The project lock is released and the slot is free again, so the queue keeps
    // advancing without waiting for a service restart.
    expect(after.rows[0].operation_id).toBeNull();
    expect(await capacity.recoverStrandedClaims()).toEqual([]);
    const next = await project();
    const following = await capacity.accept(ownerA, next, request("回收后继续"));
    expect((await capacity.claimNextQueuedRun(following.run.id))?.state).toBe("accepted");
    await capacity.finishCancelled(ownerA, following.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
  }, 120_000);

  test("preview restore and rollback take a slot from the same ledger instead of overselling it", async () => {
    const before = await occupiedSlots();
    const filler = await project();
    await occupy(ownerA, filler, 1);
    const capacity = repository(before + 1);
    const target = await project();
    const accepted = await capacity.accept(ownerA, target, request("容量账本"));
    // The one slot this ceiling allows is already held by the live preview, so
    // the restore/rollback path must be refused rather than add a second sandbox.
    await expect(capacity.reserveCapacity(ownerA)).rejects.toMatchObject({ code: "SERVICE_BUSY" });
    // A queued generation task waits for that same slot instead of adding one.
    expect(await capacity.claimNextQueuedRun(accepted.run.id)).toBeNull();
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE remote_id=$1", [sandboxIds.at(-1)]);
    // Once the preview is gone the slot is collectable again and the waiting task
    // is dispatchable: both paths draw on one ceiling.
    await expect(capacity.reserveCapacity(ownerA)).resolves.toBeUndefined();
    const claimed = await capacity.claimNextQueuedRun(accepted.run.id);
    expect(claimed?.state).toBe("accepted");
    await capacity.finishCancelled(ownerA, accepted.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
  }, 120_000);

  test("the project list reports the real task state and the scheduler's own position", async () => {
    const projects = createProjectRepository(database);
    const idle = await project();
    const waiting = await project();
    const busy = await project();
    const before = await occupiedSlots();
    // One slot for this fixture: the first task runs, its sibling and the other
    // project's task have to wait.
    const capacity = repository(before + 1);
    const running = await capacity.accept(ownerA, busy, request("列表状态：执行中"));
    expect((await capacity.claimNextQueuedRun(running.run.id))?.state).toBe("accepted");
    await capacity.accept(ownerA, waiting, request("列表状态：排队"));
    const published = (await projects.list(ownerA, 50)).projects;
    const byId = new Map(published.map((entry) => [entry.id, entry]));
    // An idle project states nothing about tasks and keeps its saved-version copy.
    expect(byId.get(idle)?.activeRunState).toBeNull();
    expect(byId.get(idle)?.activeRunPosition).toBeNull();
    // The claimed task is running; the other project's task is really waiting and
    // reports the position the scheduler would dispatch it in (1 = next).
    expect(byId.get(busy)?.activeRunState).toBe("accepted");
    expect(byId.get(busy)?.activeRunPosition).toBeNull();
    expect(byId.get(waiting)?.activeRunState).toBe("queued");
    expect(byId.get(waiting)?.activeRunPosition).toBe(1);
    await capacity.finishCancelled(ownerA, running.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
  }, 120_000);

  test("one project stays serial even with free capacity, and dispatch rotates between owners", async () => {
    const before = await occupiedSlots();
    // Two free slots: the sibling task must wait for its project, not for capacity.
    const capacity = repository(before + 2);
    const shared = await project();
    const queuedOne = await capacity.accept(ownerA, shared, request("同一项目的第一个需求"));
    const queuedTwo = await capacity.accept(ownerA, shared, request("同一项目的第二个需求"));
    expect([queuedOne.run.state, queuedTwo.run.state]).toEqual(["queued", "queued"]);
    const waiting = (await capacity.listTasks(ownerA)).filter((task) => task.state === "queued");
    expect(waiting.map((task) => task.runId).sort()).toEqual([queuedOne.run.id, queuedTwo.run.id].sort());
    expect(waiting.every((task) => typeof task.queuePosition === "number" && task.queuePosition! >= 1)).toBe(true);
    const first = await capacity.claimNextQueuedRun();
    expect(first?.id).toBe(queuedOne.run.id);
    expect(await occupiedSlots()).toBe(before + 1);
    expect(await capacity.claimNextQueuedRun(queuedTwo.run.id)).toBeNull();
    await capacity.finishCancelled(ownerA, queuedOne.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
    const second = await capacity.claimNextQueuedRun();
    expect(second?.id).toBe(queuedTwo.run.id);
    await capacity.finishCancelled(ownerA, queuedTwo.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
  }, 120_000);

  test("a single account with a backlog cannot starve another account", async () => {
    const before = await occupiedSlots();
    const filler = await project();
    await occupy(ownerA, filler, 1);
    const capacity = repository(before + 1);
    const backlogA = await project();
    const otherB = await project(ownerB);
    const firstA = await capacity.accept(ownerA, backlogA, request("第一个账号的排队需求"));
    const secondA = await capacity.accept(ownerA, backlogA, request("第一个账号的后续需求"));
    const firstB = await capacity.accept(ownerB, otherB, request("第二个账号的需求", ownerB));
    // Accounts only ever see their own tasks.
    expect((await capacity.listTasks(ownerB)).map((task) => task.runId)).toContain(firstB.run.id);
    expect((await capacity.listTasks(ownerB)).map((task) => task.runId)).not.toContain(firstA.run.id);
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE remote_id=$1", [sandboxIds.at(-1)]);
    // Three dispatch rounds: the other account's task must be served before the
    // backlog account's second task, whichever account happens to start.
    const order: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const served = await capacity.claimNextQueuedRun();
      expect(served).not.toBeNull();
      order.push(served!.id);
      await capacity.finishCancelled(served!.ownerId, served!.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
    }
    expect(new Set(order)).toEqual(new Set([firstA.run.id, secondA.run.id, firstB.run.id]));
    expect(order.indexOf(firstB.run.id)).toBeLessThan(order.indexOf(secondA.run.id));
  }, 120_000);

  test("a queued task survives a restart, and two executors cannot claim it twice", async () => {
    const before = await occupiedSlots();
    const filler = await project();
    await occupy(ownerA, filler, 1);
    const capacity = repository(before + 1);
    const target = await project();
    const accepted = await capacity.accept(ownerA, target, request("重启后仍在队列"));
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE remote_id=$1", [sandboxIds.at(-1)]);
    // A new process with a new boot id resumes from the persisted row alone.
    const restart = repository(before + 1, randomUUID());
    const [left, right] = await Promise.all([restart.claimNextQueuedRun(accepted.run.id), capacity.claimNextQueuedRun(accepted.run.id)]);
    const winners = [left, right].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(accepted.run.id);
    expect((await capacity.getRun(ownerA, accepted.run.id)).state).toBe("accepted");
    await capacity.finishCancelled(ownerA, accepted.run.id, { cleanupState: "confirmed", summary: "queue fixture complete" });
  }, 120_000);

  test("the scheduler dispatches when a slot frees and parks a task it cannot prepare", async () => {
    const before = await occupiedSlots();
    const filler = await project();
    await occupy(ownerA, filler, 1);
    const capacity = repository(before + 1);
    const target = await project();
    const accepted = await capacity.accept(ownerA, target, request("调度器派发"));
    const started: string[] = [];
    const scheduler = createGenerationScheduler({ repository: capacity, start: (run) => { started.push(run.id); }, sweepMs: 60_000 });
    expect(await scheduler.tick()).toBe(0);
    expect(started).toEqual([]);
    await admin.query("UPDATE nano.sandboxes SET state='destroyed' WHERE remote_id=$1", [sandboxIds.at(-1)]);
    expect(await scheduler.tick()).toBe(1);
    expect(started).toEqual([accepted.run.id]);
    await scheduler.close();
    // A task that cannot be prepared is preserved with a reason instead of being
    // dropped, and it stops holding the project lock.
    const parked = await capacity.parkQueuedRun(ownerA, accepted.run.id, { code: "QUEUE_BASELINE_CHANGED", message: "项目基线已改变，请确认后重新提交。" });
    expect(parked.state).toBe("needs_input");
    expect(parked.error).toMatchObject({ code: "QUEUE_BASELINE_CHANGED" });
    const released = await admin.query("SELECT operation_id FROM nano.projects WHERE id=$1", [target]);
    expect(released.rows[0].operation_id).toBeNull();
    const events = await capacity.listEvents(ownerA, accepted.run.id);
    expect(events.at(-1)?.type).toBe("run.finished");
    expect((await capacity.listProjectMessages(ownerA, target)).at(-1)?.content).toContain("项目基线已改变");
  }, 120_000);
});
