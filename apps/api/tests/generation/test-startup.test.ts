import { expect, test } from "vitest";
import { createApp } from "../../src/app.js";

test("production refuses test adapters and fault profiles before connecting to services", () => {
  expect(() => createApp({ env: { NODE_ENV: "production" }, generationBoundaries: {} }))
    .toThrow("isolated test process");
  expect(() => createApp({ env: { NODE_ENV: "production", TEST_PROFILE: "BROKEN_FILTER_FIRST_ATTEMPT" } }))
    .toThrow("isolated test process");
});

test("per-account daily limits reject invalid owner or unbounded values at startup", () => {
  for (const value of ['{"not-an-owner":100}', '{"82024654-478f-4c61-8960-8f2025b6eeb0":0}', '{"82024654-478f-4c61-8960-8f2025b6eeb0":1001}'])
    expect(() => createApp({ env: { DAILY_RUN_LIMIT_OVERRIDES: value } })).toThrow();
});
