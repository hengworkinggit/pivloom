import { randomUUID } from "node:crypto";
import type { RoleUsage, RunPhase } from "@pivloom/contracts";
import type { GenerationRepository, StoredRun } from "../data/generation.js";
import type { ModelProfileService } from "../models/service.js";
import type { SourceStore } from "../storage/source.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import { runReview } from "./review.js";
import { RuntimeError, type ProbeEvent, type SandboxConfig, type TrustedBuildRecord } from "../runtime/types.js";
import { runCoordinator } from "../runtime/coordinator.js";
import { createRunTokenBudget, type TokenUsage } from "../runtime/token-budget.js";
import { RUN_DEADLINE_MINUTES } from "../runtime/budgets.js";
import { ApiFailure } from "../routes/errors.js";
import { destroyCandidateSandbox, runCandidate, type CandidateSnapshot } from "./candidate.js";
import type { PreviewGateway } from "./preview.js";

interface Resource {
  ownerId: string; runId: string; revisionId: string; sandboxId: string; expiresAt: string;
}
interface Task { controller: AbortController; done: Promise<void>; sandboxId?: string }

function storedUsage(usage: TokenUsage): RoleUsage {
  return {
    modelCalls: usage.modelCalls, toolCalls: usage.toolCalls,
    inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cachedTokens,
    totalTokens: usage.total, elapsedMs: usage.elapsedMs, source: usage.source,
  };
}

/** Single-process dispatcher. Only persisted, newly accepted runs enter here. */
export function createGenerationExecutor(options: {
  repository: GenerationRepository; models: ModelProfileService; sources: SourceStore; artifacts: ArtifactStore;
  previews: PreviewGateway; sandbox: SandboxConfig; maxSandboxes: number;
}) {
  const { repository, models, sources, artifacts, previews, sandbox } = options;
  const tasks = new Map<string, Task>();
  const resources = new Map<string, Resource>();
  let closing = false;
  let sweep: Promise<void> | undefined;

  async function destroy(resource: Resource) {
    previews.revoke(resource.revisionId);
    const result = await destroyCandidateSandbox({ sandboxConfig: sandbox, sandboxId: resource.sandboxId });
    if (result.confirmed) {
      await repository.markDestroyed(resource.ownerId, resource.runId, resource.sandboxId);
      const run = await repository.getRun(resource.ownerId, resource.runId);
      if (run.cleanupState === "pending") await repository.confirmCleanup(resource.ownerId, resource.runId);
      resources.delete(resource.sandboxId);
    } else {
      await repository.markCleanupPending(resource.ownerId, resource.runId, "沙箱清理尚未确认，正在等待回收。");
    }
    return result.confirmed;
  }

  async function execute(run: StoredRun, task: Task) {
    const deadlineTimer = setTimeout(() => task.controller.abort("RUN_TIMEOUT"), Math.max(1, Date.parse(run.deadlineAt) - Date.now()));
    let resource: Resource | undefined;
    let retained = false;
    let resultRevisionId: string | null = null;
    let activeRoleId: string | undefined;
    let activeUsage: RoleUsage | undefined;
    let phase: RunPhase = run.phase;
    const tokenBudget = createRunTokenBudget();
    const revisionId = randomUUID();
    async function setPhase(next: RunPhase) {
      if (phase === next) return;
      await repository.setPhase(run.ownerId, run.id, { phase: next, state: "building" });
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
      const modelConfig = { provider: "pivloom-byok", id: model.profile.modelId, api: model.profile.provider,
        baseUrl: model.profile.baseUrl, apiKey: model.apiKey, fetch: model.fetch, supportsImages: false };
      const safeMessage = (message: string) => message.replaceAll(model.apiKey, "[REDACTED]")
        .replaceAll(sandbox.apiKey, "[REDACTED]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").slice(0, 2000);
      const recordEvent = (roleRunId: string) => async (event: ProbeEvent) => {
        const phases = { creating: "provision", generating: "implement", building: "build", previewing: "persist", checking: "review", ready: "persist", cleaning: "cleanup" } as const;
        if (event.type === "stage" && event.stage) await setPhase(phases[event.stage]);
        if (event.type !== "tool.start" && event.type !== "tool.end" && event.type !== "tool.output" && event.type !== "model.stream.started") return;
        await repository.appendEvent(run.ownerId, run.id, {
          type: event.type === "tool.start" ? "tool.started" : event.type === "tool.end" ? "tool.completed" : "tool.output",
          roleRunId,
          // Tool batches have already been redacted across chunk boundaries and
          // bounded by encoded JSON bytes. Re-clipping here would silently lose
          // their contents and split UTF-8 output before it reaches SSE.
          payload: { message: event.type === "tool.output" ? event.message : safeMessage(event.message), toolName: event.toolName, toolCallId: event.toolCallId,
            success: event.success, exitCode: event.exitCode, truncated: event.truncated },
        });
      };
      const coordinator = await repository.startCoordinator(run.ownerId, run.id);
      activeRoleId = coordinator.id;
      const planning = await runCoordinator({
        runId: run.id, roleRunId: coordinator.id, sessionId: coordinator.sessionId,
        attempt: coordinator.attempt, baseRevisionId: run.baseRevisionId,
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
      task.controller.signal.throwIfAborted();
      // Only a committed handoff may start a new Builder session. The original
      // request and accepted clarification answers travel in its bounded task.
      const role = await repository.startBuilder(run.ownerId, run.id);
      activeRoleId = role.id;
      activeUsage = undefined;
      const handoff = role.input;
      if (!handoff) throw new RuntimeError("AGENT_OUTPUT_INVALID", "协调目标尚未可靠保存，未开始生成。");
      phase = "provision";
      const result = await runCandidate({
        runId: run.id, revisionId, roleRunId: role.id, sessionId: role.sessionId,
        previewBasePath: `/p/${revisionId}/`, prompt: run.requestText, handoff,
        maxToolCalls: 80 - planning.toolCalls.length,
        sandboxConfig: sandbox, modelConfig, tokenBudget,
        signal: task.controller.signal, onEvent: recordEvent(role.id),
        async onSandbox(registration) {
          if (registration.state === "created") {
            resource = { ownerId: run.ownerId, runId: run.id, revisionId, sandboxId: registration.sandboxId, expiresAt: registration.expiresAt };
            task.sandboxId = registration.sandboxId;
            resources.set(registration.sandboxId, resource);
            await repository.registerSandbox(run.ownerId, run.id, { sandboxId: registration.sandboxId, expiresAt: registration.expiresAt, state: "active" });
          } else if (registration.state === "destroyed") {
            await repository.markDestroyed(run.ownerId, run.id, registration.sandboxId);
            resources.delete(registration.sandboxId);
          } else if (registration.state === "cleanup_pending") {
            await repository.markCleanupPending(run.ownerId, run.id, "候选沙箱清理尚未确认。");
          }
        },
      });
      activeUsage = result.usage ? storedUsage(result.usage) : undefined;
      if (result.status !== "candidate") {
        if (result.diagnosticSnapshot && result.trustedBuild) await save(result.diagnosticSnapshot, result.diagnosticBuildStatus ?? "failed", result.trustedBuild);
        await repository.finishFailed(run.ownerId, run.id, {
          ...result.error, retryable: true, resultRevisionId,
          cleanupState: result.cleanup === "pending" ? "pending" : "confirmed",
          roleUsage: activeUsage ? { roleRunId: role.id, usage: activeUsage } : undefined,
        });
        return;
      }
      await repository.completeBuilder(run.ownerId, run.id, { summary: "源码已生成并通过可信构建。", usage: activeUsage });
      const candidateRevision = await save(result.snapshot, "passed", result.trustedBuild);
      task.controller.signal.throwIfAborted();
      await repository.bindPreview(run.ownerId, run.id, {
        ...result.preview, markerVerified: true, writeRevoked: true, chromeClosed: true,
      });
      previews.register({ ...result.preview, ownerId: run.ownerId, projectId: run.projectId });
      await repository.queueReviewer(run.ownerId, run.id, { revisionId: candidateRevision.id });
      const reviewer = await repository.startReviewer(run.ownerId, run.id);
      activeRoleId = reviewer.role.id;
      activeUsage = undefined;
      phase = "review";
      const checked = await runReview({
        binding: reviewer.scope, sessionId: reviewer.role.sessionId, handoff: reviewer.handoff,
        expiresAt: result.preview.expiresAt,
        source: await sources.verify(candidateRevision.source), sources, artifacts,
        sandboxConfig: sandbox, modelConfig, tokenBudget, signal: task.controller.signal,
        maxToolCalls: 80 - planning.toolCalls.length - result.toolCalls.length,
        onEvent: recordEvent(reviewer.role.id),
        assertActive: () => repository.assertRoleActive(run.ownerId, run.id, {
          roleRunId: reviewer.role.id, attempt: reviewer.role.attempt, role: "reviewer",
        }),
      });
      activeUsage = checked.usage ? storedUsage(checked.usage) : undefined;
      await repository.finishReview(run.ownerId, run.id, { receipt: checked.receipt, usage: activeUsage });
      retained = true;
    } catch (error) {
      if (error instanceof RuntimeError && error.usage) activeUsage = storedUsage(error.usage);
      let confirmed = true;
      if (resource && resources.has(resource.sandboxId)) confirmed = await destroy(resource).catch(() => false);
      const failure = task.controller.signal.aborted
        ? new ApiFailure(503, task.controller.signal.reason === "RUN_TIMEOUT" ? "RUN_TIMEOUT" : "SERVICE_RESTARTED", task.controller.signal.reason === "RUN_TIMEOUT" ? `生成超过 ${RUN_DEADLINE_MINUTES} 分钟，已停止。` : "服务停止了本次执行，已保存的内容保留。", true)
        : error instanceof ApiFailure ? error
          : error instanceof RuntimeError && error.code === "AGENT_OUTPUT_INVALID"
            ? new ApiFailure(503, "AGENT_OUTPUT_INVALID", phase === "review" ? "检查结果未通过格式或证据校验，请稍后重试。" : "需求整理结果未通过校验，请补充说明后重试。", true)
            : error instanceof RuntimeError && error.code === "TOKEN_BUDGET_EXCEEDED"
              ? new ApiFailure(503, "TOKEN_BUDGET_EXCEEDED", "本次任务的模型用量预算已耗尽，请缩小需求后重试。", true)
            : error instanceof RuntimeError && ["TOOL_BUDGET_EXCEEDED", "MODEL_FAILED", "MODEL_REQUEST_TIMEOUT", "ROLE_NOT_ACTIVE"].includes(error.code)
                ? new ApiFailure(503, error.code, error.message, true)
            : error instanceof RuntimeError && phase === "review"
                ? new ApiFailure(503, "CHECK_BLOCKED", "检查过程或浏览器关闭尚未完成，候选未被接受。", true)
            : new ApiFailure(503, "GENERATION_FAILED", "生成或保存未完成，请稍后重试。", true);
      await repository.finishFailed(run.ownerId, run.id, {
        code: failure.code, message: failure.message, retryable: failure.retryable,
        resultRevisionId, cleanupState: confirmed ? "confirmed" : "pending",
        roleUsage: activeRoleId && activeUsage ? { roleRunId: activeRoleId, usage: activeUsage } : undefined,
      });
    } finally {
      clearTimeout(deadlineTimer);
      if (!retained && resource && resources.has(resource.sandboxId)) await destroy(resource).catch(() => {});
      await models.releaseForRun(run.ownerId, run.credentialLeaseId);
    }
  }

  const timer = setInterval(() => {
    if (sweep || closing) return;
    sweep = (async () => {
      for (const resource of resources.values()) {
        if (Date.parse(resource.expiresAt) > Date.now()) continue;
        const active = tasks.get(resource.runId);
        if (active) { active.controller.abort(); continue; }
        await destroy(resource).catch(() => {});
      }
    })().finally(() => { sweep = undefined; });
  }, 30_000);
  timer.unref();

  return {
    hasCapacity() { return !closing && resources.size + [...tasks.values()].filter((task) => !task.sandboxId).length < options.maxSandboxes; },
    start(run: StoredRun) {
      if (tasks.has(run.id)) return;
      const task: Task = { controller: new AbortController(), done: Promise.resolve() };
      if (closing) task.controller.abort();
      tasks.set(run.id, task);
      // Promise is retained for graceful shutdown; no detached rejections or implicit retry.
      task.done = execute(run, task).catch(() => {}).finally(() => tasks.delete(run.id));
    },
    async close() {
      closing = true;
      clearInterval(timer);
      for (const task of tasks.values()) task.controller.abort();
      await Promise.allSettled([...tasks.values()].map((task) => task.done));
      await sweep;
      for (const resource of resources.values()) await destroy(resource).catch(() => {});
    },
  };
}
export type GenerationExecutor = ReturnType<typeof createGenerationExecutor>;
