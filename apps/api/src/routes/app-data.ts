import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppRecordSchema, AppRecordsResponseSchema, AppSubmissionResponseSchema, BookedSlotsResponseSchema } from "@pivloom/contracts";
import type { PivloomDatabase } from "../data/database.js";
import { createAppDataRepository } from "../data/app-data.js";
import type { Publication } from "../generation/publication.js";
import { ApiFailure } from "./errors.js";
import { parseInput, requireOwner } from "./identity.js";

export async function registerAppDataRoutes(app: FastifyInstance, options: {
  database: PivloomDatabase;
  publishedFromHost: (host: string) => Promise<Publication | null>;
  verifyIdentity: (request: FastifyRequest) => Promise<void>;
}) {
  const data = createAppDataRepository(options.database);
  const projectId = (request: FastifyRequest) => parseInput(z.object({ id: z.uuid() }), request.params).id;
  async function published(request: FastifyRequest) {
    const publication = await options.publishedFromHost(request.headers.host ?? "");
    if (!publication) throw new ApiFailure(404, "NOT_FOUND", "找不到已发布的应用。");
    const profile = await data.profileForPublished(publication.projectId);
    if (!profile) throw new ApiFailure(404, "APP_DATA_UNAVAILABLE", "这个应用没有启用托管数据。");
    return { ...publication, ...profile };
  }

  app.get("/__published/__pivloom/runtime", async (request, reply) => {
    const target = await published(request);
    return reply.header("cache-control", "no-store").send({ schemaVersion: 1, mode: "published",
      kind: target.kind, revisionId: target.revisionId });
  });
  app.post("/__published/__pivloom/data/registrations", async (request, reply) => {
    const target = await published(request);
    if (target.kind !== "event-signup") throw new ApiFailure(404, "NOT_FOUND", "这个应用没有报名数据集合。");
    const key = parseInput(z.uuid(), request.headers["idempotency-key"]);
    const result = await data.submit(target.ownerId, target.projectId, target.kind, request.body, key);
    return reply.header("cache-control", "no-store").code(result.replayed ? 200 : 201)
      .send(AppSubmissionResponseSchema.parse(result));
  });
  app.post("/__published/__pivloom/data/bookings", async (request, reply) => {
    const target = await published(request);
    if (target.kind !== "appointments") throw new ApiFailure(404, "NOT_FOUND", "这个应用没有预约数据集合。");
    const key = parseInput(z.uuid(), request.headers["idempotency-key"]);
    const result = await data.submit(target.ownerId, target.projectId, target.kind, request.body, key);
    return reply.header("cache-control", "no-store").code(result.replayed ? 200 : 201)
      .send(AppSubmissionResponseSchema.parse(result));
  });
  app.get("/__published/__pivloom/data/slots", async (request, reply) => {
    const target = await published(request);
    if (target.kind !== "appointments") throw new ApiFailure(404, "NOT_FOUND", "这个应用没有预约数据集合。");
    const { date } = parseInput(z.strictObject({ date: z.iso.date() }), request.query);
    return reply.header("cache-control", "no-store")
      .send(BookedSlotsResponseSchema.parse({ date, occupied: await data.bookedSlots(target.ownerId, target.projectId, date) }));
  });
  app.all("/__published/__pivloom/data/*", async (_request, reply) => reply.code(404).send());

  await app.register(async (secured) => {
    secured.addHook("preHandler", options.verifyIdentity);
    secured.get("/api/v1/projects/:id/app-data/records", async (request, reply) => {
      const ownerId = requireOwner(request), id = projectId(request);
      const kind = await data.profileForOwner(ownerId, id);
      if (!kind) throw new ApiFailure(404, "APP_DATA_UNAVAILABLE", "这个项目没有托管数据。");
      const query = parseInput(z.strictObject({ offset: z.coerce.number().int().min(0).max(10_000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50) }), request.query);
      return reply.header("cache-control", "private, no-store")
        .send(AppRecordsResponseSchema.parse(await data.list(ownerId, id, kind, query.offset, query.limit)));
    });
    secured.patch("/api/v1/projects/:id/app-data/records/:recordId", async (request) => {
      const { recordId } = parseInput(z.object({ recordId: z.uuid() }), request.params);
      const { confirmed } = parseInput(z.strictObject({ confirmed: z.boolean() }), request.body);
      return { record: AppRecordSchema.parse(await data.setConfirmed(requireOwner(request), projectId(request), recordId, confirmed)) };
    });
    secured.delete("/api/v1/projects/:id/app-data/records/:recordId", async (request, reply) => {
      const { recordId } = parseInput(z.object({ recordId: z.uuid() }), request.params);
      await data.remove(requireOwner(request), projectId(request), recordId);
      return reply.code(204).send();
    });
    secured.get("/api/v1/projects/:id/app-data/export", async (request, reply) => {
      const ownerId = requireOwner(request), id = projectId(request);
      const kind = await data.profileForOwner(ownerId, id);
      if (!kind) throw new ApiFailure(404, "APP_DATA_UNAVAILABLE", "这个项目没有托管数据。");
      const records = (await data.list(ownerId, id, kind, 0, 10_000)).records;
      return reply.header("cache-control", "private, no-store")
        .header("content-disposition", `attachment; filename="pivloom-${id}-data.json"`)
        .type("application/json").send({ projectId: id, exportedAt: new Date().toISOString(), records });
    });
  });
}
