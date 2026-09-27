import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { PivloomDatabase } from "../../src/data/database.js";
import { createProjectRepository } from "../../src/data/projects.js";
import { createAppDataRepository } from "../../src/data/app-data.js";
import { registerAppDataRoutes } from "../../src/routes/app-data.js";
import { ApiFailure } from "../../src/routes/errors.js";

describe.skipIf(process.env.PIVLOOM_APP_DATA_INTEGRATION !== "1")("published application data", () => {
  test("isolates projects and owners, persists records, and rejects concurrent double bookings", async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!new URL(url).pathname.startsWith("/pivloom_executor_test_")
      || !process.env.PIVLOOM_ENVIRONMENT_ID || !process.env.PIVLOOM_EXECUTOR_OWNER_ID)
      throw new Error("An isolated executor database is required");
    const admin = new Pool({ connectionString: url, max: 1 });
    const identity = (await admin.query("SELECT environment_id FROM nano.environment_identity WHERE id=true")).rows[0]?.environment_id;
    if (identity !== process.env.PIVLOOM_ENVIRONMENT_ID) throw new Error("Isolated database identity mismatch");
    const ownerA = process.env.PIVLOOM_EXECUTOR_OWNER_ID, ownerB = randomUUID();
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [ownerB]);
    const database = new PivloomDatabase(url);
    let eventProjectId = "";
    try {
      const projects = createProjectRepository(database);
      const data = createAppDataRepository(database);
      const eventA = await projects.create(ownerA, "活动 A");
      eventProjectId = eventA.id;
      const eventB = await projects.create(ownerB, "活动 B");
      const booking = await projects.create(ownerA, "预约 A");
      for (const [ownerId, projectId, kind] of [[ownerA, eventA.id, "event-signup"],
        [ownerB, eventB.id, "event-signup"], [ownerA, booking.id, "appointments"]] as const)
        await database.owned(ownerId, async (client) => { await client.query(
          "INSERT INTO nano.app_data_profiles(owner_id,project_id,kind) VALUES($1,$2,$3)", [ownerId, projectId, kind]); });

      const registration = { name: "Alice", email: "alice@example.com", category: "创意沙龙" };
      expect(await data.profileForPublished(eventA.id)).toEqual({ ownerId: ownerA, kind: "event-signup" });
      const key = randomUUID();
      const first = await data.submit(ownerA, eventA.id, "event-signup", registration, key);
      expect(first).toMatchObject({ accepted: true, replayed: false });
      expect(await data.submit(ownerA, eventA.id, "event-signup", registration, key))
        .toMatchObject({ id: first.id, replayed: true });
      await expect(data.submit(ownerA, eventA.id, "event-signup", { ...registration, name: "Eve" }, key))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(data.submit(ownerA, eventA.id, "event-signup", registration, randomUUID()))
        .rejects.toMatchObject({ code: "ALREADY_REGISTERED" });
      expect((await data.list(ownerA, eventA.id, "event-signup")).records).toHaveLength(1);
      expect(await data.profileForOwner(ownerB, eventA.id)).toBeNull();
      await expect(data.setConfirmed(ownerB, eventA.id, first.id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await data.submit(ownerB, eventB.id, "event-signup", registration, randomUUID());
      expect((await data.list(ownerB, eventB.id, "event-signup")).records).toHaveLength(1);

      const slot = { date: "2027-01-15", time: "09:00", name: "Bob", contact: "bob@example.com" };
      const attempts = await Promise.allSettled([
        data.submit(ownerA, booking.id, "appointments", slot, randomUUID()),
        data.submit(ownerA, booking.id, "appointments", { ...slot, name: "Carol" }, randomUUID()),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((result) => result.status === "rejected" && result.reason.code === "SLOT_TAKEN")).toHaveLength(1);
      expect(await data.bookedSlots(ownerA, booking.id, slot.date)).toEqual(["09:00"]);
      expect((await data.list(ownerA, booking.id, "appointments")).records).toHaveLength(1);
      await data.setConfirmed(ownerA, eventA.id, first.id, true);

      const server = Fastify();
      server.decorateRequest("identity", null);
      // The real app also registers this wildcard first. Exact data routes must
      // win rather than falling through to the static SPA page.
      server.get("/__published/*", async () => "static-fallback");
      await registerAppDataRoutes(server, { database,
        publishedFromHost: async (host) => host === `${eventA.id}.app.example.test` ? {
          projectId: eventA.id, revisionId: randomUUID(), sourceHash: "a".repeat(64),
          url: `https://${host}/`, publishedAt: new Date().toISOString(),
        } : null,
        verifyIdentity: async (request) => {
          if (request.headers.authorization !== "Bearer fixture") throw new ApiFailure(401, "UNAUTHENTICATED", "需要登录");
          request.identity = { id: ownerA, email: "owner@example.test", name: "Owner" };
        },
      });
      try {
        const runtime = await server.inject({ method: "GET", url: "/__published/__pivloom/runtime",
          headers: { host: `${eventA.id}.app.example.test` } });
        expect(runtime.statusCode).toBe(200);
        expect(runtime.json()).toMatchObject({ mode: "published", kind: "event-signup" });
        const publicSubmit = await server.inject({ method: "POST", url: "/__published/__pivloom/data/registrations",
          headers: { host: `${eventA.id}.app.example.test`, "idempotency-key": randomUUID() },
          payload: { name: "Bob", email: "bob@example.com", category: "产品分享" } });
        expect(publicSubmit.statusCode).toBe(201);
        expect(publicSubmit.json()).toMatchObject({ accepted: true });
        expect(publicSubmit.json()).not.toHaveProperty("email");
        const wrongHost = await server.inject({ method: "POST", url: "/__published/__pivloom/data/registrations",
          headers: { host: "wrong.app.example.test", "idempotency-key": randomUUID() }, payload: registration });
        expect(wrongHost.statusCode).toBe(404);
        const publicList = await server.inject({ method: "GET", url: "/__published/__pivloom/data/registrations",
          headers: { host: `${eventA.id}.app.example.test` } });
        expect(publicList.statusCode).toBe(404);
        const unauthenticated = await server.inject({ method: "GET", url: `/api/v1/projects/${eventA.id}/app-data/records` });
        expect(unauthenticated.statusCode).toBe(401);
        const ownerList = await server.inject({ method: "GET", url: `/api/v1/projects/${eventA.id}/app-data/records`,
          headers: { authorization: "Bearer fixture" } });
        expect(ownerList.statusCode).toBe(200);
        expect(ownerList.json().records).toHaveLength(2);
      } finally { await server.close(); }
    } finally { await database.close(); await admin.end(); }

    const reopened = new PivloomDatabase(url);
    try {
      const records = await createAppDataRepository(reopened).list(ownerA, eventProjectId, "event-signup");
      expect(records.records).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Alice", confirmed: true })]));
    } finally { await reopened.close(); }
  }, 30_000);
});
