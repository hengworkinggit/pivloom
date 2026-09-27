import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppRecordSchema, AppRecordsResponseSchema, AppSubmissionResponseSchema, BookedSlotsResponseSchema,
  PersonalAppDataKindSchema, PrivateStateResponseSchema, PublicAppDataKindSchema } from "@pivloom/contracts";
import type { PivloomDatabase } from "../data/database.js";
import { createAppDataRepository } from "../data/app-data.js";
import type { Publication } from "../generation/publication.js";
import { ApiFailure } from "./errors.js";
import { parseInput, requireOwner } from "./identity.js";
import { createPublishedOwnerSessions } from "./published-owner-session.js";

export async function registerAppDataRoutes(app: FastifyInstance, options: {
  database: PivloomDatabase;
  publishedFromHost: (host: string) => Promise<Publication | null>;
  publishedForOwner: (ownerId: string, projectId: string) => Promise<Publication | null>;
  appOrigin: string;
  isSessionActive: (ownerId: string, sessionId: string) => Promise<boolean>;
  verifyIdentity: (request: FastifyRequest) => Promise<void>;
}) {
  const data = createAppDataRepository(options.database);
  const sessions = createPublishedOwnerSessions(options.isSessionActive);
  const projectId = (request: FastifyRequest) => parseInput(z.object({ id: z.uuid() }), request.params).id;
  async function published(request: FastifyRequest) {
    const publication = await options.publishedFromHost(request.headers.host ?? "");
    if (!publication) throw new ApiFailure(404, "NOT_FOUND", "找不到已发布的应用。");
    const profile = await data.profileForPublished(publication.projectId);
    if (!profile) throw new ApiFailure(404, "APP_DATA_UNAVAILABLE", "这个应用没有启用托管数据。");
    return { ...publication, ...profile };
  }
  const allowWorkbench = (request: FastifyRequest, reply: { header(name: string, value: string): unknown }) => {
    if (request.headers.origin !== options.appOrigin) return false;
    reply.header("access-control-allow-origin", options.appOrigin);
    reply.header("access-control-allow-credentials", "true");
    reply.header("vary", "Origin");
    return true;
  };

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
  app.options("/__published/__pivloom/session", async (request, reply) => {
    await published(request);
    if (!allowWorkbench(request, reply)) return reply.code(403).send();
    return reply.header("access-control-allow-methods", "POST")
      .header("access-control-allow-headers", "Authorization").code(204).send();
  });
  app.post("/__published/__pivloom/session", async (request, reply) => {
    const target = await published(request);
    if (!PersonalAppDataKindSchema.safeParse(target.kind).success || !allowWorkbench(request, reply))
      return reply.code(403).send();
    const grant = /^Published ([a-f0-9]{64})$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const cookie = await sessions.exchange(grant, target.projectId);
    return cookie ? reply.header("set-cookie", cookie).header("cache-control", "no-store").code(204).send()
      : reply.code(403).send();
  });
  app.options("/__published/__pivloom/session/clear", async (request, reply) => {
    await published(request);
    if (!allowWorkbench(request, reply)) return reply.code(403).send();
    return reply.header("access-control-allow-methods", "POST").code(204).send();
  });
  app.post("/__published/__pivloom/session/clear", async (request, reply) => {
    await published(request);
    if (!allowWorkbench(request, reply)) return reply.code(403).send();
    return reply.header("set-cookie", sessions.clear(request.headers.cookie)).code(204).send();
  });
  async function personal(request: FastifyRequest) {
    const target = await published(request);
    const parsed = PersonalAppDataKindSchema.safeParse(target.kind);
    if (!parsed.success) throw new ApiFailure(404, "NOT_FOUND", "这个应用没有个人数据集合。");
    const ownerId = await sessions.owner(request.headers.cookie, target.projectId);
    if (ownerId !== target.ownerId) throw new ApiFailure(401, "OWNER_ACCESS_REQUIRED", "请登录并从项目工作台打开这个应用。");
    return { ...target, kind: parsed.data };
  }
  app.get("/__published/__pivloom/data/private-state", async (request, reply) => {
    const target = await personal(request);
    return reply.header("cache-control", "private, no-store")
      .send(PrivateStateResponseSchema.parse(await data.privateState(target.ownerId, target.projectId, target.kind)));
  });
  app.put("/__published/__pivloom/data/private-state", { bodyLimit: 80 * 1024 }, async (request, reply) => {
    const target = await personal(request);
    if (request.headers.origin !== new URL(target.url).origin) throw new ApiFailure(403, "INVALID_ORIGIN", "应用来源无效。");
    const input = parseInput(z.strictObject({ version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), value: z.unknown() }), request.body);
    return reply.header("cache-control", "private, no-store")
      .send(PrivateStateResponseSchema.parse(await data.savePrivateState(target.ownerId, target.projectId, target.kind, input.version, input.value)));
  });
  app.all("/__published/__pivloom/data/*", async (_request, reply) => reply.code(404).send());

  await app.register(async (secured) => {
    secured.addHook("preHandler", options.verifyIdentity);
    secured.post("/api/v1/projects/:id/app-data/access", async (request, reply) => {
      const ownerId = requireOwner(request), id = projectId(request);
      const kind = await data.profileForOwner(ownerId, id);
      if (!PersonalAppDataKindSchema.safeParse(kind).success)
        throw new ApiFailure(404, "APP_DATA_UNAVAILABLE", "这个项目没有个人数据集合。");
      if (!request.identitySessionId) throw new ApiFailure(401, "UNAUTHENTICATED", "登录已失效，请重新登录。");
      const publication = await options.publishedForOwner(ownerId, id);
      if (!publication) throw new ApiFailure(404, "NOT_FOUND", "这个项目尚未发布。");
      const grant = await sessions.issue(ownerId, id, request.identitySessionId);
      if (!grant) throw new ApiFailure(401, "UNAUTHENTICATED", "登录已失效，请重新登录。");
      return reply.header("cache-control", "private, no-store").header("referrer-policy", "no-referrer")
        .send({ url: publication.url, grant });
    });
    secured.get("/api/v1/projects/:id/app-data/records", async (request, reply) => {
      const ownerId = requireOwner(request), id = projectId(request);
      const kind = await data.profileForOwner(ownerId, id);
      if (!kind || !PublicAppDataKindSchema.safeParse(kind).success)
        throw new ApiFailure(404, "APP_DATA_UNAVAILABLE", "这个项目没有报名或预约数据。");
      const query = parseInput(z.strictObject({ offset: z.coerce.number().int().min(0).max(10_000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50) }), request.query);
      return reply.header("cache-control", "private, no-store")
        .send(AppRecordsResponseSchema.parse(await data.list(ownerId, id, PublicAppDataKindSchema.parse(kind), query.offset, query.limit)));
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
      if (!kind || !PublicAppDataKindSchema.safeParse(kind).success)
        throw new ApiFailure(404, "APP_DATA_UNAVAILABLE", "这个项目没有报名或预约数据。");
      const records = (await data.list(ownerId, id, PublicAppDataKindSchema.parse(kind), 0, 10_000)).records;
      return reply.header("cache-control", "private, no-store")
        .header("content-disposition", `attachment; filename="pivloom-${id}-data.json"`)
        .type("application/json").send({ projectId: id, exportedAt: new Date().toISOString(), records });
    });
  });
  return {
    async staticVisibility(request: FastifyRequest): Promise<"public" | "owner" | "denied"> {
      const publication = await options.publishedFromHost(request.headers.host ?? "");
      if (!publication) return "public";
      const profile = await data.profileForPublished(publication.projectId);
      if (!profile || !PersonalAppDataKindSchema.safeParse(profile.kind).success) return "public";
      const ownerId = await sessions.owner(request.headers.cookie, publication.projectId);
      return ownerId === profile.ownerId ? "owner" : "denied";
    },
  };
}
