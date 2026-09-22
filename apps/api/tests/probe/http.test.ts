import { afterEach, expect, test } from "vitest";
import { createProbeApp } from "../../src/probe/app.js";

const apps: Awaited<ReturnType<typeof createProbeApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

test("maintenance probe rejects a remote Host before any cloud execution", async () => {
  const app = await createProbeApp({ port: 45232, env: {} });
  apps.push(app);
  const response = await app.app.inject({
    method: "POST",
    url: "/probe",
    headers: { host: "attacker.example", origin: "https://attacker.example" },
    payload: { prompt: "build a form" },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: { code: "LOCAL_ONLY" } });
});

test("a website cannot submit a probe to the loopback service", async () => {
  const app = await createProbeApp({ port: 45232, env: {} });
  apps.push(app);
  const response = await app.app.inject({
    method: "POST",
    url: "/probe",
    headers: { host: "localhost:45232", origin: "https://attacker.example" },
    payload: { prompt: "build a form" },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
});

test("the retired probe does not request obsolete credentials or start a runtime", async () => {
  const app = await createProbeApp({ port: 45232, env: {} });
  apps.push(app);
  const response = await app.app.inject({
    method: "POST",
    url: "/probe",
    headers: { host: "localhost:45232", origin: "http://localhost:45232" },
    payload: { prompt: "build a form" },
  });
  expect(response.statusCode).toBe(410);
  expect(response.json()).toMatchObject({ error: { code: "PROBE_RETIRED" } });
  expect(response.json()).not.toHaveProperty("missing");
  expect(response.body).not.toContain("E2B");
});

test("same-origin run creation still requires the page CSRF token", async () => {
  const app = await createProbeApp({ port: 45232, env: {} });
  apps.push(app);
  const response = await app.app.inject({
    method: "POST",
    url: "/runs",
    headers: { host: "localhost:45232", origin: "http://localhost:45232" },
    payload: { prompt: "build a form" },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
});

test("the maintenance page accepts a prompt without rendering any configured secret", async () => {
  const app = await createProbeApp({
    port: 45232,
    env: {
      OPENSANDBOX_API_KEY: "secret-not-for-html",
      MODEL_API_KEY: "legacy-secret",
    },
  });
  apps.push(app);
  const response = await app.app.inject({
    method: "GET",
    url: "/",
    headers: { host: "localhost:45232" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain('name="prompt"');
  expect(response.body).toContain('type="password"');
  expect(response.body).not.toContain("secret-not-for-html");
  expect(response.body).not.toContain("legacy-secret");
  expect(response.headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
});

test("an authorized maintenance request reports missing infrastructure by name only", async () => {
  const app = await createProbeApp({ port: 45232, env: {} });
  apps.push(app);
  const page = await app.app.inject({
    method: "GET",
    url: "/",
    headers: { host: "localhost:45232" },
  });
  const token = page.body.match(/name="g0-csrf" content="([^"]+)"/)?.[1];
  const response = await app.app.inject({
    method: "POST",
    url: "/runs",
    headers: {
      host: "localhost:45232",
      origin: "http://localhost:45232",
      "x-g0-csrf": token,
    },
    payload: {
      prompt: "build a form",
      model: {
        provider: "fixture",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        id: "fixture",
        apiKey: "must-not-echo",
      },
    },
  });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({
    error: { code: "CONFIGURATION_MISSING" },
    missing: [
      "OPENSANDBOX_BASE_URL",
      "OPENSANDBOX_API_KEY",
      "OPENSANDBOX_IMAGE",
    ],
  });
  expect(response.body).not.toContain("must-not-echo");
});

test("malformed temporary model JSON never echoes credential fragments", async () => {
  const app = await createProbeApp({ port: 45232, env: {} });
  apps.push(app);
  const page = await app.app.inject({
    method: "GET",
    url: "/",
    headers: { host: "localhost:45232" },
  });
  const token = page.body.match(/name="g0-csrf" content="([^"]+)"/)?.[1];
  const response = await app.app.inject({
    method: "POST",
    url: "/runs",
    headers: {
      host: "localhost:45232",
      origin: "http://localhost:45232",
      "x-g0-csrf": token,
      "content-type": "application/json",
    },
    payload: "credential-fragment-must-not-echo",
  });
  expect(response.statusCode).toBe(400);
  expect(response.body).not.toContain("credential-fragment-must-not-echo");
  expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
});
