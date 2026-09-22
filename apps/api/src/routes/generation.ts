import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreateRunRequestSchema, CreateRunResponseSchema, PreviewResponseSchema, TerminalRunStates } from "@pivloom/contracts";
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
      if (!accepted.replayed) {
        let dispatched = false;
        const start = () => {
          if (dispatched) return;
          dispatched = true;
          reply.raw.off("finish", start);
          reply.raw.off("close", start);
          generation.start(accepted.run);
        };
        reply.raw.once("finish", start);
        reply.raw.once("close", start);
        // A disconnected caller still owns the durable request it submitted.
        if (reply.raw.destroyed) setImmediate(start);
      }
      return reply.code(202).send(response);
    });
    secured.get("/api/v1/runs/:id", async (request) => service().runDetail(requireOwner(request), id(request)));
    secured.get("/api/v1/revisions/:id/files", async (request) => service().files(requireOwner(request), id(request)));
    secured.get("/api/v1/revisions/:id/file", async (request) => {
      const query = parseInput(z.strictObject({ path: z.string().min(1).max(240) }), request.query);
      return service().file(requireOwner(request), id(request), query.path);
    });
    secured.get("/api/v1/projects/:id/preview", async (request) => {
      const query = parseInput(z.strictObject({ revisionId: z.uuid().optional() }), request.query);
      return PreviewResponseSchema.parse({ preview: await service().preview(requireOwner(request), id(request), query.revisionId) });
    });
    secured.get("/api/v1/runs/:id/events", async (request, reply) => {
      const ownerId = requireOwner(request);
      const runId = id(request);
      const query = parseInput(z.strictObject({ after: z.string().regex(/^\d{1,18}$/).default("0") }), request.query);
      const generation = service();
      await generation.repository.getRun(ownerId, runId);
      // The token has already been remotely authenticated; exp only limits stream lifetime.
      let expiresAt = Date.now();
      try {
        const claims = JSON.parse(Buffer.from(request.headers.authorization!.slice(7).split(".")[1], "base64url").toString());
        if (typeof claims.exp === "number") expiresAt = claims.exp * 1000;
      } catch { /* Fail closed when the verified token has no usable expiry. */ }
      const stream = new AbortController();
      streams.add(stream);
      const timer = setTimeout(() => stream.abort(), Math.max(1, Math.min(60_000, expiresAt - Date.now() - 1000)));
      const response = reply.raw;
      response.once("close", () => stream.abort());
      reply.hijack();
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" });
      response.flushHeaders();
      let cursor = query.after;
      let heartbeat = Date.now();
      try {
        while (!stream.signal.aborted) {
          // Durable cursor polling is the initial SSE path; no history/subscription gap.
          const events = await generation.repository.listEvents(ownerId, runId, cursor, 100);
          for (const event of events) {
            if (stream.signal.aborted) break;
            if (!response.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
              stream.abort(); break; // Slow consumers resume from their last acknowledged cursor.
            }
            cursor = event.eventId;
          }
          if (events.length === 100) continue;
          const run = await generation.repository.getRun(ownerId, runId);
          if (TerminalRunStates.has(run.state) && events.length === 0) break;
          if (Date.now() - heartbeat >= 15_000) { response.write(": heartbeat\n\n"); heartbeat = Date.now(); }
          await delay(750, undefined, { signal: stream.signal });
        }
      } catch { /* Client disconnect or backend outage is recovered by authenticated cursor replay. */ }
      finally { clearTimeout(timer); streams.delete(stream); response.end(); }
    });
  });
}
