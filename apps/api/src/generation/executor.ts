import { randomUUID } from "node:crypto";
import { TerminalRunStates, type RoleUsage, type RunPhase, type RunState } from "@pivloom/contracts";
import type { FinishFailedInput, GenerationRepository, StoredRestore, StoredRevision, StoredRun } from "../data/generation.js";
import type { ModelProfileService } from "../models/service.js";
import { sourceBundleFiles, type SourceStore } from "../storage/source.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import { runReview } from "./review.js";
import { summarizeReviewCheckpoint } from "./review-checkpoint.js";
import { RuntimeError, type ProbeEvent, type SandboxConfig, type SourceFile, type TrustedBuildRecord } from "../runtime/types.js";
import { runCoordinator } from "../runtime/coordinator.js";
import { createRunTokenBudget, type TokenUsage } from "../runtime/token-budget.js";
import { ACCEPTED_PREVIEW_LEASE_MS, RESTORE_TIMEOUT_MS, RUN_IDLE_TIMEOUT_MS, RUN_TOOL_LIMIT } from "../runtime/budgets.js";
import { ApiFailure } from "../routes/errors.js";
import { destroyCandidateSandbox, runCandidate, type CandidateSnapshot } from "./candidate.js";
import { restorePreview } from "./restore.js";
import type { PreviewGateway } from "./preview.js";
import { boundedProviderRetry, createMeaningfulProgressGate, createRunProgressWatchdog } from "./progress-watchdog.js";
import { OpenSandboxWorkspace } from "../runtime/workspace.js";

interface Resource {
  ownerId: string; runId: string; revisionId: string; sandboxId: string; expiresAt: string;
  cleanupPending?: boolean;
  /** Restores own their cleanup lock independently of the source Run. */
  restore?: { projectId: string; id: string };
}
type TerminalIntent =
  | { kind: "cancelled"; input: Parameters<GenerationRepository["finishCancelled"]>[2] }
  | { kind: "failed"; input: Parameters<GenerationRepository["finishFailed"]>[2] };
interface Task {
  controller: AbortController; done: Promise<void>; sandboxId?: string;
  terminal?: TerminalIntent; settlementError?: unknown; settling?: Promise<void>; retained?: boolean;
  commitUnknown?: boolean; settlementAttempts?: number;
}

function storedUsage(usage: TokenUsage): RoleUsage {
  return {
    modelCalls: usage.modelCalls, toolCalls: usage.toolCalls,
    inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cachedTokens,
    totalTokens: usage.total, elapsedMs: usage.elapsedMs, source: usage.source,
  };
}
const reusedSourceUsage: TokenUsage = {
  modelCalls: 0, toolCalls: 0, input: null, output: null, total: null,
  cachedTokens: null, elapsedMs: 0, source: "unreported",
};

export function retainsAcceptedPreview(state: RunState): boolean {
  return state === "completed";
}

/** The repository commits the Check first; failed candidates then release their sandbox. */
export async function settleTerminalReview<T extends { run: { state: RunState }; repairNextAttempt: number | null }>(
  finishReview: () => Promise<T>,
  destroyRejected: () => Promise<unknown>,
): Promise<{ completion: T; retained: boolean }> {
  const completion = await finishReview();
  if (completion.repairNextAttempt !== null) return { completion, retained: false };
  const retained = retainsAcceptedPreview(completion.run.state);
  if (!retained) await destroyRejected().catch(() => {});
  return { completion, retained };
}

/** Single-process dispatcher. Only persisted, newly accepted runs enter here. */
export function createGenerationExecutor(options: {
  repository: GenerationRepository; models: ModelProfileService; sources: SourceStore; artifacts: ArtifactStore;
  previews: PreviewGateway; sandbox: SandboxConfig; maxSandboxes: number;
  /** Notifies the durable queue that a capacity slot may have been released. */
  onTaskSettled?: (runId: string) => void;
}, boundaries: NonNullable<Parameters<typeof runCandidate>[1]> & {
  modelFetch?: typeof fetch; maxToolCalls?: number; settlementRetryMs?: number; cleanupSweepMs?: number;
} = {}) {
  const toolLimit = boundaries.maxToolCalls ?? RUN_TOOL_LIMIT;
  if (!Number.isInteger(toolLimit) || toolLimit < 1 || toolLimit > RUN_TOOL_LIMIT)
    throw new Error("Tool limit must be between 1 and the run ceiling");
  const settlementRetryMs = boundaries.settlementRetryMs ?? 3_000;
  if (!Number.isInteger(settlementRetryMs) || settlementRetryMs < 1) throw new Error("Settlement retry interval must be positive");
  const cleanupSweepMs = boundaries.cleanupSweepMs ?? 30_000;
  if (!Number.isInteger(cleanupSweepMs) || cleanupSweepMs < 1) throw new Error("Cleanup sweep interval must be positive");
  const { repository, models, sources, artifacts, previews, sandbox } = options;
  const tasks = new Map<string, Task>();
  const taskRun = new Map<string, StoredRun>();
  const pendingRestoreFailures = new Map<string, {
    ownerId: string; projectId: string; input: { code: string; message: string }; settling?: Promise<void>;
  }>();
  const resources = new Map<string, Resource>();
  let closing = false;
  let sweep: Promise<void> | undefined;

  async function destroy(resource: Resource) {
    resource.cleanupPending = true;
    previews.revoke(resource.revisionId, resource.sandboxId);
    const result = await destroyCandidateSandbox({ sandboxConfig: sandbox, sandboxId: resource.sandboxId,
      sandboxConnector: boundaries.sandboxConnector });
    if (result.confirmed) {
      if (resource.restore) {
        await repository.markRestoreSandboxDestroyed(resource.ownerId, resource.restore.projectId, resource.restore.id, resource.sandboxId);
      } else {
        await repository.markDestroyed(resource.ownerId, resource.runId, resource.sandboxId);
        const run = await repository.getRun(resource.ownerId, resource.runId);
        if (run.cleanupState === "pending") await repository.confirmCleanup(resource.ownerId, resource.runId);
      }
      resources.delete(resource.sandboxId);
    } else if (!resource.restore) {
      await repository.markCleanupPending(resource.ownerId, resource.runId, "沙箱清理尚未确认，正在等待回收。");
    }
    return result.confirmed;
  }

  async function execute(run: StoredRun, task: Task) {
    const watchdog = createRunProgressWatchdog(run.deadlineAt, task.controller);
    const meaningfulProgress = createMeaningfulProgressGate();
    // The candidate sandbox for the current attempt. It is written from inside
    // the sandbox callback, so reads go through a helper that always reports the
    // declared type instead of a stale control-flow narrowing.
    let resource: Resource | undefined;
    const currentResource = (): Resource | undefined => resource;
    let retained = false;
    let resultRevisionId: string | null = null;
    let activeRoleId: string | undefined;
    let activeUsage: RoleUsage | undefined;
    let phase: RunPhase = run.phase;
    const tokenBudget = createRunTokenBudget();
    // Every attempt owns a distinct immutable revision id, including repairs.
    let revisionId = randomUUID();
    const finishCancelled = (input: Parameters<GenerationRepository["finishCancelled"]>[2]) => {
      task.terminal = { kind: "cancelled", input };
      return repository.finishCancelled(run.ownerId, run.id, input);
    };
    // Failures are data, not prose. The user-facing copy on the run stays generic, but the
    // classified cause is persisted next to the run so the workbench can show what actually
    // happened; a ZodError from an over-long evidence array must never again spend a night
    // looking like an unreproducible GENERATION_FAILED.
    const classifyFailure = (cause: unknown): FinishFailedInput["failureDetail"] => {
      const redact = (text: string) => text.replaceAll(sandbox.apiKey, "[REDACTED]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
      if (cause instanceof RuntimeError) return { phase, causeClass: "RUNTIME", detail: { code: cause.code, message: redact(cause.message).slice(0, 800) } };
      if (cause instanceof ApiFailure) return { phase, causeClass: "API", detail: { statusCode: cause.statusCode, code: cause.code, message: redact(cause.message).slice(0, 800) } };
      if (cause instanceof Error) {
        const issues = (cause as { issues?: unknown[] }).issues;
        if (cause.name === "ZodError" && Array.isArray(issues)) {
          return { phase, causeClass: "SCHEMA_VALIDATION", detail: { issues: issues.slice(0, 3).map((issue) => redact(JSON.stringify(issue)).slice(0, 400)) } };
        }
        return { phase, causeClass: "UNEXPECTED", detail: { name: cause.name, message: redact(cause.message).slice(0, 800) } };
      }
      return { phase, causeClass: "UNKNOWN", detail: { repr: String(cause).slice(0, 400) } };
    };
    const finishFailed = (input: Parameters<GenerationRepository["finishFailed"]>[2]) => {
      task.terminal = { kind: "failed", input };
      return repository.finishFailed(run.ownerId, run.id, input);
    };
    async function setPhase(next: RunPhase) {
      if (phase === next) return;
      const changed = await repository.setPhase(run.ownerId, run.id, { phase: next, state: "building" });
      watchdog.touch(changed.deadlineAt);
      phase = next;
    }
    async function save(snapshot: CandidateSnapshot, buildStatus: "passed" | "failed", trustedBuild: TrustedBuildRecord) {
      task.controller.signal.throwIfAborted();
      await setPhase("snapshot");
      const source = await sources.save({ ownerId: run.ownerId, projectId: run.projectId, revisionId },
        snapshot.bundle.templateVersion, snapshot.bundle.files);
      if (source.sourceHash !== snapshot.sourceHash) throw new ApiFailure(503, "SNAPSHOT_SAVE_FAILED", "源码快照与构建版本不一致。", true);
      task.controller.signal.throwIfAborted();
      const revision = await repository.saveCandidate(run.ownerId, run.id, {
        source, buildStatus, build: { ...trustedBuild },
      });
      resultRevisionId = revision.id;
      return revision;
    }
    try {
      const [model, context] = await Promise.all([
        models.resolveLease(run.ownerId, run.credentialLeaseId),
        repository.getPlanningContext(run.ownerId, run.id),
      ]);
      const modelConfig = { provider: "pivloom-byok", id: run.modelId ?? model.profile.modelId, api: model.profile.provider,
        baseUrl: model.profile.baseUrl, apiKey: model.apiKey, fetch: boundaries.modelFetch ?? model.fetch,
        supportsImages: (run.modelId == null || run.modelId === model.profile.modelId) && model.profile.capabilities.vision === "verified" };
      const safeMessage = (message: string) => message.replaceAll(model.apiKey, "[REDACTED]")
        .replaceAll(sandbox.apiKey, "[REDACTED]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").slice(0, 2000);
      const recordEvent = (roleRunId: string) => async (event: ProbeEvent) => {
        const phases = { creating: "provision", generating: "implement", building: "build", previewing: "persist", checking: "review", ready: "persist", cleaning: "cleanup" } as const;
        if (event.type === "stage" && event.stage) await setPhase(phases[event.stage]);
        if (event.type !== "tool.start" && event.type !== "tool.end" && event.type !== "tool.output" && event.type !== "model.stream.started") return;
        const retry = boundedProviderRetry(event);
        const progress = meaningfulProgress(roleRunId, event);
        const saved = await repository.appendEvent(run.ownerId, run.id, {
          type: event.type === "tool.start" ? "tool.started" : event.type === "tool.end" ? "tool.completed" : "tool.output",
          roleRunId,
          progress,
          // Tool batches have already been redacted across chunk boundaries and
          // bounded by encoded JSON bytes. Re-clipping here would silently lose
          // their contents and split UTF-8 output before it reaches SSE.
          payload: { message: event.type === "tool.output" ? event.message : safeMessage(event.message), toolName: event.toolName, toolCallId: event.toolCallId,
            success: event.success, exitCode: event.exitCode, truncated: event.truncated,
            progressKind: retry ? "provider_retry" : event.type === "model.stream.started" ? "model_stream" : undefined,
            ...(retry ? { retryRequestNumber: retry.requestNumber, retryAttempt: retry.attempt,
              retryMaxAttempts: retry.maxAttempts, retryDelayMs: retry.delayMs } : {}) },
        });
        if (progress) watchdog.touch(new Date(Date.parse(saved.createdAt) + RUN_IDLE_TIMEOUT_MS - 1_000).toISOString());
      };
      const coordinator = await repository.startCoordinator(run.ownerId, run.id);
      activeRoleId = coordinator.id;
      const reused = run.retryOfRunId
        ? await repository.getReviewRetryCandidate(run.ownerId, run.id, run.retryOfRunId) : null;
      let planningUsage: TokenUsage;
      if (reused) {
        await repository.appendEvent(run.ownerId, run.id, { type: "tool.output", roleRunId: coordinator.id,
          payload: { toolName: "reuse_candidate", message: "复用先前封存的计划与源码；协调者和 Builder 模型调用均为 0。",
            sourceRunId: run.retryOfRunId, sourceRevisionId: reused.revision.id,
            sourceHash: reused.revision.sourceHash, modelCalls: 0 } });
        await repository.submitPlan(run.ownerId, run.id, { roleRunId: coordinator.id, attempt: coordinator.attempt,
          plan: reused.plan, usage: storedUsage(reusedSourceUsage) });
        planningUsage = reusedSourceUsage;
      } else {
      const planning = await runCoordinator({
        runId: run.id, roleRunId: coordinator.id, sessionId: coordinator.sessionId,
        attempt: coordinator.attempt, baseRevisionId: run.baseRevisionId,
        maxToolCalls: Math.min(12, toolLimit),
        modelConfig, context, tokenBudget, signal: task.controller.signal, onEvent: recordEvent(coordinator.id),
        assertActive: () => repository.assertRoleActive(run.ownerId, run.id, {
          roleRunId: coordinator.id, attempt: coordinator.attempt, role: "coordinator",
        }),
        async onDecision(decision, metadata) {
          task.controller.signal.throwIfAborted();
          activeUsage = storedUsage(metadata.usage);
          const source = { roleRunId: coordinator.id, attempt: coordinator.attempt, usage: activeUsage };
          if (decision.kind === "clarification") {
            await repository.requestClarification(run.ownerId, run.id, { ...source, question: decision.question });
          } else {
            await repository.submitPlan(run.ownerId, run.id, { ...source, plan: decision.plan });
          }
        },
      });
      if (planning.decision.kind === "clarification") return;
      planningUsage = planning.usage;
      }
      task.controller.signal.throwIfAborted();
      // Attempt 0 implements the plan. Every later attempt is a bounded repair of
      // a candidate the Reviewer rejected; all attempts share this run's rolling
      // inactivity lease
      // and its token and tool ledgers, and each owns an immutable revision.
      let attempt = run.attempt;
      let seed: SourceFile[] | undefined = reused
        ? sourceBundleFiles(await sources.load(await sources.verify(reused.revision.source)))
        : run.baseRevisionId
          ? sourceBundleFiles(await sources.load((await repository.getRevision(run.ownerId, run.baseRevisionId)).source)) : undefined;
      let failedChecks: string[] = [];
      let previousRevisionId: string | undefined;
      let toolCalls = planningUsage.toolCalls;
      const remainingTools = () => {
        if (toolCalls >= toolLimit) throw new RuntimeError("TOOL_BUDGET_EXCEEDED", "本次任务工具调用预算已耗尽");
        return toolLimit - toolCalls;
      };
      for (;;) {
        if (attempt !== run.attempt)
          await repository.startRepairBuilder(run.ownerId, run.id, { attempt, previousRevisionId: previousRevisionId!, failedChecks });
        const role = await repository.startBuilder(run.ownerId, run.id);
        activeRoleId = role.id;
        activeUsage = undefined;
        const handoff = role.input;
        if (!handoff) throw new RuntimeError("AGENT_OUTPUT_INVALID", "协调目标尚未可靠保存，未开始生成。");
        phase = "provision";
        revisionId = randomUUID();
        resource = undefined;
        const attemptRevisionId = revisionId;
        const result = await runCandidate({
          runId: run.id, revisionId: attemptRevisionId, roleRunId: role.id, sessionId: role.sessionId,
          previewBasePath: `/p/${attemptRevisionId}/`, prompt: run.requestText, handoff, seed,
          ...(reused && attempt === run.attempt ? { recheckSourceHash: reused.revision.sourceHash } : {}),
          maxToolCalls: remainingTools(),
          sandboxConfig: sandbox, modelConfig, tokenBudget,
          signal: task.controller.signal, onEvent: recordEvent(role.id),
          async onSandbox(registration) {
            if (registration.state === "created") {
              resource = { ownerId: run.ownerId, runId: run.id, revisionId: attemptRevisionId, sandboxId: registration.sandboxId, expiresAt: registration.expiresAt };
              task.sandboxId = registration.sandboxId;
              resources.set(registration.sandboxId, resource);
              await repository.registerSandbox(run.ownerId, run.id, { sandboxId: registration.sandboxId, expiresAt: registration.expiresAt, state: "active" });
            } else if (registration.state === "renewed") {
              const tracked = resources.get(registration.sandboxId);
              if (!tracked || tracked.runId !== run.id || tracked.revisionId !== attemptRevisionId
                || !await repository.updateSandboxExpiry(run.ownerId, run.id, registration.sandboxId, registration.expiresAt))
                throw new RuntimeError("SANDBOX_LEASE_RENEW_FAILED", "候选沙箱续租未持久确认");
              tracked.expiresAt = registration.expiresAt;
            } else if (registration.state === "destroyed") {
              await repository.markDestroyed(run.ownerId, run.id, registration.sandboxId);
              resources.delete(registration.sandboxId);
            } else if (registration.state === "cleanup_pending") {
              await repository.markCleanupPending(run.ownerId, run.id, "候选沙箱清理尚未确认。");
            }
          },
        }, boundaries);
        toolCalls += result.usage?.toolCalls ?? result.toolCalls.length;
        activeUsage = result.usage ? storedUsage(result.usage)
          : reused && attempt === run.attempt ? storedUsage(reusedSourceUsage) : undefined;
        if (result.status !== "candidate") {
          // runCandidate reports a cancelled Builder as a result after it has
          // attempted sandbox cleanup. Keep the user's stop as a cancellation;
          // routing every non-candidate result through finishFailed changes the
          // authoritative run state to failed.
          if (task.controller.signal.reason === "CANCELLED") {
            await finishCancelled({
              cleanupState: result.cleanup === "pending" ? "pending" : "confirmed",
              summary: result.cleanup === "pending"
                ? "任务已停止，远端资源回收尚未确认，已阻止新的任务。"
                : "任务已停止，远端模型调用与沙箱已确认回收。",
            });
            return;
          }
          task.controller.signal.throwIfAborted();
          const diagnostic = result.diagnosticSnapshot && result.trustedBuild
            ? await save(result.diagnosticSnapshot, result.diagnosticBuildStatus ?? "failed", result.trustedBuild) : undefined;
          if (diagnostic?.buildStatus === "failed" && result.cleanup === "confirmed"
            && (result.error.code === "TYPECHECK_FAILED" || result.error.code === "BUILD_FAILED")) {
            const completion = await repository.finishBuildFailure(run.ownerId, run.id, {
              revisionId: diagnostic.id, code: result.error.code, message: safeMessage(result.error.message), usage: activeUsage,
            });
            if (completion.repairNextAttempt === null) return;
            const command = result.error.code === "TYPECHECK_FAILED" ? result.trustedBuild!.typecheck : result.trustedBuild!.build;
            failedChecks = [safeMessage(`${result.error.code}: ${command?.stdoutTail ?? ""}\n${command?.stderrTail ?? ""}`)];
            previousRevisionId = diagnostic.id;
            seed = sourceBundleFiles(await sources.load(diagnostic.source));
            resource = undefined;
            attempt = completion.repairNextAttempt;
            continue;
          }
          await finishFailed({
            ...result.error, retryable: true, resultRevisionId,
            cleanupState: result.cleanup === "pending" ? "pending" : "confirmed",
            roleUsage: activeUsage ? { roleRunId: role.id, usage: activeUsage } : undefined,
          });
          return;
        }
        await repository.completeBuilder(run.ownerId, run.id, { summary: reused && attempt === run.attempt
          ? "复用已保存候选源码；未调用 Builder 模型，已重新通过可信构建。" : "源码已生成并通过可信构建。", usage: activeUsage });
        const candidateRevision = await save(result.snapshot, "passed", result.trustedBuild);
        task.controller.signal.throwIfAborted();
        await repository.bindPreview(run.ownerId, run.id, {
          ...result.preview, markerVerified: true, writeRevoked: true, chromeClosed: true,
        });
        previews.register({ ...result.preview, ownerId: run.ownerId, projectId: run.projectId });
        const persistPreviewLease = async (expiresAt: string) => {
          const tracked = currentResource();
          if (!tracked || tracked.revisionId !== candidateRevision.id
            || !await repository.updateSandboxExpiry(run.ownerId, run.id, tracked.sandboxId, expiresAt)
            || !await previews.renew(run.ownerId, tracked.revisionId, tracked.sandboxId, expiresAt))
            throw new RuntimeError("SANDBOX_LEASE_RENEW_FAILED", "候选预览续租未完整确认");
          tracked.expiresAt = expiresAt;
        };
        await repository.queueReviewer(run.ownerId, run.id, { revisionId: candidateRevision.id });
        let reviewer = await repository.startReviewer(run.ownerId, run.id);
        let checked: Awaited<ReturnType<typeof runReview>>;
        phase = "review";
        for (;;) {
          activeRoleId = reviewer.role.id;
          activeUsage = undefined;
          checked = await runReview({
            binding: reviewer.scope, sessionId: reviewer.role.sessionId, handoff: reviewer.handoff,
            expiresAt: currentResource()?.expiresAt ?? result.preview.expiresAt,
            source: await sources.verify(candidateRevision.source), sources, artifacts,
            sandboxConfig: sandbox, modelConfig, tokenBudget, signal: task.controller.signal,
            maxToolCalls: remainingTools(),
            onEvent: recordEvent(reviewer.role.id),
            onCheckpoint: async (checkpoint) => {
              await repository.appendEvent(run.ownerId, run.id, {
                type: "tool.output", roleRunId: reviewer.role.id, progress: false,
                payload: {
                  toolName: "review_checkpoint",
                  message: `行为 ${checkpoint.item.behaviorId} 的真实证据已核对并暂存；正式检查尚未完成。`,
                  reviewCheckpoint: summarizeReviewCheckpoint(checkpoint),
                },
              });
            },
            onLeaseRenewed: persistPreviewLease,
            assertActive: () => repository.assertRoleActive(run.ownerId, run.id, {
              roleRunId: reviewer.role.id, attempt: reviewer.role.attempt, role: "reviewer",
            }),
          }, boundaries);
          toolCalls += checked.usage?.toolCalls ?? 0;
          activeUsage = checked.usage ? storedUsage(checked.usage) : undefined;
          if (checked.receipt.recoverableInfrastructureCode && toolCalls < toolLimit) {
            const rebound = await repository.retryReviewer(run.ownerId, run.id,
              { receipt: checked.receipt, usage: activeUsage });
            if (rebound) {
              reviewer = await repository.startReviewer(run.ownerId, run.id);
              continue;
            }
          }
          break;
        }
        if (checked.receipt.result.items.every((item) => item.verdict === "passed")) {
          const tracked = currentResource();
          if (!tracked) throw new RuntimeError("SANDBOX_LEASE_RENEW_FAILED", "候选预览已不受当前任务管理");
          const manager = new OpenSandboxWorkspace(sandbox, boundaries.sandboxConnector);
          const handle = { sandboxId: tracked.sandboxId, expiresAt: tracked.expiresAt };
          try {
            await manager.connect(handle);
            const renewed = await manager.renewLease(handle, ACCEPTED_PREVIEW_LEASE_MS, task.controller.signal);
            await persistPreviewLease(renewed.expiresAt);
          } finally { await manager.releaseClient(handle).catch(() => {}); }
        }
        // A lost transaction response is ambiguous: the accepted Preview might
        // already be current. Reconcile the DB state before deleting its sandbox.
        task.commitUnknown = true;
        const settledReview = await settleTerminalReview(
          () => repository.finishReview(run.ownerId, run.id, { receipt: checked.receipt, usage: activeUsage }),
          async () => {
            const rejected = currentResource();
            if (rejected && resources.has(rejected.sandboxId)) await destroy(rejected);
          },
        );
        const { completion } = settledReview;
        task.commitUnknown = false;
        if (completion.repairNextAttempt === null) {
          // A terminal blocked or rejected Check keeps its saved source and
          // evidence, but must release the candidate sandbox immediately.
          // Only the accepted current revision keeps a live Preview.
          if (settledReview.retained) { retained = true; task.retained = true; }
          break;
        }
        // The rejected candidate keeps its saved source for inspection, but its
        // sandbox is released so one project never holds two live candidates.
        failedChecks = completion.check.items.filter((item) => item.verdict !== "passed")
          .map((item) => `目标：${item.expected}\n实际：${item.actual}`).slice(0, 5);
        previousRevisionId = completion.revision.id;
        seed = sourceBundleFiles(await sources.load(completion.revision.source));
        const rejected = currentResource();
        if (rejected && resources.has(rejected.sandboxId) && !await destroy(rejected).catch(() => false)) {
          await finishFailed({
            code: "SANDBOX_CLEANUP_PENDING", message: "上轮候选沙箱回收尚未确认，已停止修复，请等待资源回收后重试。",
            retryable: true, resultRevisionId, cleanupState: "pending",
          });
          return;
        }
        resource = undefined;
        attempt = completion.repairNextAttempt;
      }
    } catch (error) {
      if (task.commitUnknown) {
        // If the commit succeeded but its response was lost, a second terminal
        // transition must neither replace the accepted result nor kill Preview.
        // If the DB cannot answer yet, retain the remote until retrySettlement.
        const persisted = await repository.getRun(run.ownerId, run.id);
        if (TerminalRunStates.has(persisted.state)) {
          task.commitUnknown = false;
          if (retainsAcceptedPreview(persisted.state)) { retained = true; task.retained = true; }
          return;
        }
        task.commitUnknown = false;
      }
      if (error instanceof RuntimeError && error.usage) activeUsage = storedUsage(error.usage);
      let confirmed = true;
      const pending = currentResource();
      if (pending && resources.has(pending.sandboxId)) confirmed = await destroy(pending).catch(() => false);
      // A user-requested stop is a terminal state of its own, never a failure.
      if (task.controller.signal.reason === "CANCELLED") {
        await finishCancelled({
          cleanupState: confirmed ? "confirmed" : "pending",
          summary: confirmed ? "任务已停止，远端模型调用与沙箱已确认回收。" : "任务已停止，远端资源回收尚未确认，已阻止新的任务。",
        });
        return;
      }
      const failure = task.controller.signal.aborted
        ? new ApiFailure(503, task.controller.signal.reason === "RUN_TIMEOUT" ? "RUN_TIMEOUT" : "SERVICE_RESTARTED", task.controller.signal.reason === "RUN_TIMEOUT" ? "任务长时间没有进展，已停止执行。" : "服务停止了本次执行，已保存的内容保留。", true)
        : error instanceof ApiFailure ? error
          : error instanceof RuntimeError && error.code === "AGENT_OUTPUT_INVALID"
            // The reviewer builds this message itself (a reason code plus a scope and
            // a fixed explanation), so it is system-authored and carries none of the
            // model's raw output. Replacing it with one sentence is what made C3's
            // failure undiagnosable for a round, exactly as the evidence cap did for
            // C2; the branch below already preserves error.message for the same class
            // of failure.
            ? new ApiFailure(503, "AGENT_OUTPUT_INVALID", error.message.trim()
              || (phase === "review" ? "检查结果未通过格式或证据校验，请稍后重试。" : "需求整理结果未通过校验，请补充说明后重试。"), true)
            : error instanceof RuntimeError && error.code === "TOKEN_BUDGET_EXCEEDED"
              ? new ApiFailure(503, "TOKEN_BUDGET_EXCEEDED", "本次任务的模型用量预算已耗尽，请缩小需求后重试。", true)
            : error instanceof RuntimeError && ["TOOL_BUDGET_EXCEEDED", "MODEL_FAILED", "MODEL_REQUEST_TIMEOUT", "ROLE_NOT_ACTIVE"].includes(error.code)
                ? new ApiFailure(503, error.code, error.message, true)
            : error instanceof RuntimeError && phase === "review"
                ? new ApiFailure(503, "CHECK_BLOCKED", "检查过程或浏览器关闭尚未完成，候选未被接受。", true)
            : new ApiFailure(503, "GENERATION_FAILED", "生成或保存未完成，请稍后重试。", true);
      // The user-facing copy stays generic, but an unmapped internal failure must
      // leave an operator-visible cause. Class name plus a redacted message is
      // enough to triage a run that ended in milliseconds without exposing keys.
      if (failure.code === "GENERATION_FAILED") {
        const detail = error instanceof Error
          ? `${error.name}: ${error.message.replaceAll(sandbox.apiKey, "[REDACTED]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").slice(0, 400)}`
          : "unknown";
        console.error(`run ${run.id} failed at phase ${phase}: ${detail}`);
      }
      await finishFailed({
        code: failure.code, message: failure.message, retryable: failure.retryable,
        resultRevisionId, cleanupState: confirmed ? "confirmed" : "pending",
        roleUsage: activeRoleId && activeUsage ? { roleRunId: activeRoleId, usage: activeUsage } : undefined,
        failureDetail: classifyFailure(error),
      });
    } finally {
      watchdog.close();
      const leftover = currentResource();
      if (!retained && !task.commitUnknown && leftover && resources.has(leftover.sandboxId)) await destroy(leftover).catch(() => {});
      await models.releaseForRun(run.ownerId, run.credentialLeaseId);
    }
  }

  // A failed terminal transaction is still this process's responsibility. Retry
  // only the idempotent repository transition and cleanup; never replay Pi or a
  // sandbox command that could create a second candidate.
  function retrySettlement(run: StoredRun, task: Task): Promise<void> {
    if (task.settling) return task.settling;
    const attempt = (async () => {
      let saved = await repository.getRun(run.ownerId, run.id);
      if (retainsAcceptedPreview(saved.state)) task.retained = true;
      if (!task.retained) {
        for (const resource of [...resources.values()].filter((item) => !item.restore && item.runId === run.id))
          await destroy(resource).catch(() => false);
      }
      const cleanupState = [...resources.values()].some((item) => !item.restore && item.runId === run.id) ? "pending" : "confirmed";
      if (!TerminalRunStates.has(saved.state)) {
        if (saved.state === "cancel_requested" || task.terminal?.kind === "cancelled" || task.controller.signal.reason === "CANCELLED") {
          const summary = task.terminal?.kind === "cancelled" ? task.terminal.input.summary
            : "任务已停止，远端模型调用与沙箱已确认回收。";
          saved = await repository.finishCancelled(run.ownerId, run.id, { cleanupState, summary });
        } else {
          const input = task.terminal?.kind === "failed" ? task.terminal.input : {
            code: "GENERATION_FAILED", message: "执行中断，已保存的候选仍可查看，可以重新提交。", retryable: true,
          };
          saved = await repository.finishFailed(run.ownerId, run.id, { ...input, cleanupState });
        }
      }
      if (cleanupState === "confirmed" && saved.cleanupState === "pending")
        await repository.confirmCleanup(run.ownerId, run.id);
      await models.releaseForRun(run.ownerId, run.credentialLeaseId);
      task.settlementError = undefined;
      tasks.delete(run.id);
      taskRun.delete(run.id);
    })();
    task.settling = attempt.finally(() => { task.settling = undefined; });
    return task.settling;
  }

  function reportSettlementFailure(runId: string, task: Task, error: unknown) {
    const attempts = task.settlementAttempts = (task.settlementAttempts ?? 0) + 1;
    if (attempts !== 1 && attempts % 20 !== 0) return;
    const reason = error instanceof ApiFailure || error instanceof RuntimeError ? error.code
      : error instanceof Error ? error.name : "unknown";
    console.error(`run ${runId} terminal settlement retry ${attempts} is pending (${reason})`);
  }

  function retryRestoreFailure(id: string): Promise<void> {
    const pending = pendingRestoreFailures.get(id);
    if (!pending) return Promise.resolve();
    if (pending.settling) return pending.settling;
    const attempt = repository.failRestore(pending.ownerId, pending.projectId, id, pending.input).then(() => {
      pendingRestoreFailures.delete(id);
    });
    pending.settling = attempt.finally(() => { pending.settling = undefined; });
    return pending.settling;
  }

  const settlementTimer = setInterval(() => {
    if (closing) return;
    for (const [runId, task] of tasks) {
      if (!task.settlementError) continue;
      const run = taskRun.get(runId);
      if (run) void retrySettlement(run, task).catch((error) => reportSettlementFailure(runId, task, error));
    }
    for (const id of pendingRestoreFailures.keys()) void retryRestoreFailure(id).catch(() => {});
  }, settlementRetryMs);
  settlementTimer.unref();

  const timer = setInterval(() => {
    if (sweep || closing) return;
    sweep = (async () => {
      for (const resource of resources.values()) {
        if (!resource.cleanupPending && Date.parse(resource.expiresAt) > Date.now()) continue;
        const active = tasks.get(resource.runId);
        if (active && !resource.cleanupPending) { active.controller.abort("RUN_TIMEOUT"); continue; }
        await destroy(resource).catch(() => {});
      }
    })().finally(() => { sweep = undefined; });
  }, cleanupSweepMs);
  timer.unref();

  const restores = new Map<Promise<void>, AbortController>();
  /** Rebuilds a preview for a saved revision. No model call, no new revision. */
  function restore(record: StoredRestore, revision: StoredRevision) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("RESTORE_TIMEOUT"), RESTORE_TIMEOUT_MS);
    // Assigned from inside the sandbox callback; a holder keeps the narrowing
    // honest for the error path that runs after the callback.
    const tracked: { current?: Resource } = {};
    const task = (async () => {
      try {
        const files = sourceBundleFiles(await sources.load(revision.source));
        const result = await restorePreview({
          revisionId: revision.id, sourceHash: revision.sourceHash, templateVersion: revision.source.templateVersion,
          files, sandboxConfig: sandbox,
          signal: controller.signal,
          async onSandbox(handle) {
            tracked.current = { ownerId: revision.ownerId, runId: revision.runId, revisionId: revision.id, sandboxId: handle.sandboxId, expiresAt: handle.expiresAt,
              restore: { projectId: revision.projectId, id: record.id } };
            resources.set(handle.sandboxId, tracked.current);
            await repository.registerRestoreSandbox(revision.ownerId, revision.projectId, record.id, { sandboxId: handle.sandboxId, expiresAt: handle.expiresAt });
          },
        }, boundaries);
        // Publish only after the rebuilt hash matched the saved snapshot.
        previews.register({ ownerId: revision.ownerId, projectId: revision.projectId, revisionId: revision.id,
          sandboxId: result.handle.sandboxId, sourceHash: revision.sourceHash, expiresAt: result.handle.expiresAt,
          upstreamUrl: result.upstreamUrl, headers: result.headers });
        await repository.bindRestore(revision.ownerId, revision.projectId, record.id,
          { sandboxId: result.handle.sandboxId, expiresAt: result.handle.expiresAt });
      } catch (error) {
        if (tracked.current && resources.has(tracked.current.sandboxId)) await destroy(tracked.current).catch(() => false);
        const code = controller.signal.reason === "RESTORE_TIMEOUT" ? "RESTORE_TIMEOUT"
          : controller.signal.reason === "SERVICE_RESTARTED" ? "SERVICE_RESTARTED"
            : error instanceof RuntimeError ? error.code : "RESTORE_FAILED";
        const raw = error instanceof Error ? error.message : "预览恢复未完成。";
        const message = raw.replaceAll(sandbox.apiKey, "[REDACTED]")
          .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").slice(0, 2000);
        pendingRestoreFailures.set(record.id, { ownerId: revision.ownerId, projectId: revision.projectId, input: {
          code, message: controller.signal.reason === "RESTORE_TIMEOUT"
            ? "预览恢复超时，源码仍已保存，可以重新发起。"
            : controller.signal.aborted ? "服务停止了预览恢复，源码仍已保存，可以重新发起。" : message,
        } });
        await retryRestoreFailure(record.id).catch(() => {});
      } finally {
        clearTimeout(timeout);
      }
    })();
    restores.set(task, controller);
    return task.finally(() => restores.delete(task));
  }

  return {
    hasCapacity() { return !closing && resources.size + [...tasks.values()].filter((task) => !task.sandboxId).length < options.maxSandboxes; },
    /**
     * Puts an idle preview to sleep so a waiting task can use its slot. Reuses
     * the normal destroy path, so the preview capability is revoked, the remote
     * sandbox is really gone and the durable row records it; source, versions,
     * checks and the saved screenshot are untouched and the preview reports the
     * same restartable state as an expired one. Returns false when this process
     * does not own the sandbox, which means someone else still has work on it.
     */
    async sleepPreview(target: { ownerId: string; runId: string; revisionId: string; sandboxId: string }) {
      const resource = resources.get(target.sandboxId);
      if (!resource || resource.runId !== target.runId) return false;
      return destroy(resource);
    },
    /**
     * Requests a stop for a run this process is executing. Returns false when no
     * live task owns the run, so the caller can settle the state immediately
     * instead of waiting for a task that will never observe the signal.
     */
    cancel(runId: string) {
      const task = tasks.get(runId);
      if (!task) return false;
      task.controller.abort("CANCELLED");
      return true;
    },
    restore,
    start(run: StoredRun) {
      if (tasks.has(run.id)) return;
      const task: Task = { controller: new AbortController(), done: Promise.resolve() };
      if (closing) task.controller.abort();
      taskRun.set(run.id, run);
      tasks.set(run.id, task);
      task.done = execute(run, task).then(() => {
        tasks.delete(run.id);
        taskRun.delete(run.id);
      }, async (error) => {
        task.settlementError = error;
        console.error(`run ${run.id} terminal transition is pending; retrying without model or tool replay`);
        await retrySettlement(run, task).catch((failure) => reportSettlementFailure(run.id, task, failure));
      }).finally(() => { options.onTaskSettled?.(run.id); });
    },
    async close() {
      closing = true;
      clearInterval(timer);
      clearInterval(settlementTimer);
      for (const task of tasks.values()) task.controller.abort();
      for (const controller of restores.values()) controller.abort("SERVICE_RESTARTED");
      await Promise.allSettled([...tasks.values()].map((task) => task.done));
      // A remote connector that ignores abort must not prevent process shutdown
      // forever. The next boot reconciles still-pending restore bindings.
      let restoreGrace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...restores.keys()]),
        new Promise<void>((resolve) => { restoreGrace = setTimeout(resolve, 15_000); }),
      ]);
      clearTimeout(restoreGrace);
      await sweep;
      for (const resource of resources.values()) await destroy(resource).catch(() => {});
      await Promise.allSettled([...pendingRestoreFailures.keys()].map(retryRestoreFailure));
      await Promise.allSettled([...tasks].filter(([, task]) => task.settlementError).map(([runId, task]) =>
        retrySettlement(taskRun.get(runId)!, task)));
    },
  };
}
export type GenerationExecutor = ReturnType<typeof createGenerationExecutor>;
