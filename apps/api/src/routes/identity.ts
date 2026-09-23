import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateProjectRequestSchema, CreateProjectResponseSchema,
  MeResponseSchema, ProjectDetailResponseSchema, ProjectListResponseSchema,
  ProjectQuotaSchema,
} from "@pivloom/contracts";
import type { PivloomDatabase } from "../data/database.js";
import { createProjectRepository } from "../data/projects.js";
import { ApiFailure, unauthenticated } from "./errors.js";

export interface IdentityRoutesOptions {
  database: PivloomDatabase;
  verifyIdentity: (request: FastifyRequest) => Promise<void>;
  loadProjectDetail?: (ownerId: string, id: string) => Promise<unknown>;
  loadQuota?: (ownerId: string) => Promise<unknown>;
}

export function requireOwner(request: FastifyRequest) {
  if (!request.identity) throw unauthenticated();
  return request.identity.id;
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiFailure(422, "INVALID_INPUT", "输入不符合要求，请检查后重试。");
  return result.data;
}

export async function registerIdentityRoutes(app: FastifyInstance, options: IdentityRoutesOptions) {
  const projects = createProjectRepository(options.database);
  await app.register(async (secured) => {
    secured.addHook("preHandler", options.verifyIdentity);
    secured.get("/api/v1/me", async (request) => MeResponseSchema.parse({ user: request.identity }));
    secured.get("/api/v1/me/quota", async (request) => {
      if (!options.loadQuota) throw new ApiFailure(503, "QUOTA_UNAVAILABLE", "额度暂时不可用，请稍后重试。", true);
      return ProjectQuotaSchema.parse(await options.loadQuota(requireOwner(request)));
    });
    secured.get("/api/v1/projects", async (request) => {
      const query = parseInput(z.strictObject({
        cursor: z.string().max(256).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }), request.query);
      return ProjectListResponseSchema.parse(await projects.list(requireOwner(request), query.limit, query.cursor));
    });
    secured.post("/api/v1/projects", async (request, reply) => {
      const input = parseInput(CreateProjectRequestSchema, request.body ?? {});
      const project = await projects.create(requireOwner(request), input.title);
      return reply.code(201).send(CreateProjectResponseSchema.parse({ project }));
    });
    secured.get("/api/v1/projects/:id", async (request) => {
      const { id } = parseInput(z.object({ id: z.uuid() }), request.params);
      if (options.loadProjectDetail) return options.loadProjectDetail(requireOwner(request), id);
      const project = await projects.get(requireOwner(request), id);
      return ProjectDetailResponseSchema.parse({ project, messages: [], currentRevision: null, activeRun: null, preview: null });
    });
  });
}
