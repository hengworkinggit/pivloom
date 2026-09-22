import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/app.js";

const apps: FastifyInstance[] = [];
const fixtures: Server[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(fixtures.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

// This is an external Auth HTTP fixture, not a cloud identity/E2E pass.
test("a locally plausible JWT is denied when Auth rejects it", async () => {
  const auth = createServer((_request, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "invalid JWT", code: "bad_jwt" }));
  });
  fixtures.push(auth);
  await new Promise<void>((resolve) => auth.listen(0, "127.0.0.1", resolve));
  const address = auth.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const app = createApp({
    env: {
      APP_ORIGIN: "http://localhost:45231",
      SUPABASE_URL: `http://127.0.0.1:${address.port}`,
      SUPABASE_SECRET_KEY: "fixture-key-not-a-real-secret",
      DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
    },
    logger: false,
  });
  apps.push(app);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const payload = Buffer.from(JSON.stringify({ sub: "6275c8b0-3d12-4a44-a3b8-1c0c5f8e2b6d", exp: 9_999_999_999 })).toString("base64url");
  const response = await fetch(`${origin}/api/v1/me`, {
    headers: { Authorization: `Bearer eyJhbGciOiJub25lIn0.${payload}.unsigned` },
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
});

test("a missing model master key gives authenticated callers a configuration error without exposing profiles", async () => {
  const ownerId = "6275c8b0-3d12-4a44-a3b8-1c0c5f8e2b6d";
  const auth = createServer((request, response) => {
    response.writeHead(request.headers.authorization === "Bearer fixture-access-token" ? 200 : 401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: ownerId, email: "owner@example.test", user_metadata: {} }));
  });
  fixtures.push(auth);
  await new Promise<void>((resolve) => auth.listen(0, "127.0.0.1", resolve));
  const address = auth.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const app = createApp({ env: {
    APP_ORIGIN: "http://localhost:45231",
    SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_SECRET_KEY: "fixture-key-not-a-real-secret",
    DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
  }, logger: false });
  apps.push(app);
  const anonymous = await app.inject({ method: "GET", url: "/api/v1/model-profiles" });
  expect(anonymous.statusCode).toBe(401);
  for (const url of ["/api/v1/model-profiles", "/api/v1/model-profiles/test", `/api/v1/model-profiles/${ownerId}/test`]) {
    const response = await app.inject({ method: "GET", url, headers: { authorization: "Bearer fixture-access-token" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "MODEL_CONFIGURATION_MISSING", retryable: false } });
    expect(response.body).not.toContain("fixture-key-not-a-real-secret");
  }
});
