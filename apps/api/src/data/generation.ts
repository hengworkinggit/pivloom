import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  CreateRunRequestSchema, ProjectMessageSchema, ProjectSummarySchema, RevisionSchema, RunEventSchema, RunSchema,
  HandoffSchema, PlanSchema, GroupedPlanSchema, PlanningContextSchema, RoleRunSchema, RoleUsageSchema, ClarificationRequestSchema, preservesPreviousBehavior,
  ReviewBindingSchema, CheckSchema, ReviewArtifactSchema, ReviewResultSchema, MAX_CHECK_ARTIFACTS, aggregateCheckGroups, allowsRenderOnlyEvidence, type ReviewBinding, type Check,
  TerminalRunStates, type CreateRunRequest, type ProjectMessage, type ProjectSummary, type Revision,
  type Run, type RunEvent, type RunEventType, type RunPhase, type RunState, type RoleRun, type RoleUsage, type Role, type Plan, type PlanningContext, type Handoff,
} from "@pivloom/contracts";
import { z } from "zod";
import type { PivloomDatabase } from "./database.js";
import type { ModelProfileService } from "../models/service.js";
import { ApiFailure } from "../routes/errors.js";
import { assertVerifiedSourceSnapshot, type SourceReference, type VerifiedSourceSnapshot } from "../storage/source.js";
import { assertVerifiedReviewReceipt, type VerifiedReviewReceipt } from "../generation/review.js";
import type { StoredArtifact } from "../storage/artifacts.js";
import { DAILY_ACCEPTED_LIMIT, MODEL_REQUEST_TIMEOUT_MS, RUN_DEADLINE_MS, RUN_TOOL_LIMIT } from "../runtime/budgets.js";

export interface StoredRun extends Run {
  ownerId: string;
  credentialLeaseId: string;
  executorBootId: string;
  builderRoleRunId: string | null;
  coordinatorRoleRunId: string | null;
  expectedCurrentRevisionId: string | null;
}
export interface StoredRevision extends Revision { ownerId: string; source: SourceReference; build: Record<string, unknown> }
export interface StoredRoleRun extends RoleRun { input: Handoff | null }
export interface StoredSandboxBinding {
  id: string; ownerId: string; projectId: string; runId: string; attempt: number; sandboxId: string;
  revisionId: string | null; sourceHash: string | null;
  purpose: "candidate" | "candidate-preview" | "preview";
  state: "creating" | "active" | "expired" | "destroying" | "destroyed" | "error";
  expiresAt: string; error: string | null;
}
export interface RunReadSnapshot {
  run: StoredRun; revision: StoredRevision | null; events: RunEvent[]; binding: StoredSandboxBinding | null; roles: RoleRun[];
}
export interface ProjectReadSnapshot {
  project: ProjectSummary; messages: ProjectMessage[]; currentRevision: StoredRevision | null;
  latestCandidate: StoredRevision | null; latestRun: StoredRun | null; binding: StoredSandboxBinding | null;
  lastRollbackAt: string | null;
}
export type AcceptRunInput = Omit<CreateRunRequest, "retryOfRunId" | "parentRunId"> & {
  idempotencyKey: string; retryOfRunId?: string | null; parentRunId?: string | null;
};
export interface FinishFailedInput {
  code: string; message: string; retryable: boolean; summary?: string;
  resultRevisionId?: string | null; cleanupState: Run["cleanupState"];
  roleUsage?: { roleRunId: string; usage: RoleUsage };
}
export interface AppendEventInput { type: RunEventType; payload: Record<string, unknown>; roleRunId?: string | null; attempt?: number }
export interface RoleReference { roleRunId: string; attempt: number; role: Role }
export interface SubmitPlanInput { roleRunId: string; attempt: number; plan: Plan; usage?: RoleUsage }
export interface ClarificationInput { roleRunId: string; attempt: number; question: string; usage?: RoleUsage }
export interface PlanSubmission { run: StoredRun; coordinator: StoredRoleRun; builder: StoredRoleRun; handoff: Handoff }
export interface ReviewerExecution { role: StoredRoleRun; scope: ReviewBinding; handoff: Handoff }
export interface ReviewCompletion { run: StoredRun; check: Check; revision: StoredRevision; repairNextAttempt: number | null }
export interface BuildFailureInput {
  revisionId: string; code: "TYPECHECK_FAILED" | "BUILD_FAILED"; message: string; usage?: RoleUsage;
}
export interface BuildFailureCompletion { run: StoredRun; revision: StoredRevision; repairNextAttempt: number | null }
export interface StoredRestore {
  id: string; projectId: string; revisionId: string; sourceHash: string;
  status: "pending" | "ready" | "failed"; sandboxId: string | null;
  error: { code: string; message: string } | null;
}
export interface StoredCheckArtifact { artifact: StoredArtifact; source: SourceReference; checkId: string }
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
  readProjectVersionHistory(ownerId: string, projectId: string): Promise<{ currentRevisionId: string | null; revisions: StoredRevision[] }>;
  listEvents(ownerId: string, runId: string, after?: string, limit?: number): Promise<RunEvent[]>;
  readEventHead(ownerId: string, runId: string): Promise<{ eventId: string; state: RunState }>;
  listEventsThrough(ownerId: string, runId: string, after: string, through: string, limit?: number): Promise<RunEvent[]>;
  appendEvent(ownerId: string, runId: string, input: AppendEventInput): Promise<RunEvent>;
  setPhase(ownerId: string, runId: string, input: { phase: RunPhase; state?: RunState }): Promise<StoredRun>;
  getPlanningContext(ownerId: string, runId: string): Promise<PlanningContext>;
  startCoordinator(ownerId: string, runId: string): Promise<StoredRoleRun>;
  assertRoleActive(ownerId: string, runId: string, input: RoleReference): Promise<void>;
  submitPlan(ownerId: string, runId: string, input: SubmitPlanInput): Promise<PlanSubmission>;
  requestClarification(ownerId: string, runId: string, input: ClarificationInput): Promise<{ run: StoredRun; coordinator: StoredRoleRun }>;
  startBuilder(ownerId: string, runId: string): Promise<StoredRoleRun>;
  completeBuilder(ownerId: string, runId: string, input?: { summary?: string; usage?: RoleUsage }): Promise<StoredRoleRun>;
  queueReviewer(ownerId: string, runId: string, input: { revisionId: string }): Promise<ReviewerExecution>;
  startReviewer(ownerId: string, runId: string): Promise<ReviewerExecution>;
  finishReview(ownerId: string, runId: string, input: { receipt: VerifiedReviewReceipt; usage?: RoleUsage }): Promise<ReviewCompletion>;
  finishBuildFailure(ownerId: string, runId: string, input: BuildFailureInput): Promise<BuildFailureCompletion>;
  getCheck(ownerId: string, checkId: string): Promise<Check>;
  getRunCheck(ownerId: string, runId: string): Promise<Check | null>;
  getArtifact(ownerId: string, artifactId: string): Promise<StoredCheckArtifact>;
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
  cancel(ownerId: string, runId: string): Promise<StoredRun>;
  finishCancelled(ownerId: string, runId: string, input: { cleanupState: "confirmed" | "pending"; summary: string }): Promise<StoredRun>;
  quota(ownerId: string): Promise<{ dailyLimit: number; dailyAccepted: number }>;
  startRepairBuilder(ownerId: string, runId: string, input: { attempt: number; previousRevisionId: string; failedChecks: string[] }): Promise<StoredRoleRun>;
  beginRestore(ownerId: string, projectId: string, input: { revisionId: string; idempotencyKey: string }): Promise<{ restore: StoredRestore; revision: StoredRevision; replayed: boolean }>;
  registerRestoreSandbox(ownerId: string, projectId: string, restoreId: string, input: { sandboxId: string; expiresAt: string }): Promise<StoredRestore>;
  markRestoreSandboxDestroyed(ownerId: string, projectId: string, restoreId: string, sandboxId: string): Promise<void>;
  bindRestore(ownerId: string, projectId: string, restoreId: string, input: { sandboxId: string; expiresAt: string }): Promise<StoredRestore>;
  failRestore(ownerId: string, projectId: string, restoreId: string, input: { code: string; message: string }): Promise<StoredRestore | null>;
  getActiveRestore(ownerId: string, projectId: string, revisionId: string): Promise<StoredRestore | null>;
  revisionExists(revisionId: string): Promise<boolean>;
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
    rollbackId: row.rollback_id ?? null,
    kind: row.kind, content: row.content, createdAt: date(row.created_at).toISOString() });
}
function storedRun(row: Row): StoredRun {
  return { ...RunSchema.parse({
    id: row.id, projectId: row.project_id, state: row.state, phase: row.phase, attempt: row.attempt,
    requestText: row.request_text, modelProfileId: row.model_profile_id, modelConfigVersion: row.model_config_version,
    modelId: row.model_id ?? null,
    baseRevisionId: row.base_revision_id, resultRevisionId: row.result_revision_id,
    createdAt: date(row.created_at).toISOString(), deadlineAt: date(row.deadline_at).toISOString(), finishedAt: row.finished_at ? date(row.finished_at).toISOString() : null,
    cleanupState: row.cleanup_state, summary: row.summary,
    plan: row.plan_json ?? null, clarification: row.clarification_json ?? null, parentRunId: row.parent_run_id ?? null,
    error: row.error_code ? { code: row.error_code, message: row.error_message, retryable: row.error_retryable } : null,
  }), ownerId: row.owner_id, credentialLeaseId: row.credential_lease_id, executorBootId: row.executor_boot_id,
    builderRoleRunId: row.builder_role_run_id, coordinatorRoleRunId: row.coordinator_role_run_id ?? null, expectedCurrentRevisionId: row.expected_current_revision_id };
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
  const input = row.role === "builder" || row.role === "reviewer" ? HandoffSchema.safeParse(row.input_json) : null;
  return { ...RoleRunSchema.parse({ id: row.id, runId: row.run_id, role: row.role, attempt: row.attempt, sessionId: row.session_id, state: row.state,
    predecessorId: row.predecessor_id ?? null, startedAt: row.started_at ? date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? date(row.finished_at).toISOString() : null }), input: input?.success ? input.data : null };
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
function roleUsage(value: RoleUsage | undefined): RoleUsage | Record<string, never> {
  if (value === undefined) return {};
  const parsed = RoleUsageSchema.safeParse(value);
  if (!parsed.success) throw new ApiFailure(422, "INVALID_ROLE_USAGE", "角色用量格式无效。");
  return parsed.data;
}
function reviewerExecution(row: Row): ReviewerExecution {
  return { role: storedRole(row), scope: ReviewBindingSchema.parse(row.review_binding_json), handoff: HandoffSchema.parse(row.input_json) };
}
const storedArtifactSchema = ReviewArtifactSchema.extend({ key: z.string().min(1).max(512), bytes: z.number().int().min(8).max(2 * 1024 * 1024) });
const reviewEvidenceSchema = z.array(z.strictObject({
  id: z.uuid(), behaviorId: z.string().regex(/^B(?:0[1-9]|[1-9]\d)$/).nullable(),
  action: z.enum(["click", "fill", "select", "press", "scroll", "reload", "key_batch"]).nullable(), observationId: z.uuid(),
  key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"]).optional(),
  batch: z.strictObject({ startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
    steps: z.array(z.strictObject({ index: z.number().int().min(0).max(7),
      key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"]),
      waitMs: z.number().int().min(0).max(1000), success: z.boolean() })).min(1).max(8) }).optional(),
  url: z.url().max(4000), tree: z.string().max(12000), text: z.string().max(12000), truncated: z.boolean(),
})).max(256);
function storedCheck(row: Row): Check {
  return CheckSchema.parse({ id: row.id, runId: row.run_id, roleRunId: row.role_run_id, attempt: row.attempt,
    revisionId: row.revision_id, sourceHash: row.source_hash, sandboxId: row.sandbox_id, browserSessionId: row.browser_session_id,
    verdict: row.verdict, items: row.items_json, summary: row.summary,
    groups: row.group_results_json ?? undefined,
    artifacts: z.array(storedArtifactSchema).parse(row.artifacts_json).map(({ id, mimeType, sha256 }) => ({ id, mimeType, sha256 })),
    createdAt: date(row.created_at).toISOString() });
}
function storedRestore(row: Row): StoredRestore {
  return { id: row.id, projectId: row.project_id, revisionId: row.revision_id, sourceHash: row.source_hash,
    status: row.status, sandboxId: row.sandbox_id ?? null,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null };
}

export function createGenerationRepository(
  database: Pick<PivloomDatabase, "owned">,
  models: ModelProfileService,
  options: {
    executorBootId: string; maxSandboxes?: number;
    dailyLimitByOwner?: Readonly<Record<string, number>>;
    onCommittedEvent?: (ownerId: string, event: RunEvent) => void | Promise<void>;
  },
): GenerationRepository {
  const transactionEvents = new WeakMap<PoolClient, RunEvent[]>();
  async function owned<T>(ownerId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const committed: RunEvent[] = [];
    const result = await database.owned(ownerId, async (client) => {
      transactionEvents.set(client, committed);
      try { return await operation(client); }
      finally { transactionEvents.delete(client); }
    });
    // Database.owned resolves only after COMMIT. Notifications are hints, never
    // a transaction barrier, and subscriber failures cannot undo durable state.
    for (const event of committed) {
      try { void Promise.resolve(options.onCommittedEvent?.(ownerId, event)).catch(() => {}); }
      catch { /* An authenticated reconnect always replays the durable event. */ }
    }
    return result;
  }
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
    const current = (await client.query("SELECT * FROM nano.runs WHERE owner_id=$1 AND id=$2 FOR UPDATE", [ownerId, runId])).rows[0];
    if (!current) throw notFound();
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
    const saved = storedEvent(result.rows[0]);
    boundedJson(saved);
    transactionEvents.get(client)!.push(saved);
    return saved;
  }
  async function revision(client: PoolClient, ownerId: string, revisionId: string) {
    const result = await client.query("SELECT * FROM nano.revisions WHERE owner_id=$1 AND id=$2", [ownerId, revisionId]);
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }
  function planningContext(current: Row): PlanningContext {
    const context = PlanningContextSchema.safeParse(current.planning_context_json);
    if (!context.success) throw new ApiFailure(409, "PLANNING_CONTEXT_UNAVAILABLE", "这个任务缺少有效的规划上下文。");
    return context.data;
  }
  function assertRole(current: Row, role: Row | undefined, input: RoleReference) {
    if (date(current.deadline_at).getTime() <= Date.now()) throw new ApiFailure(409, "RUN_TIMEOUT", "任务已达到时间上限。");
    if (input.attempt !== current.attempt) throw new ApiFailure(409, "STALE_ATTEMPT", "执行结果来自旧的尝试。");
    if (!role || role.id !== input.roleRunId || role.role !== input.role || role.attempt !== input.attempt) throw new ApiFailure(409, "STALE_ROLE", "执行结果来自其它角色或尝试。");
    const currentId = input.role === "coordinator" ? current.coordinator_role_run_id : input.role === "builder" ? current.builder_role_run_id : current.reviewer_role_run_id;
    const state = input.role === "coordinator" ? "planning" : input.role === "builder" ? "building" : "verifying";
    if (role.state !== "running" || currentId !== role.id || current.state !== state) throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "这个角色已停止接受执行结果。");
  }
  async function activeRole(client: PoolClient, current: Row, input: RoleReference) {
    const result = await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND id=$3", [current.owner_id, current.id, input.roleRunId]);
    assertRole(current, result.rows[0], input);
    return result.rows[0];
  }
  return {
    // A single statement keeps related values in one MVCC snapshot and avoids repeated remote transaction setup.
    readRunSnapshot: (ownerId, runId) => owned(ownerId, async (client) => {
      const result = await client.query(`SELECT r.*, to_jsonb(v) AS revision_json, to_jsonb(binding) AS binding_json,
        coalesce((SELECT jsonb_agg(to_jsonb(replay) || jsonb_build_object('id',replay.id::text) ORDER BY replay.id)
          FROM (SELECT e.* FROM nano.run_events e WHERE e.owner_id=r.owner_id AND e.run_id=r.id ORDER BY e.id DESC LIMIT 200) replay),'[]'::jsonb) AS events_json,
        coalesce((SELECT jsonb_agg(to_jsonb(rr)-'input_json'-'output_json'-'usage_json' ORDER BY rr.attempt,CASE rr.role WHEN 'coordinator' THEN 0 WHEN 'builder' THEN 1 ELSE 2 END)
          FROM nano.role_runs rr WHERE rr.owner_id=r.owner_id AND rr.run_id=r.id),'[]'::jsonb) AS roles_json
        FROM nano.runs r
        LEFT JOIN nano.revisions v ON v.owner_id=r.owner_id AND v.project_id=r.project_id AND v.id=r.result_revision_id
        LEFT JOIN LATERAL (SELECT s.* FROM nano.sandboxes s WHERE s.owner_id=r.owner_id AND s.project_id=r.project_id
          AND s.revision_id=v.id AND s.purpose IN ('candidate-preview','preview') ORDER BY s.created_at DESC,s.id DESC LIMIT 1) binding ON true
        WHERE r.owner_id=$1 AND r.id=$2`, [ownerId, runId]);
      const row = result.rows[0];
      if (!row) throw notFound();
      return { run: storedRun(row), revision: row.revision_json ? storedRevision(row.revision_json) : null,
        events: (row.events_json as Row[]).map(storedEvent), binding: row.binding_json ? storedSandbox(row.binding_json) : null,
        roles: (row.roles_json as Row[]).map((role) => RoleRunSchema.parse(storedRole(role))) };
    }),
    readProjectSnapshot: (ownerId, projectId) => owned(ownerId, async (client) => {
      const result = await client.query(`SELECT p.*, to_jsonb(latest) AS latest_run_json, to_jsonb(current) AS current_revision_json,
        to_jsonb(candidate) AS latest_candidate_json, to_jsonb(binding) AS binding_json,
        (SELECT max(rb.finished_at) FROM nano.rollbacks rb WHERE rb.owner_id=p.owner_id AND rb.project_id=p.id AND rb.status='committed') AS last_rollback_at,
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
        binding: row.binding_json ? storedSandbox(row.binding_json) : null,
        lastRollbackAt: row.last_rollback_at ? date(row.last_rollback_at).toISOString() : null };
    }),
    async accept(ownerId, projectId, input) {
      const { idempotencyKey, ...body } = input;
      const parsed = CreateRunRequestSchema.safeParse(body);
      if (!parsed.success || !z.uuid().safeParse(idempotencyKey).success) throw new ApiFailure(422, "INVALID_INPUT", "需求或请求标识格式不正确。");
      const normalized = parsed.data;
      const requestHash = createHash("sha256").update(JSON.stringify([
        normalized.text, normalized.expectedCurrentRevisionId, normalized.retryOfRunId, normalized.parentRunId,
        normalized.modelProfileId, normalized.modelConfigVersion, normalized.modelId,
      ])).digest("hex");
      try {
        return await owned(ownerId, async (client) => {
          const parent = await project(client, ownerId, projectId, true);
          const previous = await client.query("SELECT * FROM nano.runs WHERE owner_id=$1 AND project_id=$2 AND idempotency_key=$3", [ownerId, projectId, idempotencyKey]);
          if (previous.rows[0]) {
            if (previous.rows[0].request_hash !== requestHash) throw new ApiFailure(409, "IDEMPOTENCY_CONFLICT", "同一请求标识对应的需求或模型配置不同。");
            return { run: storedRun(previous.rows[0]), replayed: true };
          }
          if (parent.current_revision_id !== normalized.expectedCurrentRevisionId) throw new ApiFailure(409, "STALE_BASE", "当前版本已经变化，请刷新项目后重试。");
          if (parent.operation_id) throw new ApiFailure(409, "PROJECT_BUSY", "当前项目仍有执行或清理操作。", true);
          // Capacity is counted from the durable sandbox registry, so it stays
          // correct across a restart and never counts a reclaimed sandbox.
          if (options.maxSandboxes) {
            const live = (await client.query("SELECT nano.live_sandbox_count() AS live")).rows[0].live as number;
            if (live >= options.maxSandboxes) throw new ApiFailure(503, "SERVICE_BUSY", "沙箱容量已满，本次需求尚未接受。", true);
          }
          // Replays return above, so a retried idempotency key never consumes quota twice.
          const used = (await client.query("SELECT count(*)::int AS accepted FROM nano.runs WHERE owner_id=$1 AND created_at > now() - interval '24 hours'", [ownerId])).rows[0].accepted as number;
          const dailyLimit = options.dailyLimitByOwner?.[ownerId] ?? DAILY_ACCEPTED_LIMIT;
          if (used >= dailyLimit)
            throw new ApiFailure(429, "QUOTA_EXCEEDED", `今日任务额度已用完（${dailyLimit} 个），请稍后再试。`, false);
          let requestText = normalized.text;
          let runKind: "generate" | "modify" | "retry" | "clarify" = normalized.parentRunId ? "clarify" : parent.current_revision_id ? "modify" : "generate";
          const baseRevisionId = normalized.expectedCurrentRevisionId;
          const retryOfRunId: string | null = normalized.retryOfRunId;
          if (retryOfRunId) {
            const prior = await run(client, ownerId, retryOfRunId);
            if (prior.project_id !== projectId) throw notFound();
            if (["completed", "needs_input"].includes(prior.state) || !TerminalRunStates.has(prior.state)) {
              throw new ApiFailure(422, "INVALID_RETRY_PARENT", "只能重试已结束的失败或需要修改的任务。");
            }
            // A retry repeats the same request from the same base as any other
            // new modification: the project's current revision. Planning reads
            // its base from this same value, so pointing the run at a rejected
            // candidate instead would make the coordinator's context check fail
            // before the first model call. The rejected candidate stays readable
            // as its own revision and is never promoted by a retry.
            requestText = prior.request_text;
            runKind = "retry";
          }
          const id = randomUUID();
          const roleId = randomUUID();
          // A retry repeats the original wording; anything the client sent alongside
          // the retry link is ignored so the recorded request cannot drift.
          let originalRequest = requestText;
          let clarificationTurns: PlanningContext["clarificationTurns"] = [];
          if (normalized.parentRunId) {
            const previousRun = await run(client, ownerId, normalized.parentRunId);
            if (previousRun.project_id !== projectId) throw notFound();
            if (previousRun.state !== "needs_input" || !previousRun.clarification_json?.question) throw new ApiFailure(422, "INVALID_CLARIFICATION_PARENT", "只能回答当前项目中等待补充信息的任务。");
            const previousContext = planningContext(previousRun);
            originalRequest = previousContext.originalRequest;
            clarificationTurns = [...previousContext.clarificationTurns, { parentRunId: previousRun.id, question: previousRun.clarification_json.question, answer: normalized.text }];
          }
          const basePlan = parent.current_revision_id ? await client.query(`SELECT prior.plan_json FROM nano.revisions base
            JOIN nano.runs prior ON prior.id=base.run_id AND prior.project_id=base.project_id AND prior.owner_id=base.owner_id
            WHERE base.owner_id=$1 AND base.project_id=$2 AND base.id=$3`, [ownerId, projectId, parent.current_revision_id]) : null;
          const parsedContext = PlanningContextSchema.safeParse({ schemaVersion: 1, project: { id: projectId, title: parent.title },
            requestText, originalRequest, clarificationTurns, baseRevisionId: parent.current_revision_id, previousPlan: basePlan?.rows[0]?.plan_json ?? null });
          if (!parsedContext.success) throw new ApiFailure(422, "PLANNING_CONTEXT_LIMIT", "补充信息已超过任务可处理范围，请重新提交简洁需求。");
          const context = parsedContext.data;
          const lease = await models.freezeInTransaction(client, ownerId, normalized.modelProfileId, normalized.modelConfigVersion, id, normalized.modelId);
          const inserted = await client.query(`INSERT INTO nano.runs
            (id,owner_id,project_id,idempotency_key,request_hash,request_text,kind,expected_current_revision_id,base_revision_id,
             model_profile_id,model_config_version,model_id,credential_lease_id,coordinator_role_run_id,state,phase,budget_json,deadline_at,executor_boot_id,planning_context_json,parent_run_id,retry_of)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,'accepted','plan',$14,now()+make_interval(secs=>$19),$15,$16,$17,$18) RETURNING *`,
          [id, ownerId, projectId, idempotencyKey, requestHash, requestText, runKind,
            baseRevisionId, normalized.modelProfileId, normalized.modelConfigVersion, normalized.modelId ?? null, lease.id, roleId,
            { deadlineMs: RUN_DEADLINE_MS, modelTimeoutMs: MODEL_REQUEST_TIMEOUT_MS, maxToolCalls: RUN_TOOL_LIMIT },
            options.executorBootId, context, normalized.parentRunId, retryOfRunId, RUN_DEADLINE_MS / 1000]);
          await client.query(`INSERT INTO nano.role_runs (id,owner_id,project_id,run_id,role,attempt,session_id,state,input_json)
            VALUES ($1,$2,$3,$4,'coordinator',0,$5,'queued',$6)`, [roleId, ownerId, projectId, id, randomUUID(), context]);
          await client.query("INSERT INTO nano.messages (owner_id,project_id,run_id,kind,content) VALUES ($1,$2,$3,'user',$4)", [ownerId, projectId, id, requestText]);
          await event(client, inserted.rows[0], { type: "run.accepted", payload: { state: "accepted", phase: "plan" } });
          await client.query("UPDATE nano.projects SET operation_kind='generate',operation_id=$3,operation_started_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, projectId, id]);
          return { run: storedRun(inserted.rows[0]), replayed: false };
        });
      } catch (error) {
        const pgError = error as { code?: string; constraint?: string };
        if (pgError.code === "23505" && pgError.constraint === "one_global_generation") throw new ApiFailure(503, "SERVICE_BUSY", "服务当前正在执行任务，本次需求尚未接受。", true);
        throw error;
      }
    },
    getRun: (ownerId, runId) => owned(ownerId, async (client) => storedRun(await run(client, ownerId, runId))),
    getPlanningContext: (ownerId, runId) => owned(ownerId, async (client) => planningContext(await run(client, ownerId, runId))),
    startCoordinator: (ownerId, runId) => owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      if (date(current.deadline_at).getTime() <= Date.now()) throw new ApiFailure(409, "RUN_TIMEOUT", "任务已达到时间上限。");
      const prior = await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND id=$3 AND role='coordinator' AND attempt=$4", [ownerId, runId, current.coordinator_role_run_id, current.attempt]);
      if (prior.rows[0]?.state === "running" && current.state === "planning") return storedRole(prior.rows[0]);
      if (prior.rows[0]?.state !== "queued" || current.state !== "accepted") throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "协调者角色尚未排入或已经结束。");
      const updated = await client.query("UPDATE nano.role_runs SET state='running',started_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, prior.rows[0].id]);
      const changed = await client.query("UPDATE nano.runs SET state='planning',phase='plan' WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, runId]);
      await event(client, changed.rows[0], { type: "run.phase", payload: { state: "planning", phase: "plan" } });
      await event(client, changed.rows[0], { type: "role.started", roleRunId: updated.rows[0].id, payload: { role: "coordinator", phase: "plan" } });
      return storedRole(updated.rows[0]);
    }),
    assertRoleActive: (ownerId, runId, input) => owned(ownerId, async (client) => {
      const result = await client.query(`SELECT r.*,p.operation_id,to_jsonb(rr) AS role_json
        FROM nano.runs r JOIN nano.projects p ON p.id=r.project_id AND p.owner_id=r.owner_id
        LEFT JOIN nano.role_runs rr ON rr.owner_id=r.owner_id AND rr.run_id=r.id AND rr.id=$3
        WHERE r.owner_id=$1 AND r.id=$2`, [ownerId, runId, input.roleRunId]);
      const current = result.rows[0];
      if (!current) throw notFound();
      if (TerminalRunStates.has(current.state) || current.state === "cancel_requested" || current.operation_id !== runId) throw new ApiFailure(409, "RUN_NOT_ACTIVE", "这个任务已停止接受执行结果。");
      assertRole(current, current.role_json, input);
    }),
    submitPlan: async (ownerId, runId, input) => {
      const parsed = GroupedPlanSchema.safeParse(input.plan);
      if (!parsed.success) throw new ApiFailure(422, "AGENT_OUTPUT_INVALID", "协调计划格式无效，请重新整理目标。");
      return owned(ownerId, async (client) => {
        const { current } = await lockedRun(client, ownerId, runId);
        const coordinator = await activeRole(client, current, { ...input, role: "coordinator" });
        const context = planningContext(current);
        if (!preservesPreviousBehavior(parsed.data, context.previousPlan, context.requestText)) {
          throw new ApiFailure(422, "PLAN_PREVIOUS_BEHAVIOR_REQUIRED", "修改计划必须保留全部旧必需行为及原有可观察结果；明确替代须记录用户本轮变更与新 ID。");
        }
        const base = current.base_revision_id ? await revision(client, ownerId, current.base_revision_id) : null;
        const task = ["原始需求：", context.originalRequest,
          ...context.clarificationTurns.flatMap((turn, index) => [`澄清 ${index + 1}：${turn.question}`, `已接受的回答：${turn.answer}`])].join("\n");
        const handoff = HandoffSchema.parse({ runId, fromRoleRunId: coordinator.id, toRole: "builder", attempt: current.attempt,
          baseRevisionId: current.base_revision_id, expectedRevisionId: null, sourceHash: base?.source_hash ?? null, plan: parsed.data, task, artifactIds: [] });
        const builderId = randomUUID();
        const builder = await client.query(`INSERT INTO nano.role_runs(id,owner_id,project_id,run_id,predecessor_id,role,attempt,session_id,state,input_json)
          VALUES($1,$2,$3,$4,$5,'builder',$6,$7,'queued',$8) RETURNING *`, [builderId, ownerId, current.project_id, runId, coordinator.id, current.attempt, randomUUID(), handoff]);
        const completed = await client.query("UPDATE nano.role_runs SET state='succeeded',finished_at=now(),output_json=$3,usage_json=$4 WHERE owner_id=$1 AND id=$2 RETURNING *",
          [ownerId, coordinator.id, { plan: parsed.data }, roleUsage(input.usage)]);
        const changed = await client.query("UPDATE nano.runs SET plan_json=$3,builder_role_run_id=$4,state='building',phase='provision' WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, runId, parsed.data, builderId]);
        await event(client, changed.rows[0], { type: "role.completed", roleRunId: coordinator.id, payload: { role: "coordinator", state: "succeeded", summary: parsed.data.changeSummary } });
        await event(client, changed.rows[0], { type: "run.phase", payload: { state: "building", phase: "provision" } });
        return { run: storedRun(changed.rows[0]), coordinator: storedRole(completed.rows[0]), builder: storedRole(builder.rows[0]), handoff };
      });
    },
    requestClarification: async (ownerId, runId, input) => {
      const request = ClarificationRequestSchema.safeParse({ question: input.question });
      if (!request.success) throw new ApiFailure(422, "AGENT_OUTPUT_INVALID", "协调者需要提供一个简洁的关键问题。");
      const question = request.data.question;
      return owned(ownerId, async (client) => {
        const { current } = await lockedRun(client, ownerId, runId);
        const coordinator = await activeRole(client, current, { ...input, role: "coordinator" });
        if (current.builder_role_run_id || current.plan_json) throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "已有工程师交接的任务不能改为等待补充信息。");
        const completed = await client.query("UPDATE nano.role_runs SET state='succeeded',finished_at=now(),output_json=$3,usage_json=$4 WHERE owner_id=$1 AND id=$2 RETURNING *",
          [ownerId, coordinator.id, { question }, roleUsage(input.usage)]);
        const changed = await client.query(`UPDATE nano.runs SET state='needs_input',phase='plan',cleanup_state='confirmed',clarification_json=$3,
          summary=$4,finished_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *`, [ownerId, runId, { question }, question]);
        await client.query("INSERT INTO nano.messages(owner_id,project_id,run_id,kind,content) VALUES($1,$2,$3,'question',$4)", [ownerId, current.project_id, runId, question]);
        await models.releaseInTransaction(client, ownerId, current.credential_lease_id);
        await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, current.project_id, runId]);
        await event(client, changed.rows[0], { type: "role.completed", roleRunId: coordinator.id, payload: { role: "coordinator", state: "succeeded", summary: question } });
        await event(client, changed.rows[0], { type: "run.finished", payload: { state: "needs_input", question } });
        return { run: storedRun(changed.rows[0]), coordinator: storedRole(completed.rows[0]) };
      });
    },
    getLatestRun: (ownerId, projectId) => owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const result = await client.query("SELECT * FROM nano.runs WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [ownerId, projectId]);
      return result.rows[0] ? storedRun(result.rows[0]) : null;
    }),
    listProjectMessages: (ownerId, projectId) => owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const result = await client.query("SELECT * FROM nano.messages WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at,id", [ownerId, projectId]);
      return result.rows.map(storedMessage);
    }),
    listEvents: (ownerId, runId, after = "0", limit = 200) => owned(ownerId, async (client) => {
      await run(client, ownerId, runId);
      if (!/^\d{1,18}$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiFailure(422, "INVALID_INPUT", "事件游标或数量无效。");
      const result = await client.query("SELECT * FROM nano.run_events WHERE owner_id=$1 AND run_id=$2 AND id>$3 ORDER BY id LIMIT $4", [ownerId, runId, after, limit]);
      return result.rows.map(storedEvent);
    }),
    readEventHead: (ownerId, runId) => owned(ownerId, async (client) => {
      // State and high watermark share one MVCC snapshot, including a racing finalization.
      const result = await client.query(`SELECT r.state, coalesce((SELECT max(e.id) FROM nano.run_events e
        WHERE e.owner_id=r.owner_id AND e.run_id=r.id),0)::text AS event_id
        FROM nano.runs r WHERE r.owner_id=$1 AND r.id=$2`, [ownerId, runId]);
      if (!result.rows[0]) throw notFound();
      return { eventId: result.rows[0].event_id, state: result.rows[0].state };
    }),
    listEventsThrough: (ownerId, runId, after, through, limit = 16) => owned(ownerId, async (client) => {
      await run(client, ownerId, runId);
      if (!/^\d{1,18}$/.test(after) || !/^\d{1,18}$/.test(through) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ApiFailure(422, "INVALID_INPUT", "事件游标或数量无效。");
      }
      const result = await client.query("SELECT * FROM nano.run_events WHERE owner_id=$1 AND run_id=$2 AND id>$3 AND id<=$4 ORDER BY id LIMIT $5", [ownerId, runId, after, through, limit]);
      return result.rows.map(storedEvent);
    }),
    appendEvent: (ownerId, runId, input) => owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      return event(client, current, input);
    }),
    async finishFailed(ownerId, runId, input) {
      return owned(ownerId, async (client) => {
        const { current, parent } = await lockedRun(client, ownerId, runId, false);
        if (TerminalRunStates.has(current.state)) return storedRun(current);
        if (parent.operation_id !== runId) throw new ApiFailure(409, "RUN_NOT_ACTIVE", "任务操作已失效。");
        if (input.resultRevisionId) {
          const found = await client.query("SELECT id FROM nano.revisions WHERE owner_id=$1 AND run_id=$2 AND id=$3", [ownerId, runId, input.resultRevisionId]);
          if (!found.rows[0]) throw notFound();
        }
        if (input.roleUsage) {
          const usage = roleUsage(input.roleUsage.usage);
          const role = await client.query(`SELECT id,state FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND id=$3 AND attempt=$4
            AND ((role='coordinator' AND id=$5) OR (role='builder' AND id=$6) OR (role='reviewer' AND id=$7))`,
          [ownerId, runId, input.roleUsage.roleRunId, current.attempt, current.coordinator_role_run_id, current.builder_role_run_id, current.reviewer_role_run_id]);
          if (!role.rows[0]) throw new ApiFailure(409, "STALE_ROLE", "执行结果来自其它角色或尝试。");
          // A later snapshot failure must not replace usage already committed by a successful role.
          if (role.rows[0].state === "running") await client.query(`UPDATE nano.role_runs SET usage_json=$4
            WHERE owner_id=$1 AND run_id=$2 AND id=$3 AND state='running'`,
          [ownerId, runId, input.roleUsage.roleRunId, usage]);
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
    setPhase: (ownerId, runId, input) => owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      const state = input.state ?? current.state;
      const permitted: Record<string, string[]> = { accepted: ["accepted", "building"], building: ["building", "verifying"], verifying: ["verifying"] };
      if (!permitted[current.state]?.includes(state)) throw new ApiFailure(409, "INVALID_RUN_TRANSITION", "当前阶段不能进行这个状态切换。");
      if (state === current.state && input.phase === current.phase) return storedRun(current);
      const changed = await client.query("UPDATE nano.runs SET state=$3,phase=$4 WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, runId, state, input.phase]);
      await event(client, changed.rows[0], { type: "run.phase", payload: { state, phase: input.phase } });
      return storedRun(changed.rows[0]);
    }),
    startBuilder: (ownerId, runId) => owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      if (!current.plan_json || !current.builder_role_run_id) throw new ApiFailure(409, "PLAN_REQUIRED", "协调者尚未提交有效计划。");
      const prior = await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND id=$2 AND run_id=$3", [ownerId, current.builder_role_run_id, runId]);
      if (prior.rows[0]?.state === "running") return storedRole(prior.rows[0]);
      if (prior.rows[0]?.state !== "queued") throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "工程师角色已经结束。");
      const updated = await client.query("UPDATE nano.role_runs SET state='running',started_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, current.builder_role_run_id]);
      await client.query("UPDATE nano.runs SET state='building',phase='implement' WHERE owner_id=$1 AND id=$2", [ownerId, runId]);
      await event(client, current, { type: "role.started", roleRunId: current.builder_role_run_id, payload: { role: "builder", phase: "implement" } });
      return storedRole(updated.rows[0]);
    }),
    completeBuilder: (ownerId, runId, input = {}) => owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      const prior = await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND id=$2 AND run_id=$3", [ownerId, current.builder_role_run_id, runId]);
      if (prior.rows[0]?.state === "succeeded") return storedRole(prior.rows[0]);
      if (prior.rows[0]?.state !== "running") throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "工程师角色尚未开始或已经失败。");
      const updated = await client.query("UPDATE nano.role_runs SET state='succeeded',finished_at=now(),output_json=$3,usage_json=$4 WHERE owner_id=$1 AND id=$2 RETURNING *",
        [ownerId, current.builder_role_run_id, { summary: input.summary?.slice(0, 4000) ?? null }, roleUsage(input.usage)]);
      await event(client, current, { type: "role.completed", roleRunId: current.builder_role_run_id, payload: { role: "builder", state: "succeeded", summary: input.summary?.slice(0, 4000) ?? null } });
      return storedRole(updated.rows[0]);
    }),
    queueReviewer: (ownerId, runId, input) => owned(ownerId, async (client) => {
      const { current, parent } = await lockedRun(client, ownerId, runId);
      if (date(current.deadline_at).getTime() <= Date.now()) throw new ApiFailure(409, "RUN_TIMEOUT", "任务已达到时间上限。");
      if (parent.current_revision_id !== current.expected_current_revision_id) throw new ApiFailure(409, "STALE_BASE", "当前版本已经变化，不能继续检查。");
      const saved = await revision(client, ownerId, input.revisionId);
      if (saved.run_id !== runId || saved.project_id !== current.project_id || saved.attempt !== current.attempt
        || current.result_revision_id !== saved.id || saved.build_status !== "passed" || saved.status !== "candidate") {
        throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "候选版本尚未通过构建或与当前任务不匹配。");
      }
      const binding = (await client.query(`SELECT * FROM nano.sandboxes WHERE owner_id=$1 AND run_id=$2 AND attempt=$3
        AND revision_id=$4 AND source_hash=$5 AND purpose='candidate-preview' AND state='active' AND expires_at>now()`,
      [ownerId, runId, current.attempt, saved.id, saved.source_hash])).rows[0];
      if (!binding) throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "没有可供检查的有效候选预览。");
      if (current.reviewer_role_run_id) {
        const existing = (await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND id=$3", [ownerId, runId, current.reviewer_role_run_id])).rows[0];
        if (existing?.state !== "queued" || current.state !== "verifying") throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "检查者交接已经执行或失效。");
        const execution = reviewerExecution(existing);
        if (execution.scope.revisionId !== saved.id || execution.scope.sandboxId !== binding.remote_id) throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "已保存的检查交接与预览不匹配。");
        return execution;
      }
      const builder = (await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND id=$3 AND role='builder' AND attempt=$4", [ownerId, runId, current.builder_role_run_id, current.attempt])).rows[0];
      if (current.state !== "building" || builder?.state !== "succeeded") throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "工程师尚未完成，不能交给检查者。");
      const id = randomUUID();
      const scope = ReviewBindingSchema.parse({ runId, roleRunId: id, attempt: current.attempt, revisionId: saved.id,
        sourceHash: saved.source_hash, sandboxId: binding.remote_id, browserSessionId: `pivloom-${randomUUID()}` });
      const handoff = HandoffSchema.parse({ runId, fromRoleRunId: builder.id, toRole: "reviewer", attempt: current.attempt,
        baseRevisionId: current.base_revision_id, expectedRevisionId: saved.id, sourceHash: saved.source_hash,
        plan: PlanSchema.parse(current.plan_json), task: "在绑定的候选预览中实际操作并检查计划行为，记录动作后的观察。", artifactIds: [] });
      const inserted = await client.query(`INSERT INTO nano.role_runs(id,owner_id,project_id,run_id,predecessor_id,role,attempt,session_id,state,input_json,review_binding_json)
        VALUES($1,$2,$3,$4,$5,'reviewer',$6,$7,'queued',$8,$9) RETURNING *`,
      [id, ownerId, current.project_id, runId, builder.id, current.attempt, randomUUID(), handoff, scope]);
      const changed = await client.query("UPDATE nano.runs SET reviewer_role_run_id=$3,state='verifying',phase='review' WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, runId, id]);
      await event(client, changed.rows[0], { type: "run.phase", payload: { state: "verifying", phase: "review" } });
      return reviewerExecution(inserted.rows[0]);
    }),
    startReviewer: (ownerId, runId) => owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      if (date(current.deadline_at).getTime() <= Date.now()) throw new ApiFailure(409, "RUN_TIMEOUT", "任务已达到时间上限。");
      const prior = (await client.query("SELECT * FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND id=$3 AND role='reviewer' AND attempt=$4", [ownerId, runId, current.reviewer_role_run_id, current.attempt])).rows[0];
      if (current.state !== "verifying" || !prior || !["queued", "running"].includes(prior.state)) throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "检查者尚未排入或已经结束。");
      const execution = reviewerExecution(prior);
      const binding = (await client.query(`SELECT id FROM nano.sandboxes WHERE owner_id=$1 AND run_id=$2 AND attempt=$3
        AND revision_id=$4 AND source_hash=$5 AND remote_id=$6 AND state='active' AND purpose='candidate-preview' AND expires_at>now()`,
      [ownerId, runId, current.attempt, execution.scope.revisionId, execution.scope.sourceHash, execution.scope.sandboxId])).rows[0];
      if (!binding) throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "检查者绑定的预览已不可用。");
      if (prior.state === "running") return execution;
      const updated = await client.query("UPDATE nano.role_runs SET state='running',started_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, prior.id]);
      await event(client, current, { type: "role.started", roleRunId: prior.id, payload: { role: "reviewer", phase: "review" } });
      return reviewerExecution(updated.rows[0]);
    }),
    finishReview: async (ownerId, runId, input) => {
      const { receipt } = input;
      assertVerifiedReviewReceipt(receipt);
      if (receipt.source.ownerId !== ownerId) throw notFound();
      const binding = ReviewBindingSchema.parse(receipt.binding);
      const result = ReviewResultSchema.parse(receipt.result);
      const artifacts = z.array(storedArtifactSchema).max(MAX_CHECK_ARTIFACTS).parse(receipt.artifacts);
      const evidence = reviewEvidenceSchema.parse(receipt.evidence);
      boundedJson({ evidence }, 512 * 1024);
      if (receipt.chromeClosed !== true || binding.runId !== runId || result.revisionId !== binding.revisionId
        || result.sourceHash !== binding.sourceHash) throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "检查结果尚未完成会话关闭或版本校验。");
      return owned(ownerId, async (client) => {
        const { current, parent } = await lockedRun(client, ownerId, runId);
        const role = await activeRole(client, current, { roleRunId: binding.roleRunId, attempt: binding.attempt, role: "reviewer" });
        const storedBinding = ReviewBindingSchema.parse(role.review_binding_json);
        if (Object.keys(storedBinding).some((key) => Reflect.get(storedBinding, key) !== Reflect.get(binding, key))) {
          throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "检查结果来自其它版本、沙箱或浏览器会话。");
        }
        if (parent.current_revision_id !== current.expected_current_revision_id) throw new ApiFailure(409, "STALE_BASE", "当前成功版本已经变化，未提交此次检查。");
        const saved = await revision(client, ownerId, binding.revisionId);
        if (saved.run_id !== runId || saved.project_id !== current.project_id || saved.attempt !== current.attempt
          || current.result_revision_id !== saved.id || saved.status !== "candidate" || saved.source_hash !== binding.sourceHash
          || receipt.source.projectId !== saved.project_id || receipt.source.revisionId !== saved.id
          || receipt.source.sourceHash !== saved.source_hash || receipt.source.key !== saved.source_key) {
          throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "检查结果或已验证源码对象与当前候选不一致。");
        }
        const build = saved.build_json;
        if (saved.build_status !== "passed" || build?.schemaVersion !== 1 || build.sourceHash !== saved.source_hash
          || build.typecheck?.exitCode !== 0 || build.build?.exitCode !== 0) throw new ApiFailure(409, "BUILD_NOT_VERIFIED", "候选缺少与源码匹配的可信构建记录。");
        const sandbox = (await client.query(`SELECT * FROM nano.sandboxes WHERE owner_id=$1 AND run_id=$2 AND attempt=$3
          AND remote_id=$4 AND revision_id=$5 AND source_hash=$6 AND purpose='candidate-preview' AND state='active' AND expires_at>now()`,
        [ownerId, runId, binding.attempt, binding.sandboxId, saved.id, saved.source_hash])).rows[0];
        if (!sandbox) throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "检查结果绑定的候选预览已经失效。");
        const plan = PlanSchema.parse(current.plan_json);
        const byBehavior = new Map(plan.behaviors.map((behavior) => [behavior.id, behavior]));
        const observations = new Map(evidence.map((observation) => [observation.id, observation]));
        const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
        if (observations.size !== evidence.length || artifactIds.size !== artifacts.length) throw new ApiFailure(422, "AGENT_OUTPUT_INVALID", "检查证据标识重复。");
        for (const artifact of artifacts) {
          if (artifact.key !== `${ownerId}/${saved.project_id}/${saved.id}/checks/${artifact.id}.png`) throw new ApiFailure(409, "REVIEW_BINDING_MISMATCH", "检查工件不属于当前候选。");
        }
        for (const item of result.items) {
          const behavior = byBehavior.get(item.behaviorId);
          const itemObservations = item.observationEventIds.map((id) => observations.get(id));
          const actionEvidence = itemObservations.some((observation) => observation?.behaviorId === item.behaviorId
            && observation.action && observation.action !== "scroll"
            && !(observation.action === "press" && observation.key === "Tab"));
          // Static pages have no interactive element: a real check observation
          // plus a captured screenshot is render/content verification, matching
          // the Reviewer's own evidence rule.
          const renderedEvidence = Boolean(behavior && allowsRenderOnlyEvidence(behavior))
            && item.observationEventIds.length >= 1 && item.screenshotIds.length > 0;
          if (!behavior || item.expected !== behavior.expected || item.screenshotIds.some((id) => !artifactIds.has(id))
            || item.observationEventIds.some((id) => !observations.has(id))
            || item.verdict !== "blocked" && !actionEvidence && !renderedEvidence) {
            throw new ApiFailure(422, "AGENT_OUTPUT_INVALID", "检查结果缺少相同目标的实际动作及后续观察。");
          }
        }
        let groups: ReturnType<typeof aggregateCheckGroups> | undefined;
        if (plan.schemaVersion === 2) {
          try { groups = aggregateCheckGroups(plan, result.items); }
          catch { throw new ApiFailure(422, "AGENT_OUTPUT_INVALID", "检查结果未覆盖五组全部子检查及原始证据。"); }
        }
        const verdict = !receipt.markerVerified || groups?.some((group) => group.verdict === "blocked")
          || result.items.some((item) => item.verdict === "blocked") ? "blocked"
          : groups?.some((group) => group.verdict === "failed") || result.items.some((item) => item.verdict === "failed") ? "failed" : "passed";
        const repairNextAttempt = verdict === "failed" && current.attempt < 2 ? current.attempt + 1 : null;
        if (verdict === "passed" && plan.behaviors.some((behavior) => behavior.required && !result.items.some((item) => item.behaviorId === behavior.id && item.verdict === "passed"))) {
          throw new ApiFailure(422, "AGENT_OUTPUT_INVALID", "仍有必需行为未完成检查。");
        }
        const check = (await client.query(`INSERT INTO nano.checks(id,owner_id,project_id,run_id,role_run_id,attempt,revision_id,source_hash,sandbox_id,browser_session_id,verdict,items_json,artifacts_json,evidence_json,summary,group_results_json)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [randomUUID(), ownerId, current.project_id, runId, role.id, binding.attempt, saved.id, binding.sourceHash, binding.sandboxId,
          binding.browserSessionId, verdict, JSON.stringify(result.items), JSON.stringify(artifacts), JSON.stringify(evidence), result.summary,
          groups ? JSON.stringify(groups) : null])).rows[0];
        const publicCheck = storedCheck(check);
        await client.query("UPDATE nano.role_runs SET state=$3,finished_at=now(),output_json=$4,usage_json=$5 WHERE owner_id=$1 AND id=$2",
          [ownerId, role.id, verdict === "blocked" ? "failed" : "succeeded", result, roleUsage(input.usage)]);
        const changedRevision = (await client.query("UPDATE nano.revisions SET status=$3 WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, saved.id, verdict === "passed" ? "accepted" : verdict === "failed" && !repairNextAttempt ? "rejected" : "candidate"])).rows[0];
        const state = repairNextAttempt ? "repairing" : verdict === "passed" ? "completed" : verdict === "failed" ? "needs_changes" : "failed";
        const changed = (await client.query(`UPDATE nano.runs SET state=$3,phase=$4,cleanup_state='clear',summary=$5,
          error_code=$6,error_message=$7,error_retryable=$8,finished_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *`,
        [ownerId, runId, state, repairNextAttempt ? "implement" : "persist", result.summary, verdict === "blocked" ? "CHECK_BLOCKED" : null, verdict === "blocked" ? result.summary : null, verdict === "blocked" ? true : null])).rows[0];
        if (verdict === "passed") {
          await client.query("UPDATE nano.projects SET current_revision_id=$3 WHERE owner_id=$1 AND id=$2", [ownerId, current.project_id, saved.id]);
          await client.query("UPDATE nano.sandboxes SET purpose='preview' WHERE owner_id=$1 AND id=$2", [ownerId, sandbox.id]);
        }
        if (!repairNextAttempt) {
          await client.query("INSERT INTO nano.messages(owner_id,project_id,run_id,kind,content) VALUES($1,$2,$3,'result',$4)", [ownerId, current.project_id, runId, result.summary]);
          await models.releaseInTransaction(client, ownerId, current.credential_lease_id);
          await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, current.project_id, runId]);
        }
        await event(client, changed, { type: "role.completed", roleRunId: role.id, payload: { role: "reviewer", state: verdict === "blocked" ? "failed" : "succeeded", summary: result.summary } });
        await event(client, changed, { type: "check.completed", roleRunId: role.id, payload: { checkId: check.id, revisionId: saved.id, sourceHash: saved.source_hash, verdict, summary: result.summary,
          ...(groups ? { passedGroups: groups.filter((group) => group.verdict === "passed").length, totalGroups: 5 } : {}) } });
        if (!repairNextAttempt) {
          await event(client, changed, { type: "run.finished", payload: { state, revisionId: saved.id, checkId: check.id } });
        }
        return { run: storedRun(changed), check: publicCheck, revision: storedRevision(changedRevision), repairNextAttempt };
      });
    },
    getCheck: (ownerId, checkId) => owned(ownerId, async (client) => {
      const row = (await client.query("SELECT * FROM nano.checks WHERE owner_id=$1 AND id=$2", [ownerId, checkId])).rows[0];
      if (!row) throw notFound();
      return storedCheck(row);
    }),
    getRunCheck: (ownerId, runId) => owned(ownerId, async (client) => {
      await run(client, ownerId, runId);
      const row = (await client.query("SELECT * FROM nano.checks WHERE owner_id=$1 AND run_id=$2 ORDER BY attempt DESC LIMIT 1", [ownerId, runId])).rows[0];
      return row ? storedCheck(row) : null;
    }),
    getArtifact: (ownerId, artifactId) => owned(ownerId, async (client) => {
      if (!z.uuid().safeParse(artifactId).success) throw notFound();
      const row = (await client.query(`SELECT c.id AS check_id,c.revision_id,a.artifact FROM nano.checks c
        CROSS JOIN LATERAL jsonb_array_elements(c.artifacts_json) a(artifact)
        WHERE c.owner_id=$1 AND a.artifact->>'id'=$2`, [ownerId, artifactId])).rows[0];
      if (!row) throw notFound();
      const saved = storedRevision(await revision(client, ownerId, row.revision_id));
      return { artifact: storedArtifactSchema.parse(row.artifact), source: saved.source, checkId: row.check_id };
    }),
    saveCandidate: async (ownerId, runId, input) => {
      assertVerifiedSourceSnapshot(input.source);
      if (input.source.ownerId !== ownerId) throw notFound();
      return owned(ownerId, async (client) => {
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
    getRevision: (ownerId, revisionId) => owned(ownerId, async (client) => storedRevision(await revision(client, ownerId, revisionId))),
    listProjectRevisions: (ownerId, projectId) => owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const result = await client.query("SELECT * FROM nano.revisions WHERE owner_id=$1 AND project_id=$2 ORDER BY revision_no DESC,id DESC", [ownerId, projectId]);
      return result.rows.map(storedRevision);
    }),
    readProjectVersionHistory: (ownerId, projectId) => owned(ownerId, async (client) => {
      const result = await client.query(`SELECT p.current_revision_id,
        coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.revision_no DESC,v.id DESC)
          FILTER (WHERE v.id IS NOT NULL),'[]'::jsonb) AS revisions_json
        FROM nano.projects p
        LEFT JOIN nano.revisions v ON v.owner_id=p.owner_id AND v.project_id=p.id
        WHERE p.owner_id=$1 AND p.id=$2 GROUP BY p.id`, [ownerId, projectId]);
      const row = result.rows[0];
      if (!row) throw notFound();
      return { currentRevisionId: row.current_revision_id as string | null,
        revisions: (row.revisions_json as Row[]).map(storedRevision) };
    }),
    registerSandbox: (ownerId, runId, input) => owned(ownerId, async (client) => {
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
    bindPreview: (ownerId, runId, input) => owned(ownerId, async (client) => {
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
    getPreviewBinding: (ownerId, projectId, revisionId) => owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const saved = await revision(client, ownerId, revisionId);
      if (saved.project_id !== projectId) throw notFound();
      const result = await client.query("SELECT * FROM nano.sandboxes WHERE owner_id=$1 AND project_id=$2 AND revision_id=$3 AND purpose IN ('candidate-preview','preview') ORDER BY created_at DESC LIMIT 1", [ownerId, projectId, revisionId]);
      return result.rows[0] ? storedSandbox(result.rows[0]) : null;
    }),
    markDestroyed: (ownerId, runId, sandboxId) => owned(ownerId, async (client) => {
      await lockedRun(client, ownerId, runId, false);
      const result = await client.query("UPDATE nano.sandboxes SET state='destroyed',last_checked_at=now() WHERE owner_id=$1 AND run_id=$2 AND remote_id=$3 RETURNING id", [ownerId, runId, sandboxId]);
      if (!result.rows[0]) throw notFound();
    }),
    markCleanupPending: (ownerId, runId, message) => owned(ownerId, async (client) => {
      const { parent } = await lockedRun(client, ownerId, runId, false);
      if (parent.operation_id !== runId) throw new ApiFailure(409, "RUN_NOT_ACTIVE", "不能重新占用已释放的项目操作。");
      const result = await client.query("UPDATE nano.runs SET cleanup_state='pending',phase='cleanup' WHERE owner_id=$1 AND id=$2 RETURNING *", [ownerId, runId]);
      await event(client, result.rows[0], { type: "run.phase", payload: { phase: "cleanup", cleanupState: "pending", message: message.slice(0, 2000) } });
      return storedRun(result.rows[0]);
    }),
    confirmCleanup: (ownerId, runId) => owned(ownerId, async (client) => {
      const { current, parent } = await lockedRun(client, ownerId, runId, false);
      if (!TerminalRunStates.has(current.state)) throw new ApiFailure(409, "RUN_STILL_ACTIVE", "任务尚未结束，不能释放清理占用。");
      if (current.cleanup_state !== "pending") return storedRun(current);
      if (parent.operation_id !== runId) throw new ApiFailure(409, "RUN_NOT_ACTIVE", "项目操作与待清理任务不一致。");
      const confirmedSummary = "任务已停止，远端模型调用与沙箱已确认回收。";
      const result = await client.query(`UPDATE nano.runs SET cleanup_state='confirmed',
        summary=CASE WHEN state='cancelled' THEN $3 ELSE summary END,
        error_message=CASE WHEN state='cancelled' AND error_code='CANCELLED' THEN $3 ELSE error_message END
        WHERE owner_id=$1 AND id=$2 RETURNING *`, [ownerId, runId, confirmedSummary]);
      if (current.state === "cancelled") {
        await client.query("UPDATE nano.messages SET content=$4 WHERE owner_id=$1 AND project_id=$2 AND run_id=$3 AND kind='result'",
          [ownerId, current.project_id, runId, confirmedSummary]);
      }
      await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, current.project_id, runId]);
      await event(client, result.rows[0], { type: "run.phase", payload: { phase: "cleanup", cleanupState: "confirmed", message: current.state === "cancelled" ? confirmedSummary : undefined } });
      return storedRun(result.rows[0]);
    }),
    listReferencedSourceKeys: (ownerId, projectId) => owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const result = await client.query<{ source_key: string }>("SELECT source_key FROM nano.revisions WHERE owner_id=$1 AND project_id=$2", [ownerId, projectId]);
      return result.rows.map((row) => row.source_key);
    }),
    // Cancellation is idempotent and always durable before any remote work:
    // the row moves to cancel_requested (which keeps the project operation lock
    // and the global slot) and only the executor may confirm the terminal state.
    cancel: (ownerId, runId) => owned(ownerId, async (client) => {
      const { current, parent } = await lockedRun(client, ownerId, runId, false);
      if (TerminalRunStates.has(current.state)) return storedRun(current);
      if (parent.operation_id !== runId) throw new ApiFailure(409, "RUN_NOT_ACTIVE", "这个任务已停止接受执行结果。");
      if (current.state === "cancel_requested") return storedRun(current);
      const changed = (await client.query(`UPDATE nano.runs SET state='cancel_requested',phase='cleanup',
        cleanup_state='pending',summary='正在停止：等待远端模型与沙箱清理确认。'
        WHERE owner_id=$1 AND id=$2 RETURNING *`, [ownerId, runId])).rows[0];
      await event(client, changed, { type: "run.cancel_requested", payload: { state: "cancel_requested" } });
      return storedRun(changed);
    }),
    finishCancelled: (ownerId, runId, input) => owned(ownerId, async (client) => {
      const current = await run(client, ownerId, runId);
      if (TerminalRunStates.has(current.state)) return storedRun(current);
      const changed = (await client.query(`UPDATE nano.runs SET state='cancelled',phase='cleanup',cleanup_state=$3,summary=$4,
        error_code='CANCELLED',error_message=$4,error_retryable=true,finished_at=coalesce(finished_at,now())
        WHERE owner_id=$1 AND id=$2 RETURNING *`, [ownerId, runId, input.cleanupState, input.summary])).rows[0];
      await client.query("UPDATE nano.role_runs SET state='cancelled',finished_at=coalesce(finished_at,now()) WHERE owner_id=$1 AND run_id=$2 AND state IN ('queued','running')", [ownerId, runId]);
      await client.query(`INSERT INTO nano.messages(owner_id,project_id,run_id,kind,content) VALUES($1,$2,$3,'result',$4)
        ON CONFLICT (run_id,kind) DO NOTHING`, [ownerId, changed.project_id, runId, input.summary]);
      if (input.cleanupState === "confirmed")
        await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, changed.project_id, runId]);
      await event(client, changed, { type: "run.finished", payload: { state: "cancelled", cleanupState: input.cleanupState } });
      return storedRun(changed);
    }),
    finishBuildFailure: (ownerId, runId, input) => owned(ownerId, async (client) => {
      const { current, parent } = await lockedRun(client, ownerId, runId);
      const role = await activeRole(client, current, { roleRunId: current.builder_role_run_id, attempt: current.attempt, role: "builder" });
      if (parent.current_revision_id !== current.expected_current_revision_id)
        throw new ApiFailure(409, "STALE_BASE", "当前成功版本已经变化，未提交此次构建失败。");
      const saved = await revision(client, ownerId, input.revisionId);
      if (saved.run_id !== runId || saved.project_id !== current.project_id || saved.attempt !== current.attempt
        || current.result_revision_id !== saved.id || saved.status !== "candidate" || saved.build_status !== "failed")
        throw new ApiFailure(409, "SNAPSHOT_CONFLICT", "构建诊断与当前尝试保存的候选不一致。");
      const build = saved.build_json;
      const failedCommand = input.code === "TYPECHECK_FAILED" ? build?.typecheck
        : input.code === "BUILD_FAILED" && build?.typecheck?.exitCode === 0 ? build?.build : null;
      if (build?.schemaVersion !== 1 || build.sourceHash !== saved.source_hash
        || !Number.isInteger(failedCommand?.exitCode) || failedCommand.exitCode === 0)
        throw new ApiFailure(409, "BUILD_NOT_VERIFIED", "候选缺少与源码匹配的可信构建失败记录。");
      const repairNextAttempt = current.attempt < 2 ? current.attempt + 1 : null;
      const state = repairNextAttempt ? "repairing" : "needs_changes";
      const message = input.message.slice(0, 2000);
      const summary = repairNextAttempt ? "候选构建未通过，正在修复。" : "已完成两轮修复，候选构建仍未通过。";
      await client.query("UPDATE nano.role_runs SET state='failed',finished_at=now(),output_json=$3,usage_json=$4 WHERE owner_id=$1 AND id=$2",
        [ownerId, role.id, { code: input.code, message }, roleUsage(input.usage)]);
      const changedRevision = (await client.query("UPDATE nano.revisions SET status=$3 WHERE owner_id=$1 AND id=$2 RETURNING *",
        [ownerId, saved.id, repairNextAttempt ? "candidate" : "rejected"])).rows[0];
      const changed = (await client.query(`UPDATE nano.runs SET state=$3,phase=$4,summary=$5,error_code=$6,error_message=$7,
        error_retryable=true,finished_at=CASE WHEN $8::boolean THEN NULL ELSE now() END
        WHERE owner_id=$1 AND id=$2 RETURNING *`,
      [ownerId, runId, state, repairNextAttempt ? "implement" : "persist", summary, input.code, message, repairNextAttempt !== null])).rows[0];
      await event(client, changed, { type: "role.completed", roleRunId: role.id, payload: { role: "builder", state: "failed", summary: message } });
      if (repairNextAttempt) {
        await event(client, changed, { type: "run.phase", payload: { state, phase: "implement", reason: "build_failed", revisionId: saved.id } });
      } else {
        await client.query("INSERT INTO nano.messages(owner_id,project_id,run_id,kind,content) VALUES($1,$2,$3,'result',$4)", [ownerId, current.project_id, runId, summary]);
        await models.releaseInTransaction(client, ownerId, current.credential_lease_id);
        await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, current.project_id, runId]);
        await event(client, changed, { type: "run.finished", payload: { state, revisionId: saved.id, error: { code: input.code, message, retryable: true } } });
      }
      return { run: storedRun(changed), revision: storedRevision(changedRevision), repairNextAttempt };
    }),
    quota: (ownerId) => owned(ownerId, async (client) => {
      const row = (await client.query("SELECT count(*)::int AS accepted FROM nano.runs WHERE owner_id=$1 AND created_at > now() - interval '24 hours'", [ownerId])).rows[0];
      return { dailyLimit: options.dailyLimitByOwner?.[ownerId] ?? DAILY_ACCEPTED_LIMIT, dailyAccepted: row.accepted as number };
    }),
    // A repair stays inside the same run: same deadline, same shared token and
    // tool ledgers. Only the attempt number, the builder role and the handoff
    // change, so every attempt keeps its own immutable candidate revision.
    startRepairBuilder: (ownerId, runId, input) => owned(ownerId, async (client) => {
      const { current } = await lockedRun(client, ownerId, runId);
      if (current.state !== "repairing") throw new ApiFailure(409, "ROLE_NOT_ACTIVE", "这个任务当前不在可修复状态。");
      if (!Number.isInteger(input.attempt) || input.attempt !== current.attempt + 1 || input.attempt > 2)
        throw new ApiFailure(409, "STALE_ATTEMPT", "修复轮次与当前尝试不匹配。");
      if (date(current.deadline_at).getTime() <= Date.now()) throw new ApiFailure(409, "RUN_TIMEOUT", "任务已达到时间上限。");
      const previous = await revision(client, ownerId, input.previousRevisionId);
      if (previous.run_id !== runId || previous.project_id !== current.project_id || previous.attempt !== current.attempt)
        throw new ApiFailure(409, "SNAPSHOT_CONFLICT", "待修复候选与当前任务不匹配。");
      const plan = PlanSchema.parse(current.plan_json);
      const reviewer = await client.query("SELECT id FROM nano.role_runs WHERE owner_id=$1 AND run_id=$2 AND role='reviewer' AND attempt=$3", [ownerId, runId, current.attempt]);
      const predecessorId = reviewer.rows[0]?.id ?? current.builder_role_run_id;
      const id = randomUUID();
      const handoff = HandoffSchema.parse({ runId, fromRoleRunId: predecessorId, toRole: "builder",
        attempt: input.attempt, baseRevisionId: current.base_revision_id, expectedRevisionId: previous.id,
        sourceHash: previous.source_hash, plan,
        task: reviewer.rows[0] ? "上一轮候选未通过独立检查。请只修复下列问题，并保持其它行为与原有实现不变："
          : "上一轮候选未通过可信构建。请修复下列构建错误，并保持其它行为与原有实现不变：",
        failedChecks: input.failedChecks.slice(0, 5).map((check) => check.slice(0, 1000)), artifactIds: [] });
      const inserted = await client.query(`INSERT INTO nano.role_runs(id,owner_id,project_id,run_id,predecessor_id,role,attempt,session_id,state,input_json)
        VALUES($1,$2,$3,$4,$5,'builder',$6,$7,'queued',$8) RETURNING *`,
      [id, ownerId, current.project_id, runId, predecessorId, input.attempt, randomUUID(), handoff]);
      const changed = (await client.query(`UPDATE nano.runs SET attempt=$3,state='building',phase='implement',
        builder_role_run_id=$4,reviewer_role_run_id=NULL,summary=NULL,error_code=NULL,error_message=NULL,error_retryable=NULL,finished_at=NULL
        WHERE owner_id=$1 AND id=$2 RETURNING *`, [ownerId, runId, input.attempt, id])).rows[0];
      await event(client, changed, { type: "run.phase", payload: { state: "building", phase: "implement", attempt: input.attempt, reason: "repair" } });
      return storedRole(inserted.rows[0]);
    }),
    beginRestore: (ownerId, projectId, input) => owned(ownerId, async (client) => {
      const parent = await project(client, ownerId, projectId, true);
      if (!z.uuid().safeParse(input.idempotencyKey).success) throw new ApiFailure(422, "INVALID_INPUT", "恢复请求标识格式不正确。");
      const saved = await revision(client, ownerId, input.revisionId);
      if (saved.project_id !== projectId) throw notFound();
      const previous = (await client.query("SELECT * FROM nano.preview_restores WHERE owner_id=$1 AND project_id=$2 AND idempotency_key=$3", [ownerId, projectId, input.idempotencyKey])).rows[0];
      if (previous) {
        if (previous.revision_id !== input.revisionId) throw new ApiFailure(409, "IDEMPOTENCY_CONFLICT", "同一请求标识对应的版本不同。");
        return { restore: storedRestore(previous), revision: storedRevision(saved), replayed: true };
      }
      if (parent.operation_id) throw new ApiFailure(409, "PROJECT_BUSY", "当前项目仍有执行或清理操作。", true);
      if (saved.build_status !== "passed") throw new ApiFailure(422, "PREVIEW_NOT_RESTORABLE", "这个版本的构建未通过，只能查看已保存的源码与诊断。");
      const id = randomUUID();
      const inserted = (await client.query(`INSERT INTO nano.preview_restores
        (id,owner_id,project_id,revision_id,source_hash,idempotency_key,status) VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [id, ownerId, projectId, input.revisionId, saved.source_hash, input.idempotencyKey])).rows[0];
      await client.query("UPDATE nano.projects SET operation_kind='restore',operation_id=$3,operation_started_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, projectId, id]);
      return { restore: storedRestore(inserted), revision: storedRevision(saved), replayed: false };
    }),
    registerRestoreSandbox: (ownerId, projectId, restoreId, input) => owned(ownerId, async (client) => {
      const parent = await project(client, ownerId, projectId, true);
      const restore = (await client.query("SELECT * FROM nano.preview_restores WHERE owner_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE", [ownerId, projectId, restoreId])).rows[0];
      if (!restore) throw notFound();
      if (restore.status !== "pending" || restore.error_code || parent.operation_id !== restoreId)
        throw new ApiFailure(409, "RESTORE_NOT_ACTIVE", "本次预览恢复已经结束或正在等待清理。");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(input.sandboxId)) throw new ApiFailure(422, "INVALID_SANDBOX_BINDING", "沙箱标识无效。");
      if (restore.sandbox_id) {
        if (restore.sandbox_id !== input.sandboxId) throw new ApiFailure(409, "RESTORE_BINDING_MISMATCH", "恢复沙箱与已登记资源不一致。");
        return storedRestore(restore);
      }
      const saved = await revision(client, ownerId, restore.revision_id);
      await client.query(`INSERT INTO nano.sandboxes(owner_id,project_id,run_id,attempt,remote_id,revision_id,source_hash,purpose,state,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'preview','creating',$8)`,
      [ownerId, projectId, saved.run_id, saved.attempt, input.sandboxId, restore.revision_id, restore.source_hash, input.expiresAt]);
      const changed = (await client.query("UPDATE nano.preview_restores SET sandbox_id=$4 WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING *",
        [ownerId, projectId, restoreId, input.sandboxId])).rows[0];
      return storedRestore(changed);
    }),
    markRestoreSandboxDestroyed: (ownerId, projectId, restoreId, sandboxId) => owned(ownerId, async (client) => {
      await project(client, ownerId, projectId, true);
      const restore = (await client.query("SELECT * FROM nano.preview_restores WHERE owner_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE", [ownerId, projectId, restoreId])).rows[0];
      if (!restore) throw notFound();
      // Creation may fail before its registration commits; a confirmed remote
      // deletion then has no durable binding to update.
      if (!restore.sandbox_id) return;
      if (restore.sandbox_id !== sandboxId) throw new ApiFailure(409, "RESTORE_BINDING_MISMATCH", "恢复沙箱与已登记资源不一致。");
      await client.query(`UPDATE nano.sandboxes SET state='destroyed',last_checked_at=now()
        WHERE owner_id=$1 AND project_id=$2 AND revision_id=$3 AND remote_id=$4 AND purpose='preview'`,
      [ownerId, projectId, restore.revision_id, sandboxId]);
      if (restore.status === "pending" && restore.error_code) {
        await client.query("UPDATE nano.preview_restores SET status='failed',finished_at=now() WHERE owner_id=$1 AND id=$2", [ownerId, restoreId]);
        await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, projectId, restoreId]);
      }
    }),
    bindRestore: (ownerId, projectId, restoreId, input) => owned(ownerId, async (client) => {
      const parent = await project(client, ownerId, projectId, true);
      const restore = (await client.query("SELECT * FROM nano.preview_restores WHERE owner_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE", [ownerId, projectId, restoreId])).rows[0];
      if (!restore) throw notFound();
      if (restore.sandbox_id !== input.sandboxId) throw new ApiFailure(409, "RESTORE_BINDING_MISMATCH", "恢复沙箱与已登记资源不一致。");
      if (restore.status === "ready") return storedRestore(restore);
      if (restore.status !== "pending" || restore.error_code || parent.operation_id !== restoreId)
        throw new ApiFailure(409, "RESTORE_NOT_ACTIVE", "本次预览恢复已经结束或正在等待清理。");
      const saved = await revision(client, ownerId, restore.revision_id);
      const binding = await client.query(`UPDATE nano.sandboxes SET state='active',expires_at=$5,last_checked_at=now()
        WHERE owner_id=$1 AND project_id=$2 AND revision_id=$3 AND remote_id=$4 AND source_hash=$6
          AND purpose='preview' AND state='creating' RETURNING id`,
      [ownerId, projectId, restore.revision_id, input.sandboxId, input.expiresAt, restore.source_hash]);
      if (!binding.rows[0]) throw new ApiFailure(409, "RESTORE_BINDING_MISMATCH", "恢复沙箱已失效，未发布预览。");
      const updated = (await client.query(`UPDATE nano.preview_restores SET status='ready',sandbox_id=$4,finished_at=now()
        WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING *`, [ownerId, projectId, restoreId, input.sandboxId])).rows[0];
      await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, projectId, restoreId]);
      const ownerRun = await client.query("SELECT * FROM nano.runs WHERE owner_id=$1 AND id=$2", [ownerId, saved.run_id]);
      if (ownerRun.rows[0])
        await event(client, ownerRun.rows[0], { type: "preview.ready", payload: { revisionId: restore.revision_id, sourceHash: restore.source_hash, expiresAt: input.expiresAt, restored: true } });
      return storedRestore(updated);
    }),
    failRestore: (ownerId, projectId, restoreId, input) => owned(ownerId, async (client) => {
      await project(client, ownerId, projectId, true);
      const restore = (await client.query("SELECT * FROM nano.preview_restores WHERE owner_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE", [ownerId, projectId, restoreId])).rows[0];
      if (!restore || restore.status !== "pending") return null;
      const sandbox = restore.sandbox_id ? (await client.query(`SELECT state FROM nano.sandboxes
        WHERE owner_id=$1 AND project_id=$2 AND revision_id=$3 AND remote_id=$4 AND purpose='preview'`,
      [ownerId, projectId, restore.revision_id, restore.sandbox_id])).rows[0] : null;
      const pending = Boolean(restore.sandbox_id && (!sandbox || !["destroyed", "expired"].includes(sandbox.state)));
      const updated = (await client.query(`UPDATE nano.preview_restores SET status=$6,error_code=$4,error_message=$5,
        finished_at=CASE WHEN $7::boolean THEN NULL ELSE now() END
        WHERE owner_id=$1 AND project_id=$2 AND id=$3 AND status='pending' RETURNING *`,
      [ownerId, projectId, restoreId, input.code.slice(0, 80), input.message.slice(0, 2000), pending ? "pending" : "failed", pending])).rows[0];
      if (updated && !pending)
        await client.query("UPDATE nano.projects SET operation_kind=NULL,operation_id=NULL,operation_started_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND operation_id=$3", [ownerId, projectId, restoreId]);
      return updated ? storedRestore(updated) : null;
    }),
    getActiveRestore: (ownerId, projectId, revisionId) => owned(ownerId, async (client) => {
      await project(client, ownerId, projectId);
      const row = (await client.query(`SELECT * FROM nano.preview_restores WHERE owner_id=$1 AND project_id=$2 AND revision_id=$3
        ORDER BY created_at DESC LIMIT 1`, [ownerId, projectId, revisionId])).rows[0];
      return row ? storedRestore(row) : null;
    }),
    // Deliberately not owner-scoped: this answers only "does this revision id
    // exist anywhere", which is what a certificate request needs to be bound to.
    revisionExists: async (revisionId) => {
      if (!z.uuid().safeParse(revisionId).success) return false;
      const result = await database.owned("00000000-0000-4000-8000-000000000000", async (client) =>
        client.query<{ exists: boolean }>("SELECT nano.revision_exists($1) AS exists", [revisionId]));
      return result.rows[0]?.exists === true;
    },
  };
}
