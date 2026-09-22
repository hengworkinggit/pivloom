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

test("a sandbox whose durable registration fails is destroyed before it can be used", async () => {
  let live = true;
  const connection: SandboxConnection = {
    sandboxId: "registration-failure",
    kill: async () => {
      live = false;
    },
    isRunning: async () => live,
    renew: async () => {},
    close: async () => {},
    endpoint: async () => ({ url: "http://localhost:1", headers: {} }),
    run: async () => {
      throw new Error("Unregistered sandbox must not execute");
    },
    read: async () => new Uint8Array(),
    write: async () => {},
  };
  const workspace = new OpenSandboxWorkspace(
    { baseUrl: "http://localhost:18080", apiKey: "fixture", image: "fixture" },
    { create: async () => connection },
  );
  await expect(
    workspace.create({
      runId: "fixture-registration-failure",
      signal: new AbortController().signal,
      onCreated: async () => {
        throw new Error("Registration unavailable");
      },
    }),
  ).rejects.toMatchObject({ code: "SANDBOX_REGISTRATION_FAILED" });
  expect(live).toBe(false);
  expect(workspace.resources()).toEqual([
    { sandboxId: "registration-failure", state: "destroyed" },
  ]);
});

test("reconnecting a candidate permits trusted reads and browser service commands but grants no Builder writes", async () => {
  let renewals = 0;
  let kills = 0;
  let closes = 0;
  let request: { op?: string; path?: string } = {};
  const commands: string[] = [];
  const connection: SandboxConnection = {
    sandboxId: "candidate-read-only",
    kill: async () => {
      kills++;
    },
    isRunning: async () => true,
    renew: async () => {
      renewals++;
    },
    close: async () => {
      closes++;
    },
    endpoint: async () => ({
      url: "http://localhost:18080/preview",
      headers: {},
    }),
    write: async (_path, data) => {
      request = JSON.parse(Buffer.from(data).toString());
    },
    read: async () => new Uint8Array(),
    run: async (command) => {
      commands.push(command);
      return {
        id: "read-command",
        interrupt: async () => {},
        wait: async () => ({
          exitCode: 0,
          stdoutTail: command.startsWith("node /opt/pivloom/source-io.mjs")
            ? JSON.stringify({
                data: Buffer.from("export default function App() {}").toString(
                  "base64",
                ),
              })
            : "browser-service-ok",
          stderrTail: "",
        }),
      };
    },
  };
  const workspace = new OpenSandboxWorkspace(
    { baseUrl: "http://localhost:18080", apiKey: "fixture", image: "fixture" },
    {
      create: async () => {
        throw new Error("Review must not create a sandbox");
      },
      connect: async (_config, sandboxId) => {
        expect(sandboxId).toBe("candidate-read-only");
        return connection;
      },
    },
  );
  const handle = {
    sandboxId: "candidate-read-only",
    expiresAt: "2030-01-01T00:00:00Z",
  };
  await workspace.connect(handle);
  expect(
    Buffer.from(await workspace.read(handle, "src/App.tsx")).toString(),
  ).toBe("export default function App() {}");
  expect(request).toEqual({ op: "read", path: "src/App.tsx" });
  expect(
    await workspace.executeService(handle, "trusted-browser-command", {
      uid: 0,
    }),
  ).toMatchObject({ exitCode: 0, stdoutTail: "browser-service-ok" });
  const before = commands.length;
  await expect(
    workspace.write(handle, "src/App.tsx", Buffer.from("altered")),
  ).rejects.toMatchObject({ code: "WRITER_REVOKED" });
  await expect(
    workspace.exec(handle, { command: "echo altered" }),
  ).rejects.toMatchObject({ code: "WRITER_REVOKED" });
  await expect(
    workspace.initialize(handle, {}, "altered helper"),
  ).rejects.toMatchObject({ code: "WRITER_REVOKED" });
  expect(commands).toHaveLength(before);
  await workspace.releaseClient(handle);
  expect({ renewals, kills, closes }).toEqual({
    renewals: 0,
    kills: 0,
    closes: 1,
  });
});

test.each([
  {
    abortAt: "before-list",
    staged: [],
    executed: [],
  },
  {
    abortAt: "after-first-stage",
    staged: ["list", "read:src/first.ts"],
    executed: ["list"],
  },
  {
    abortAt: "after-first-read",
    staged: ["list", "read:src/first.ts"],
    executed: ["list", "read:src/first.ts"],
  },
])(
  "source collection stops new remote I/O when aborted $abortAt",
  async ({ abortAt, staged: expectedStaged, executed: expectedExecuted }) => {
    const controller = new AbortController();
    const deadline = new Error("Reviewer deadline fixture");
    const requests = new Map<string, { op: string; path?: string }>();
    const staged: string[] = [];
    const executed: string[] = [];
    const connection: SandboxConnection = {
      sandboxId: "deadline-read-only",
      kill: async () => {},
      isRunning: async () => true,
      renew: async () => {},
      close: async () => {},
      endpoint: async () => ({
        url: "http://localhost:18080/preview",
        headers: {},
      }),
      read: async () => new Uint8Array(),
      write: async (path, data) => {
        const request = JSON.parse(Buffer.from(data).toString()) as {
          op: string;
          path?: string;
        };
        requests.set(path, request);
        staged.push(
          request.path ? `${request.op}:${request.path}` : request.op,
        );
        if (abortAt === "after-first-stage" && request.path === "src/first.ts")
          controller.abort(deadline);
      },
      run: async (command) => {
        const path = command.match(
          /^node \/opt\/pivloom\/source-io\.mjs '([^']+)'$/,
        )?.[1];
        const request = path && requests.get(path);
        if (!request) throw new Error("Unexpected source command");
        executed.push(
          request.path ? `${request.op}:${request.path}` : request.op,
        );
        return {
          id: "source-command",
          interrupt: async () => {},
          wait: async () => {
            if (
              abortAt === "after-first-read" &&
              request.path === "src/first.ts"
            )
              controller.abort(deadline);
            return {
              exitCode: 0,
              stdoutTail: JSON.stringify(
                request.op === "list"
                  ? { files: ["src/first.ts", "src/second.ts"] }
                  : {
                      data: Buffer.from("export const value = 1;").toString(
                        "base64",
                      ),
                    },
              ),
              stderrTail: "",
            };
          },
        };
      },
    };
    const workspace = new OpenSandboxWorkspace(
      {
        baseUrl: "http://localhost:18080",
        apiKey: "fixture",
        image: "fixture",
      },
      {
        create: async () => {
          throw new Error("Review must not create a sandbox");
        },
        connect: async () => connection,
      },
    );
    const handle = {
      sandboxId: "deadline-read-only",
      expiresAt: "2030-01-01T00:00:00Z",
    };
    await workspace.connect(handle);
    if (abortAt === "before-list") controller.abort(deadline);
    try {
      await expect(
        workspace.listSourceFiles(handle, { signal: controller.signal }),
      ).rejects.toBe(deadline);
      expect(staged).toEqual(expectedStaged);
      expect(executed).toEqual(expectedExecuted);
    } finally {
      await workspace.releaseClient(handle);
    }
  },
);

test("listSourceFiles excludes TypeScript incremental build info", async () => {
  const requests = new Map<string, { op: string; path?: string }>();
  const readPaths: string[] = [];
  const connection: SandboxConnection = {
    sandboxId: "build-artifact-filter",
    kill: async () => {},
    isRunning: async () => true,
    renew: async () => {},
    close: async () => {},
    endpoint: async () => ({ url: "http://localhost:19001/preview", headers: {} }),
    read: async () => new Uint8Array(),
    write: async (path, data) => {
      const request = JSON.parse(Buffer.from(data).toString()) as { op: string; path?: string };
      requests.set(path, request);
      if (request.op !== "list") readPaths.push(request.path ?? "");
    },
    run: async (command) => {
      const path = command.match(/^node \/opt\/pivloom\/source-io\.mjs '([^']+)'$/)?.[1];
      const request = path && requests.get(path);
      if (!request) throw new Error("Unexpected source command");
      return {
        id: "source-command",
        interrupt: async () => {},
        wait: async () => ({
          exitCode: 0,
          stdoutTail: JSON.stringify(
            request.op === "list"
              ? { files: ["src/App.tsx", "tsconfig.tsbuildinfo"] }
              : { data: Buffer.from("export const title = 1;").toString("base64") },
          ),
          stderrTail: "",
        }),
      };
    },
  };
  const workspace = new OpenSandboxWorkspace(
    { baseUrl: "http://localhost:18080", apiKey: "fixture", image: "fixture" },
    { create: async () => { throw new Error("No sandbox may be created"); }, connect: async () => connection },
  );
  const handle = { sandboxId: "build-artifact-filter", expiresAt: "2030-01-01T00:00:00Z" };
  await workspace.connect(handle);
  try {
    const files = await workspace.listSourceFiles(handle);
    expect(files.map((file) => file.path)).toEqual(["src/App.tsx"]);
    expect(readPaths).not.toContain("tsconfig.tsbuildinfo");
  } finally {
    await workspace.releaseClient(handle);
  }
});
