import { expect, test } from "vitest";
import {
  OpenSandboxWorkspace,
  type SandboxConnection,
  type SandboxConnector,
} from "../../src/runtime/workspace.js";

test("a sandbox created after cancellation is destroyed before the create call settles", async () => {
  let finishCreate!: (sandbox: SandboxConnection) => void;
  let live = true;
  const pending = new Promise<SandboxConnection>((resolve) => {
    finishCreate = resolve;
  });
  const connector: SandboxConnector = { create: () => pending };
  const workspace = new OpenSandboxWorkspace(
    {
      baseUrl: "http://localhost:18080",
      apiKey: "boundary-fixture",
      image: "fixture",
    },
    connector,
  );
  const signal = new AbortController();
  const created = workspace.create({
    runId: "fixture-late-create",
    signal: signal.signal,
  });
  signal.abort();
  finishCreate({
    sandboxId: "late-sandbox",
    kill: async () => {
      live = false;
    },
    isRunning: async () => live,
    renew: async () => {},
    close: async () => {},
    endpoint: async () => ({
      url: "http://localhost:19001/proxy/4173",
      headers: {},
    }),
    run: async () => {
      throw new Error("Cancelled creation must not start commands");
    },
    read: async () => new Uint8Array(),
    write: async () => {},
  });
  await expect(created).rejects.toMatchObject({ code: "CANCELLED" });
  expect(live).toBe(false);
  expect(workspace.resources()).toEqual([
    { sandboxId: "late-sandbox", state: "destroyed" },
  ]);
});

test("source reads reject traversal and credential paths before contacting the sandbox", async () => {
  const workspace = new OpenSandboxWorkspace(
    { baseUrl: "http://localhost:18080", apiKey: "fixture", image: "fixture" },
    {
      create: async () => {
        throw new Error("No sandbox may be created");
      },
    },
  );
  const handle = { sandboxId: "unknown", expiresAt: "2030-01-01T00:00:00Z" };
  for (const path of [
    "../secret",
    "/etc/passwd",
    ".env.local",
    "src/../../secret",
    "node_modules/a.ts",
  ]) {
    await expect(workspace.read(handle, path)).rejects.toMatchObject({
      code: "INVALID_SOURCE_PATH",
    });
  }
});

test("failed cleanup of a cancelled late sandbox remains pending", async () => {
  const controller = new AbortController();
  const connection: SandboxConnection = {
    sandboxId: "late-cleanup-failure",
    kill: async () => {
      throw new Error("External runtime unavailable");
    },
    isRunning: async () => true,
    renew: async () => {},
    close: async () => {},
    endpoint: async () => ({ url: "http://localhost:1", headers: {} }),
    run: async () => {
      throw new Error("Should not run");
    },
    read: async () => new Uint8Array(),
    write: async () => {},
  };
  const workspace = new OpenSandboxWorkspace(
    { baseUrl: "http://localhost:18080", apiKey: "fixture", image: "fixture" },
    {
      create: async () => {
        controller.abort();
        return connection;
      },
    },
  );
  await expect(
    workspace.create({
      runId: "fixture-failed-cleanup",
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "CLEANUP_PENDING" });
  expect(workspace.resources()).toEqual([
    { sandboxId: "late-cleanup-failure", state: "cleanup_pending" },
  ]);
});
