import { afterEach, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/app.js";

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

test("an unconfigured real API stays live but refuses projects instead of supplying demo data", async () => {
  const app = createApp({ env: {}, logger: false });
  servers.push(app);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });

  const live = await fetch(`${origin}/api/v1/health/live`);
  expect(live.status).toBe(200);
  expect(await live.json()).toMatchObject({ status: "live" });

  const ready = await fetch(`${origin}/api/v1/health/ready`);
  expect(ready.status).toBe(503);
  const projects = await fetch(`${origin}/api/v1/projects`);
  expect(projects.status).toBe(503);
  expect(await projects.json()).toMatchObject({
    error: { code: "CONFIGURATION_MISSING", retryable: false },
  });
});

test("configured project endpoints reject a missing identity before connecting to the database", async () => {
  const app = createApp({
    env: {
      APP_ORIGIN: "http://localhost:45231",
      SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SECRET_KEY: "fixture-key-not-a-real-secret",
      DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
    },
    logger: false,
  });
  servers.push(app);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${origin}/api/v1/projects`);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
});

test.each([
  { status: 400, code: "INVALID_REQUEST", contentType: "application/json", body: '{"apiKey":"fixture-private-value"' },
  { status: 413, code: "PAYLOAD_TOO_LARGE", contentType: "application/json", body: JSON.stringify({ apiKey: "fixture-private-value".repeat(2000) }) },
  { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", contentType: "application/octet-stream", body: "fixture-private-value" },
])("request parsing returns safe $status feedback without echoing submitted credentials", async ({ status, code, contentType, body }) => {
  const app = createApp({ env: {}, logger: false });
  servers.push(app);
  const response = await app.inject({ method: "POST", url: "/api/v1/model-profiles", headers: { "content-type": contentType }, payload: body });
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable: false } });
  expect(response.body).not.toContain("fixture-private-value");
});
