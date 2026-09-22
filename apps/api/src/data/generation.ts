import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  CreateRunRequestSchema, ProjectMessageSchema, ProjectSummarySchema, RevisionSchema, RunEventSchema, RunSchema,
  TerminalRunStates, type CreateRunRequest, type ProjectMessage, type ProjectSummary, type Revision,
  type Run, type RunEvent, type RunEventType, type RunPhase, type RunState,
} from "@pivloom/contracts";
import { z } from "zod";
import type { PivloomDatabase } from "./database.js";
import type { ModelProfileService } from "../models/service.js";
import { ApiFailure } from "../routes/errors.js";
import { assertVerifiedSourceSnapshot, type SourceReference, type VerifiedSourceSnapshot } from "../storage/source.js";

export interface StoredRun extends Run {
  ownerId: string;
  credentialLeaseId: string;
  executorBootId: string;
  builderRoleRunId: string;
  expectedCurrentRevisionId: string | null;
}
export interface StoredRevision extends Revision { ownerId: string; source: SourceReference; build: Record<string, unknown> }
export interface StoredRoleRun {
  id: string; runId: string; role: "builder"; attempt: number; sessionId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
}
export interface StoredSandboxBinding {
  id: string; ownerId: string; projectId: string; runId: string; attempt: number; sandboxId: string;
  revisionId: string | null; sourceHash: string | null;
  purpose: "candidate" | "candidate-preview" | "preview";
  state: "creating" | "active" | "expired" | "destroying" | "destroyed" | "error";
  expiresAt: string; error: string | null;
}
export interface RunReadSnapshot {
  run: StoredRun; revision: StoredRevision | null; events: RunEvent[]; binding: StoredSandboxBinding | null;
}
export interface ProjectReadSnapshot {
  project: ProjectSummary; messages: ProjectMessage[]; currentRevision: StoredRevision | null;
  latestCandidate: StoredRevision | null; latestRun: StoredRun | null; binding: StoredSandboxBinding | null;
}
export type AcceptRunInput = Omit<CreateRunRequest, "retryOfRunId" | "parentRunId"> & {
  idempotencyKey: string; retryOfRunId?: string | null; parentRunId?: string | null;
};
export interface FinishFailedInput {
  code: string; message: string; retryable: boolean; summary?: string;
  resultRevisionId?: string | null; cleanupState: Run["cleanupState"];
}
export interface AppendEventInput { type: RunEventType; payload: Record<string, unknown>; roleRunId?: string | null; attempt?: number }
export interface CandidateInput {
  source: VerifiedSourceSnapshot; buildStatus: "passed" | "failed"; build: Record<string, unknown>;
}
export interface PreviewBindingInput {
  sandboxId: string; revisionId: string; sourceHash: string; expiresAt: string;
  markerVerified: true; writeRevoked: true; chromeClosed: true;
}
export interface GenerationRepository {
  accept(ownerId: string, projectId: string, input: AcceptRunInput): Promise<{ run: StoredRun; replayed: boolean }>;
  readRunSnapshot(ownerId: string, runId: string): Promise<RunReadSnapshot>;
  readProjectSnapshot(ownerId: string, projectId: string): Promise<ProjectReadSnapshot>;
  getRun(ownerId: string, runId: string): Promise<StoredRun>;
  getLatestRun(ownerId: string, projectId: string): Promise<StoredRun | null>;
  listProjectMessages(ownerId: string, projectId: string): Promise<ProjectMessage[]>;
  listProjectRevisions(ownerId: string, projectId: string): Promise<StoredRevision[]>;
  listEvents(ownerId: string, runId: string, after?: string, limit?: number): Promise<RunEvent[]>;
  appendEvent(ownerId: string, runId: string, input: AppendEventInput): Promise<RunEvent>;
  setPhase(ownerId: string, runId: string, input: { phase: RunPhase; state?: RunState }): Promise<StoredRun>;
  startBuilder(ownerId: string, runId: string): Promise<StoredRoleRun>;
  completeBuilder(ownerId: string, runId: string, input?: { summary?: string; usage?: Record<string, unknown> }): Promise<StoredRoleRun>;
  saveCandidate(ownerId: string, runId: string, input: CandidateInput): Promise<StoredRevision>;
  getRevision(ownerId: string, revisionId: string): Promise<StoredRevision>;
  registerSandbox(ownerId: string, runId: string, input: { sandboxId: string; expiresAt: string; state?: "creating" | "active" }): Promise<StoredSandboxBinding>;
  bindPreview(ownerId: string, runId: string, input: PreviewBindingInput): Promise<StoredSandboxBinding>;
  getPreviewBinding(ownerId: string, projectId: string, revisionId: string): Promise<StoredSandboxBinding | null>;
  markDestroyed(ownerId: string, runId: string, sandboxId: string): Promise<void>;
  markCleanupPending(ownerId: string, runId: string, message: string): Promise<StoredRun>;
  confirmCleanup(ownerId: string, runId: string): Promise<StoredRun>;
  finishFailed(ownerId: string, runId: string, input: FinishFailedInput): Promise<StoredRun>;
  listReferencedSourceKeys(ownerId: string, projectId: string): Promise<string[]>;
}

type Row = QueryResultRow;
const notFound = () => new ApiFailure(404, "NOT_FOUND", "找不到这个项目资源。");
const date = (value: Date | string) => value instanceof Date ? value : new Date(value);
function storedProject(row: Row): ProjectSummary {
  return ProjectSummarySchema.parse({ id: row.id, title: row.title, currentRevisionId: row.current_revision_id,
    createdAt: date(row.created_at).toISOString(), updatedAt: date(row.updated_at).toISOString() });
}
function storedMessage(row: Row): ProjectMessage {
  return ProjectMessageSchema.parse({ id: row.id, projectId: row.project_id, runId: row.run_id,
    kind: row.kind, content: row.content, createdAt: date(row.created_at).toISOString() });
}
function storedRun(row: Row): StoredRun {
  return { ...RunSchema.parse({
    id: row.id, projectId: row.project_id, state: row.state, phase: row.phase, attempt: row.attempt,
    requestText: row.request_text, modelProfileId: row.model_profile_id, modelConfigVersion: row.model_config_version,
    baseRevisionId: row.base_revision_id, resultRevisionId: row.result_revision_id,
    createdAt: date(row.created_at).toISOString(), deadlineAt: date(row.deadline_at).toISOString(), finishedAt: row.finished_at ? date(row.finished_at).toISOString() : null,
    cleanupState: row.cleanup_state, summary: row.summary,
    error: row.error_code ? { code: row.error_code, message: row.error_message, retryable: row.error_retryable } : null,
  }), ownerId: row.owner_id, credentialLeaseId: row.credential_lease_id, executorBootId: row.executor_boot_id,
    builderRoleRunId: row.builder_role_run_id, expectedCurrentRevisionId: row.expected_current_revision_id };
}
function storedEvent(row: Row): RunEvent {
  return RunEventSchema.parse({ schemaVersion: 1, eventId: String(row.id), runId: row.run_id,
    roleRunId: row.role_run_id, attempt: row.attempt, type: row.type, createdAt: date(row.created_at).toISOString(), payload: row.payload_json });
}
function storedRevision(row: Row): StoredRevision {
  const publicRevision = RevisionSchema.parse({ id: row.id, projectId: row.project_id, runId: row.run_id,
    revisionNo: row.revision_no, attempt: row.attempt, sourceHash: row.source_hash, templateVersion: row.template_version,
    buildStatus: row.build_status, status: row.status, createdAt: date(row.created_at).toISOString(), manifest: row.manifest_json });
  return { ...publicRevision, ownerId: row.owner_id, build: row.build_json, source: {
    ownerId: row.owner_id, projectId: row.project_id, revisionId: row.id, key: row.source_key,
    sourceHash: row.source_hash, templateVersion: row.template_version, manifest: row.manifest_json,
    sourceBytes: row.source_bytes, compressedBytes: row.compressed_bytes,
  } };
}
function storedRole(row: Row): StoredRoleRun {
  return { id: row.id, runId: row.run_id, role: row.role, attempt: row.attempt, sessionId: row.session_id, state: row.state };
}
function storedSandbox(row: Row): StoredSandboxBinding {
  return { id: row.id, ownerId: row.owner_id, projectId: row.project_id, runId: row.run_id, attempt: row.attempt,
    sandboxId: row.remote_id, revisionId: row.revision_id, sourceHash: row.source_hash, purpose: row.purpose,
    state: row.state === "active" && date(row.expires_at).getTime() <= Date.now() ? "expired" : row.state,
    expiresAt: date(row.expires_at).toISOString(), error: row.error_message };
}
function boundedJson(value: Record<string, unknown>, max = 16 * 1024) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > max) throw new ApiFailure(422, "EVENT_TOO_LARGE", "执行记录超过大小限制。");
  return value;
}

export function createGenerationRepository(
  database: Pick<PivloomDatabase, "owned">,
  models: ModelProfileService,
  options: { executorBootId: string; hasSandboxCapacity?: () => boolean },
): GenerationRepository {
  async function project(client: PoolClient, ownerId: string, projectId: string, lock = false) {
    const result = await client.query(`SELECT * FROM nano.projects WHERE owner_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [ownerId, projectId]);
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }
  async function run(client: PoolClient, ownerId: string, runId: string) {
    const result = await client.query("SELECT * FROM nano.runs WHERE owner_id=$1 AND id=$2", [ownerId, runId]);
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }
  async function lockedRun(client: PoolClient, ownerId: string, runId: string, active = true) {
    const initial = await run(client, ownerId, runId);
    const parent = await project(client, ownerId, initial.project_id, true);
    const current = await run(client, ownerId, runId);
    if (active && (TerminalRunStates.has(current.state) || current.state === "cancel_requested" || parent.operation_id !== runId)) {
      throw new ApiFailure(409, "RUN_NOT_ACTIVE", "这个任务已停止接受执行结果。");
    }
    return { current, parent };
  }
  async function event(client: PoolClient, current: Row, input: AppendEventInput) {
    const attempt = input.attempt ?? current.attempt;
    if (attempt !== current.attempt) throw new ApiFailure(409, "STALE_ATTEMPT", "执行结果来自旧的尝试。");
    if (input.roleRunId) {
      const role = await client.query("SELECT id FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND id=$3 AND attempt=$4", [current.owner_id, current.id, input.roleRunId, attempt]);
      if (!role.rows[0]) throw new ApiFailure(409, "STALE_ROLE", "执行结果来自其它角色或尝试。");
    }
    const result = await client.query(`INSERT INTO nano.run_events
      (owner_id,project_id,run_id,role_run_id,attempt,type,payload_json) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [current.owner_id, current.project_id, current.id, input.roleRunId ?? null, attempt, input.type, boundedJson(input.payload)]);
    return storedEvent(result.rows[0]);
  }
  async function revision(client: PoolClient, ownerId: string, revisionId: string) {
    const result = await client.query("SELECT * FROM nano.revisions WHERE owner_id=$1 AND id=$2", [ownerId, revisionId]);
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }
  return {
    // A single statement keeps related values in one MVCC snapshot and avoids repeated remote transaction setup.
    readRunSnapshot: (ownerId, runId) => database.owned(ownerId, async (client) => {
      const result = await client.query(`SELECT r.*, to_jsonb(v) AS revision_json, to_jsonb(binding) AS binding_json,
        coalesce((SELECT jsonb_agg(to_jsonb(replay) || jsonb_build_object('id',replay.id::text) ORDER BY replay.id)
          FROM (SELECT e.* FROM nano.run_events e WHERE e.owner_id=r.owner_id AND e.run_id=r.id ORDER BY e.id LIMIT 200) replay),'[]'::jsonb) AS events_json
        FROM nano.runs r
        LEFT JOIN nano.revisions v ON v.owner_id=r.owner_id AND v.project_id=r.project_id AND v.id=r.result_revision_id
        LEFT JOIN LATERAL (SELECT s.* FROM nano.sandboxes s WHERE s.owner_id=r.owner_id AND s.project_id=r.project_id
          AND s.revision_id=v.id AND s.purpose IN ('candidate-preview','preview') ORDER BY s.created_at DESC,s.id DESC LIMIT 1) binding ON true
        WHERE r.owner_id=$1 AND r.id=$2`, [ownerId, runId]);
      const row = result.rows[0];
      if (!row) throw notFound();
      return { run: storedRun(row), revision: row.revision_json ? storedRevision(row.revision_json) : null,
        events: (row.events_json as Row[]).map(storedEvent), binding: row.binding_json ? storedSandbox(row.binding_json) : null };
    }),
    readProjectSnapshot: (ownerId, projectId) => database.owned(ownerId, async (client) => {
      const result = await client.query(`SELECT p.*, to_jsonb(latest) AS latest_run_json, to_jsonb(current) AS current_revision_json,
        to_jsonb(candidate) AS latest_candidate_json, to_jsonb(binding) AS binding_json,
        coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at,m.id) FROM nano.messages m
          WHERE m.owner_id=p.owner_id AND m.project_id=p.id),'[]'::jsonb) AS messages_json
        FROM nano.projects p
        LEFT JOIN LATERAL (SELECT r.* FROM nano.runs r WHERE r.owner_id=p.owner_id AND r.project_id=p.id
          ORDER BY r.created_at DESC,r.id DESC LIMIT 1) latest ON true
        LEFT JOIN nano.revisions current ON current.owner_id=p.owner_id AND current.project_id=p.id AND current.id=p.current_revision_id
        LEFT JOIN LATERAL (SELECT v.* FROM nano.revisions v WHERE v.owner_id=p.owner_id AND v.project_id=p.id AND v.status<>'accepted'
          ORDER BY v.revision_no DESC LIMIT 1) candidate ON true
        LEFT JOIN LATERAL (SELECT s.* FROM nano.sandboxes s WHERE s.owner_id=p.owner_id AND s.project_id=p.id
          AND s.revision_id=coalesce(candidate.id,current.id) AND s.purpose IN ('candidate-preview','preview')
          ORDER BY s.created_at DESC,s.id DESC LIMIT 1) binding ON true
        WHERE p.owner_id=$1 AND p.id=$2`, [ownerId, projectId]);
      const row = result.rows[0];
      if (!row) throw notFound();
      return { project: storedProject(row), messages: (row.messages_json as Row[]).map(storedMessage),
        currentRevision: row.current_revision_json ? storedRevision(row.current_revision_json) : null,
        latestCandidate: row.latest_candidate_json ? storedRevision(row.latest_candidate_json) : null,
        latestRun: row.latest_run_json ? storedRun(row.latest_run_json) : null,
        binding: row.binding_json ? storedSandbox(row.binding_json) : null };
    }),
    async accept(ownerId, projectId, input) {
      const { idempotencyKey, ...body } = input;
      const parsed = CreateRunRequestSchema.safeParse(body);
      if (!parsed.success || !z.uuid().safeParse(idempotencyKey).success) throw new ApiFailure(422, "INVALID_INPUT", "需求或请求标识格式不正确。");
      const normalized = parsed.data;
      const requestHash = createHash("sha256").update(JSON.stringify([
        normalized.text, normalized.expectedCurrentRevisionId, normalized.retryOfRunId, normalized.parentRunId,
        normalized.modelProfileId, normalized.modelConfigVersion,
      ])).digest("hex");
      try {
        return await database.owned(ownerId, async (client) => {
          const parent = await project(client, ownerId, projectId, true);
          const previous = await client.query("SELECT * FROM nano.runs WHERE owner_id=$1 AND project_id=$2 AND idempotency_key=$3", [ownerId, projectId, idempotencyKey]);
          if (previous.rows[0]) {
            if (previous.rows[0].request_hash !== requestHash) throw new ApiFailure(409, "IDEMPOTENCY_CONFLICT", "同一请求标识对应的需求或模型配置不同。");
            return { run: storedRun(previous.rows[0]), replayed: true };
          }
          if (parent.current_revision_id !== normalized.expectedCurrentRevisionId) throw new ApiFailure(409, "STALE_BASE", "当前版本已经变化，请刷新项目后重试。");
          if (parent.operation_id) throw new ApiFailure(409, "PROJECT_BUSY", "当前项目仍有执行或清理操作。", true);
          if (normalized.retryOfRunId || normalized.parentRunId) throw new ApiFailure(422, "OPERATION_NOT_SUPPORTED", "重试和澄清流程尚未开放，请提交新的需求。");
          if (options.hasSandboxCapacity && !options.hasSandboxCapacity()) throw new ApiFailure(503, "SERVICE_BUSY", "沙箱容量已满，本次需求尚未接受。", true);
          const id = randomUUID();
          const roleId = randomUUID();
          const lease = await models.freezeInTransaction(client, ownerId, normalized.modelProfileId, normalized.modelConfigVersion, id);
          const inserted = await client.query(`INSERT INTO nano.runs
            (id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,expected_current_revision_id,base_revision_id,
             model_profile_id,model_config_version,credential_lease_id,builder_role_run_id,state,phase,budget_json,deadline_at,executor_boot_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,'accepted','provision',$13,now()+interval '10 minutes',$14) RETURNING *`,
          [id, ownerId, projectId, idempotencyKey, requestHash, normalized.text, parent.current_revision_id ? "modify" : "generate",
            normalized.expectedCurrentRevisionId, normalized.modelProfileId, normalized.modelConfigVersion, lease.id, roleId,
            { deadlineMs: 600_000, modelTimeoutMs: 90_000, maxToolCalls: 80 }, options.executorBootId]);
          await client.query(`INSERT INTO nano.role_runs (id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json)
            VALUES ($1,$2,$3,$4,'builder',0,$5,'queued',$6)`, [roleId, ownerId, projectId, id, randomUUID(),
            { requestText: normalized.text, baseRevisionId: parent.current_revision_id }]);
          await client.query("INSERT INTO nano.messages (owner_id,project_id,run_id,kind,content) VALUES ($1,$2,$3,'user',$4)", [ownerId, projectId, id, normalized.text]);
          await event(client, inserted.rows[0], { type: "run.accepted", payload: { state: "accepted", phase: "provision" } });
          await client.query("UPDATE nano.projects SET operation_kind='generate',operation_id=$3,operation_started_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, projectId, id]);
          return { run: storedRun(inserted.rows[0]), replayed: false };
        });
      } catch (error) {
        const pgError = error as { code?: string; constraint?: string };
        if (pgError.code === "23505" && pgError.constraint === "one_global_generation") throw new ApiFailure(503, "SERVICE_BUSY", "服务当前正在执行任务，本次需求尚未接受。", true);
        throw error;
      }
    },
    getRun: (ownerId, runId) => database.owned(ownerId, async (client) => storedRun(await run(client, ownerId, runId))),
    getLatestRun: (ownerId, projectId) => database.owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const result = await client.query("SELECT * FROM nano.runs WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [ownerId, projectId]);
      return result.rows[0] ? storedRun(result.rows[0]) : null;
    }),
    listProjectMessages: (ownerId, projectId) => database.owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const result = await client.query("SELECT * FROM nano.messages WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at,id", [ownerId, projectId]);
      return result.rows.map(storedMessage);
    }),
    listEvents: (ownerId, runId, after = "0", limit = 200) => database.owned(ownerId, async (client) => {
      await run(client, ownerId, runId);
      if (!/^\d{1,18}$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiFailure(422, "INVALID_INPUT", "事件游标或数量无效。");
      const result = await client.query("SELECT * FROM nano.run_events WHERE owner_id=$1 AND run_id=$2 AND id>$3 ORDER BY id LIMIT $4", [ownerId, runId, after, limit]);
      return result.rows.map(storedEvent);
    }),
    appendEvent: (ownerId, runId, input) => database.owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      return event(client, current, input);
    }),
    async finishFailed(ownerId, runId, input) {
      return database.owned(ownerId, async (client) => {
        const { current, parent } = await lockedRun(client, ownerId, runId, false);
        if (TerminalRunStates.has(current.state)) return storedRun(current);
        if (parent.operation_id !== runId) throw new ApiFailure(409, "RUN_NOT_ACTIVE", "任务操作已失效。");
        if (input.resultRevisionId) {
          const found = await client.query("SELECT id FROM nano.revisions WHERE owner_id=$1 AND run_id=$2 AND id=$3", [ownerId, runId, input.resultRevisionId]);
          if (!found.rows[0]) throw notFound();
        }
        const summary = (input.summary ?? input.message).slice(0, 4000);
        const result = await client.query(`UPDATE nano.runs SET state='failed',phase='cleanup',cleanup_state=$3,
          error_code=$4,error_message=$5,error_retryable=$6,summary=$7,result_revision_id=coalesce($8,result_revision_id),finished_at=now()
          WHERE owner_id=$1 AND id=$2 RETURNING *`, [ownerId, runId, input.cleanupState, input.code.slice(0, 80), input.message.slice(0, 2000), input.retryable, summary, input.resultRevisionId ?? null]);
        await client.query("UPDATE nano.role_runs SET state='failed',finished_at=now() WHERE owner_id=$1 AND run_id=$2 AND state IN ('queued','running')", [ownerId, runId]);
        await client.query("INSERT INTO nano.messages(owner_id,project_id,run_id,kind,content) VALUES($1,$2,$3,'result',$4)", [ownerId, current.project_id, runId, summary]);
        await event(client, result.rows[0], { type: "run.finished", payload: { state: "failed", error: { code: input.code, message: input.message.slice(0, 2000), retryable: input.retryable }, revisionId: input.resultRevisionId ?? current.result_revision_id } });
        if (input.cleanupState !== "pending") await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, current.project_id, runId]);
        return storedRun(result.rows[0]);
      });
    },
    setPhase: (ownerId, runId, input) => database.owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      const state = input.state ?? current.state;
      const permitted: Record<string, string[]> = { accepted: ["accepted", "building"], building: ["building", "verifying"], verifying: ["verifying"] };
      if (!permitted[current.state]?.includes(state)) throw new ApiFailure(409, "INVALID_RUN_TRANSITION", "当前阶段不能进行这个状态切换。");
      if (state === current.state && input.phase === current.phase) return storedRun(current);
      const changed = await client.query("UPDATE nano.runs SET state=$3,phase=$4 WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, runId, state, input.phase]);
      await event(client, changed.rows[0], { type: "run.phase", payload: { state, phase: input.phase } });
      return storedRun(changed.rows[0]);
    }),
    startBuilder: (ownerId, runId) => database.owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      const prior = await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND id=$2 AND run_id=$3", [ownerId, current.builder_role_run_id, runId]);
      if (prior.rows[0]?.state === "running") return storedRole(prior.rows[0]);
      if (prior.rows[0]?.state !== "queued") throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "工程师角色已经结束。");
      const updated = await client.query("UPDATE nano.role_runs SET state='running',started_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, current.builder_role_run_id]);
      await client.query("UPDATE nano.runs SET state='building',phase='implement' WHERE owner_id=$1 AND id=$2", [ownerId, runId]);
      await event(client, current, { type: "role.started", roleRunId: current.builder_role_run_id, payload: { role: "builder", phase: "implement" } });
      return storedRole(updated.rows[0]);
    }),
    completeBuilder: (ownerId, runId, input = {}) => database.owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      const prior = await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND id=$2 AND run_id=$3", [ownerId, current.builder_role_run_id, runId]);
      if (prior.rows[0]?.state === "succeeded") return storedRole(prior.rows[0]);
      if (prior.rows[0]?.state !== "running") throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "工程师角色尚未开始或已经失败。");
      const updated = await client.query("UPDATE nano.role_runs SET state='succeeded',finished_at=now(),output_json=$3,usage_json=$4 WHERE owner_id=$1 AND id=$2 RETURNING *",
        [ownerId, current.builder_role_run_id, { summary: input.summary?.slice(0, 4000) ?? null }, boundedJson(input.usage ?? {})]);
      await event(client, current, { type: "role.completed", roleRunId: current.builder_role_run_id, payload: { role: "builder", state: "succeeded", summary: input.summary?.slice(0, 4000) ?? null } });
      return storedRole(updated.rows[0]);
    }),
    saveCandidate: async (ownerId, runId, input) => {
      assertVerifiedSourceSnapshot(input.source);
      if (input.source.ownerId !== ownerId) throw notFound();
      return database.owned(ownerId, async (client) => {
        const { current, parent } = await lockedRun(client, ownerId, runId);
        if (input.source.projectId !== current.project_id) throw notFound();
        const existing = await client.query("SELECT * FROM nano.revisions WHERE owner_id=$1 AND run_id=$2 AND attempt=$3", [ownerId, runId, current.attempt]);
        if (existing.rows[0]) {
          if (existing.rows[0].id !== input.source.revisionId || existing.rows[0].source_key !== input.source.key || existing.rows[0].build_status !== input.buildStatus) {
            throw new ApiFailure(409, "SNAPSHOT_CONFLICT", "本轮尝试已经保存了不同的不可变候选。");
          }
          return storedRevision(existing.rows[0]);
        }
        const result = await client.query(`INSERT INTO nano.revisions
          (id,owner_id,project_id,run_id,revision_no,attempt,source_key,source_hash,template_version,manifest_json,
           source_bytes,compressed_bytes,build_status,build_json,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'candidate') RETURNING *`,
        [input.source.revisionId, ownerId, current.project_id, runId, parent.next_revision_no, current.attempt,
          input.source.key, input.source.sourceHash, input.source.templateVersion, JSON.stringify(input.source.manifest),
          // Trusted command arguments include up to 200 bounded source paths; this is separate from the 16 KiB event limit.
          input.source.sourceBytes, input.source.compressedBytes, input.buildStatus, boundedJson(input.build, 256 * 1024)]);
        await client.query("UPDATE nano.projects SET next_revision_no=next_revision_no+1,updated_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, current.project_id]);
        await client.query("UPDATE nano.runs SET result_revision_id=$3 WHERE owner_id=$1 AND id=$2", [ownerId, runId, input.source.revisionId]);
        await event(client, current, { type: "revision.saved", payload: { revisionId: input.source.revisionId, sourceHash: input.source.sourceHash,
          revisionNo: parent.next_revision_no, buildStatus: input.buildStatus } });
        return storedRevision(result.rows[0]);
      });
    },
    getRevision: (ownerId, revisionId) => database.owned(ownerId, async (client) => storedRevision(await revision(client, ownerId, revisionId))),
    listProjectRevisions: (ownerId, projectId) => database.owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const result = await client.query("SELECT * FROM nano.revisions WHERE owner_id=$1 AND project_id=$2 ORDER BY revision_no DESC", [ownerId, projectId]);
      return result.rows.map(storedRevision);
    }),
    registerSandbox: (ownerId, runId, input) => database.owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(input.sandboxId) || !z.iso.datetime().safeParse(input.expiresAt).success) throw new ApiFailure(422, "INVALID_SANDBOX_BINDING", "沙箱标识或有效期无效。");
      const prior = await client.query("SELECT * FROM nano.sandboxes WHERE owner_id=$1 AND run_id=$2 AND attempt=$3", [ownerId, runId, current.attempt]);
      if (prior.rows[0]) {
        if (prior.rows[0].remote_id !== input.sandboxId) throw new ApiFailure(409, "SANDBOX_CONFLICT", "本轮尝试已经绑定了其它沙箱。");
        return storedSandbox(prior.rows[0]);
      }
      const result = await client.query(`INSERT INTO nano.sandboxes(owner_id,project_id,run_id,attempt,remote_id,purpose,state,expires_at)
        VALUES($1,$2,$3,$4,$5,'candidate',$6,$7) RETURNING *`, [ownerId, current.project_id, runId, current.attempt, input.sandboxId, input.state ?? "active", input.expiresAt]);
      return storedSandbox(result.rows[0]);
    }),
    bindPreview: (ownerId, runId, input) => database.owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      const saved = await revision(client, ownerId, input.revisionId);
      if (saved.run_id !== runId || saved.attempt !== current.attempt || saved.source_hash !== input.sourceHash
        || saved.build_status !== "passed" || input.markerVerified !== true || input.writeRevoked !== true || input.chromeClosed !== true) {
        throw new ApiFailure(409, "PREVIEW_BINDING_MISMATCH", "预览尚未完成版本、安全边界或构建核验。");
      }
      const result = await client.query(`UPDATE nano.sandboxes SET revision_id=$4,source_hash=$5,purpose='candidate-preview',
        state='active',expires_at=$6,last_checked_at=now() WHERE owner_id=$1 AND run_id=$2 AND remote_id=$3
        AND attempt=$7 AND state IN ('creating','active') RETURNING *`,
      [ownerId, runId, input.sandboxId, input.revisionId, input.sourceHash, input.expiresAt, current.attempt]);
      if (!result.rows[0]) throw notFound();
      await event(client, current, { type: "preview.ready", payload: { revisionId: input.revisionId, sourceHash: input.sourceHash, expiresAt: input.expiresAt, checked: false } });
      return storedSandbox(result.rows[0]);
    }),
    getPreviewBinding: (ownerId, projectId, revisionId) => database.owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const saved = await revision(client, ownerId, revisionId);
      if (saved.project_id !== projectId) throw notFound();
      const result = await client.query("SELECT * FROM nano.sandboxes WHERE owner_id=$1 AND project_id=$2 AND revision_id=$3 AND purpose IN ('candidate-preview','preview') ORDER BY created_at DESC LIMIT 1", [ownerId, projectId, revisionId]);
      return result.rows[0] ? storedSandbox(result.rows[0]) : null;
    }),
    markDestroyed: (ownerId, runId, sandboxId) => database.owned(ownerId, async (client) => {
      await lockedRun(client, ownerId, runId, false);
      const result = await client.query("UPDATE nano.sandboxes SET state='destroyed',last_checked_at=now() WHERE owner_id=$1 AND run_id=$2 AND remote_id=$3 RETURNING id", [ownerId, runId, sandboxId]);
      if (!result.rows[0]) throw notFound();
    }),
    markCleanupPending: (ownerId, runId, message) => database.owned(ownerId, async (client) => {
      const { parent } = await lockedRun(client, ownerId, runId, false);
      if (parent.operation_id !== runId) throw new ApiFailure(409, "RUN_NOT_ACTIVE", "不能重新占用已释放的项目操作。");
      const result = await client.query("UPDATE nano.runs SET cleanup_state='pending',phase='cleanup' WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, runId]);
      await event(client, result.rows[0], { type: "run.phase", payload: { phase: "cleanup", cleanupState: "pending", message: message.slice(0, 2000) } });
      return storedRun(result.rows[0]);
    }),
    confirmCleanup: (ownerId, runId) => database.owned(ownerId, async (client) => {
      const { current, parent } = await lockedRun(client, ownerId, runId, false);
      if (!TerminalRunStates.has(current.state)) throw new ApiFailure(409, "RUN_STILL_ACTIVE", "任务尚未结束，不能释放清理占用。");
      if (current.cleanup_state !== "pending") return storedRun(current);
      if (parent.operation_id !== runId) throw new ApiFailure(409, "RUN_NOT_ACTIVE", "项目操作与待清理任务不一致。");
      const result = await client.query("UPDATE nano.runs SET cleanup_state='confirmed' WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, runId]);
      await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, current.project_id, runId]);
      await event(client, result.rows[0], { type: "run.phase", payload: { phase: "cleanup", cleanupState: "confirmed" } });
      return storedRun(result.rows[0]);
    }),
    listReferencedSourceKeys: (ownerId, projectId) => database.owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const result = await client.query<{ source_key: string }>("SELECT source_key FROM nano.revisions WHERE owner_id=$1 AND project_id=$2", [ownerId, projectId]);
      return result.rows.map((row) => row.source_key);
    }),
  };
}
