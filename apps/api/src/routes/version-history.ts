import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { RevisionDiffResponseSchema, VersionHistoryResponseSchema } from "@pivloom/contracts";
import type { GenerationService } from "../generation/service.js";
import { compareSourceBundles } from "../generation/version-diff.js";
import type { SourceStore } from "../storage/source.js";
import { ApiFailure } from "./errors.js";
import { parseInput, requireOwner } from "./identity.js";

const notFound = () => new ApiFailure(404, "NOT_FOUND", "找不到这个项目资源。");

export async function registerVersionHistoryRoutes(app: FastifyInstance, options: {
  generation: GenerationService | null;
  sources: SourceStore | null;
  verifyIdentity: (request: FastifyRequest) => Promise<void>;
}) {
  await app.register(async (secured) => {
    secured.addHook("preHandler", options.verifyIdentity);
    const projectId = (request: FastifyRequest) => parseInput(z.object({ id: z.uuid() }), request.params).id;
    const repository = () => {
      if (!options.generation || !options.sources)
        throw new ApiFailure(503, "GENERATION_CONFIGURATION_MISSING", "生成服务尚未配置，请联系维护者。", false);
      return options.generation.repository;
    };
    secured.get("/api/v1/projects/:id/revisions", async (request, reply) => {
      const ownerId = requireOwner(request), id = projectId(request);
      const history = await repository().readProjectVersionHistory(ownerId, id);
      return reply.header("cache-control", "private, no-store").send(VersionHistoryResponseSchema.parse({
        projectId: id, currentRevisionId: history.currentRevisionId, revisions: history.revisions,
      }));
    });
    secured.get("/api/v1/projects/:id/revisions/diff", async (request, reply) => {
      const ownerId = requireOwner(request), id = projectId(request);
      const query = parseInput(z.strictObject({ from: z.uuid(), to: z.uuid() }), request.query);
      const history = await repository().readProjectVersionHistory(ownerId, id);
      const fromRevision = history.revisions.find((item) => item.id === query.from);
      const toRevision = history.revisions.find((item) => item.id === query.to);
      if (!fromRevision || !toRevision) throw notFound();
      const [before, after] = await Promise.all([
        options.sources!.load(fromRevision.source), options.sources!.load(toRevision.source),
      ]);
      const comparison = compareSourceBundles(before, after);
      return reply.header("cache-control", "private, no-store").send(RevisionDiffResponseSchema.parse({
        projectId: id, fromRevision, toRevision, ...comparison,
      }));
    });
  });
}
