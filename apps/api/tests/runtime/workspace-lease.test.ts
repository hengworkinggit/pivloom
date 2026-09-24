import { afterEach, expect, test, vi } from "vitest";
import { Sandbox } from "@alibaba-group/opensandbox";
import {
  OpenSandboxWorkspace,
  type SandboxConnection,
} from "../../src/runtime/workspace.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const renewals: number[] = [];
  let running = true;
  let failNext = false;
  const connection: SandboxConnection = {
    sandboxId: "lease-fixture",
    kill: async () => { running = false; },
    isRunning: async () => running,
    renew: async (seconds) => {
      if (failNext) { failNext = false; throw new Error("SDK renewal failed"); }
      renewals.push(seconds);
    },
    close: async () => {},
    endpoint: async () => ({ url: "http://localhost:18080", headers: {} }),
    run: async () => { throw new Error("Unexpected command"); },
    read: async () => new Uint8Array(),
    write: async () => {},
  };
  const workspace = new OpenSandboxWorkspace(
    { baseUrl: "http://localhost:18080", apiKey: "fixture", image: "fixture", lifetimeMs: 300_000 },
    { create: async () => connection },
  );
  return { workspace, renewals, failOnce: () => { failNext = true; } };
}

test("five-minute confirmed lease segments keep one sandbox alive for more than 30 minutes", async () => {
  vi.useFakeTimers();
  const started = new Date("2026-09-24T00:00:00.000Z");
  vi.setSystemTime(started);
  const { workspace, renewals } = fixture();
  const signal = new AbortController();
  let handle = await workspace.create({ runId: "rolling-run", signal: signal.signal });
  expect(renewals).toEqual([300]);
  for (let segment = 0; segment < 8; segment++) {
    vi.setSystemTime(Date.now() + 240_000);
    handle = await workspace.renewLease(handle, 300_000, signal.signal);
    expect(Date.parse(handle.expiresAt)).toBeGreaterThan(Date.now());
  }
  expect(renewals).toEqual(Array(9).fill(300));
  expect(Date.now() - started.getTime()).toBe(32 * 60_000);
  expect(Date.parse(handle.expiresAt) - started.getTime()).toBe(37 * 60_000);
  expect(workspace.resources()).toEqual([{ sandboxId: "lease-fixture", state: "active" }]);
});

test("SDK failure, cancellation and destroyed resource never report a renewed lease", async () => {
  const { workspace, renewals, failOnce } = fixture();
  const controller = new AbortController();
  const handle = await workspace.create({ runId: "fenced-run", signal: controller.signal });
  const previousExpiry = handle.expiresAt;
  failOnce();
  await expect(workspace.renewLease(handle, 300_000, controller.signal)).rejects.toThrow("SDK renewal failed");
  expect(handle.expiresAt).toBe(previousExpiry);
  expect(renewals).toEqual([300]);
  controller.abort();
  await expect(workspace.renewLease(handle, 300_000, controller.signal)).rejects.toThrow();
  expect(renewals).toEqual([300]);
  expect((await workspace.destroy(handle)).confirmed).toBe(true);
  await expect(workspace.renewLease(handle, 300_000)).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
  expect(renewals).toEqual([300]);
});

test("real connector adapts OpenSandbox SDK renewal in seconds", async () => {
  const renew = vi.fn(async (_seconds: number) => {});
  const create = vi.spyOn(Sandbox, "create").mockResolvedValue({
    id: "sdk-adapter-fixture", renew,
    close: async () => {},
  } as unknown as Sandbox);
  try {
    const workspace = new OpenSandboxWorkspace({
      baseUrl: "http://localhost:18080", apiKey: "fixture", image: "fixture", lifetimeMs: 300_000,
    });
    const handle = await workspace.create({ runId: "sdk-adapter-run", signal: new AbortController().signal });
    const renewed = await workspace.renewLease(handle, 300_000);
    expect(create).toHaveBeenCalledOnce();
    expect(renew).toHaveBeenNthCalledWith(1, 300);
    expect(renew).toHaveBeenNthCalledWith(2, 300);
    expect(renewed).toMatchObject({ sandboxId: "sdk-adapter-fixture" });
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
  } finally {
    create.mockRestore();
  }
});
