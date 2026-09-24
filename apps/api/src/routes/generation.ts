import { once } from "node:events";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CancelRunResponseSchema, CreateRunRequestSchema, CreateRunResponseSchema, PreviewResponseSchema, PreviewAccessResponseSchema,
  RestorePreviewRequestSchema, RollbackRequestSchema, TaskListResponseSchema,
} from "@pivloom/contracts";
import type { GenerationService } from "../generation/service.js";
import { ApiFailure } from "./errors.js";
import { parseInput, requireOwner } from "./identity.js";

export async function registerGenerationRoutes(app: FastifyInstance, options: {
  generation: GenerationService | null; verifyIdentity: (request: FastifyRequest) => Promise<void>;
}) {
  const streams = new Set<AbortController>();
  app.addHook("preClose", async () => { for (const stream of streams) stream.abort(); });
  function service() {
    if (!options.generation) throw new ApiFailure(503, "GENERATION_CONFIGURATION_MISSING", "生成服务尚未配置，请联系维护者。", false);
    return options.generation;
  }
  await app.register(async (secured) => {
    secured.addHook("preHandler", options.verifyIdentity);
    const id = (request: FastifyRequest) => parseInput(z.object({ id: z.uuid() }), request.params).id;
    secured.post("/api/v1/projects/:id/runs", async (request, reply) => {
      const ownerId = requireOwner(request);
      const projectId = id(request);
      const body = parseInput(CreateRunRequestSchema, request.body);
      const key = parseInput(z.uuid(), request.headers["idempotency-key"]);
      const generation = service();
      const accepted = await generation.accept(ownerId, projectId, body, key);
      const response = CreateRunResponseSchema.parse({ runId: accepted.run.id, state: accepted.run.state,
        eventsUrl: `/api/v1/runs/${accepted.run.id}/events`, replayed: accepted.replayed });
      // The request is already durable. Dispatch is decided by the scheduler
      // from persisted state, never by this connection, so a disconnected
      // caller keeps the task it submitted and every executor sees one queue.
      if (!accepted.replayed) generation.wake();
      return reply.code(202).send(response);
    });
    secured.get("/api/v1/tasks", async (request) =>
      TaskListResponseSchema.parse({ tasks: await service().tasks(requireOwner(request)) }));
    secured.get("/api/v1/runs/:id", async (request) => service().runDetail(requireOwner(request), id(request)));
    secured.post("/api/v1/runs/:id/cancel", async (request) => {
      const run = await service().cancel(requireOwner(request), id(request));
      return CancelRunResponseSchema.parse({ runId: run.id, state: run.state, phase: run.phase, cleanupState: run.cleanupState });
    });
    secured.post("/api/v1/projects/:id/preview/restore", async (request) => {
      const ownerId = requireOwner(request);
      const projectId = id(request);
      const body = parseInput(RestorePreviewRequestSchema, request.body);
      const key = parseInput(z.uuid(), request.headers["idempotency-key"]);
      return service().restorePreview(ownerId, projectId, { revisionId: body.revisionId, idempotencyKey: key });
    });
    secured.post("/api/v1/projects/:id/rollback", async (request, reply) => {
      const ownerId = requireOwner(request), projectId = id(request);
      const body = parseInput(RollbackRequestSchema, request.body);
      const idempotencyKey = parseInput(z.uuid(), request.headers["idempotency-key"]);
      const result = await service().rollback(ownerId, projectId, { ...body, idempotencyKey });
      return reply.header("cache-control", "private, no-store").code(result.replayed ? 200 : 202).send(result);
    });
    secured.get("/api/v1/projects/:id/rollback/:operationId", async (request, reply) => {
      const ownerId = requireOwner(request), projectId = id(request);
      const operationId = parseInput(z.uuid(), (request.params as { operationId: string }).operationId);
      return reply.header("cache-control", "private, no-store").send(await service().rollbackStatus(ownerId, projectId, operationId));
    });
    secured.post("/api/v1/projects/:id/rollback/:operationId/cancel", async (request, reply) => {
      const ownerId = requireOwner(request), projectId = id(request);
      const operationId = parseInput(z.uuid(), (request.params as { operationId: string }).operationId);
      return reply.header("cache-control", "private, no-store").send(await service().cancelRollback(ownerId, projectId, operationId));
    });
    secured.get("/api/v1/projects/:id/publication", async (request) =>
      service().publication(requireOwner(request), id(request)));
    secured.post("/api/v1/projects/:id/publication", async (request) =>
      service().publish(requireOwner(request), id(request)));
    secured.get("/api/v1/revisions/:id/check", async (request) => service().check(requireOwner(request), id(request)));
    secured.get("/api/v1/checks/:id/artifacts/:artifactId", async (request, reply) => {
      const params = parseInput(z.object({ id: z.uuid(), artifactId: z.uuid() }), request.params);
      const bytes = await service().artifact(requireOwner(request), params.id, params.artifactId);
      return reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
        .type("image/png").send(bytes);
    });
    secured.get("/api/v1/revisions/:id/files", async (request) => service().files(requireOwner(request), id(request)));
    secured.get("/api/v1/revisions/:id/file", async (request) => {
      const query = parseInput(z.strictObject({ path: z.string().min(1).max(240) }), request.query);
      return service().file(requireOwner(request), id(request), query.path);
    });
    secured.get("/api/v1/projects/:id/preview", async (request) => {
      const query = parseInput(z.strictObject({ revisionId: z.uuid().optional() }), request.query);
      return PreviewResponseSchema.parse({ preview: await service().preview(requireOwner(request), id(request), query.revisionId) });
    });
    secured.post("/api/v1/projects/:id/preview/access", async (request, reply) => {
      const { revisionId } = parseInput(z.strictObject({ revisionId: z.uuid() }), request.body);
      if (!request.identitySessionId) throw new ApiFailure(401, "UNAUTHENTICATED", "登录已失效，请重新登录。");
      const access = await service().previewAccess(requireOwner(request), id(request), revisionId, request.identitySessionId);
      return reply.header("cache-control", "private, no-store").header("referrer-policy", "no-referrer")
        .header("x-content-type-options", "nosniff").send(PreviewAccessResponseSchema.parse(access));
    });
    secured.get("/api/v1/runs/:id/events", async (request, reply) => {
      const ownerId = requireOwner(request);
      const runId = id(request);
      const query = parseInput(z.strictObject({ after: z.string().regex(/^\d{1,18}$/).default("0") }), request.query);
      const generation = service();
      // Auth has already verified the token remotely; exp only limits this stream.
      let expiresAt = 0;
      try {
        const claims = JSON.parse(Buffer.from(request.headers.authorization!.slice(7).split(".")[1], "base64url").toString());
        if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) expiresAt = claims.exp * 1000;
      } catch { /* A verified token still requires a finite stream expiry. */ }
      if (expiresAt <= Date.now() + 1000) throw new ApiFailure(401, "UNAUTHENTICATED", "登录需要刷新，请重新连接。");
      const stream = new AbortController();
      streams.add(stream);
      const timer = setTimeout(() => stream.abort("AUTH_REFRESH_REQUIRED"), Math.max(1, Math.min(60_000, expiresAt - Date.now() - 1000)));
      const response = reply.raw;
      const disconnected = () => stream.abort("CLIENT_DISCONNECTED");
      response.once("close", disconnected);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let session: Awaited<ReturnType<GenerationService["openEvents"]>> | undefined;
      try {
        session = await generation.openEvents(ownerId, runId, query.after, stream.signal);
        if (stream.signal.aborted || response.destroyed) return;
        reply.hijack();
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" });
        response.flushHeaders();
        heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableNeedDrain && !response.write(": heartbeat\n\n")) stream.abort("SLOW_CONSUMER");
        }, 15_000);
        for await (const event of session) {
          if (session.signal.aborted || response.destroyed) break;
          if (!response.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
            const slow = setTimeout(() => stream.abort("SLOW_CONSUMER"), 15_000);
            try { await once(response, "drain", { signal: session.signal }); }
            finally { clearTimeout(slow); }
          }
        }
      } catch (error) {
        if (!response.headersSent && !response.destroyed) throw error;
        // Disconnects/outages recover through an authenticated durable cursor.
      } finally {
        clearTimeout(timer); clearInterval(heartbeat);
        session?.close(); stream.abort(); streams.delete(stream);
        response.off("close", disconnected);
        if (response.headersSent && !response.destroyed) {
          if (response.writableNeedDrain || session?.signal.reason === "SLOW_CONSUMER") response.destroy();
          else response.end();
        }
      }
    });
  });
}
