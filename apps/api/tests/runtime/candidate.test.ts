import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import type { Handoff } from "@pivloom/contracts";
import { runCandidate } from "../../src/generation/candidate.js";
import { createRunTokenBudget } from "../../src/runtime/token-budget.js";
import { RUN_DEADLINE_MINUTES } from "../../src/runtime/budgets.js";
import type {
  SandboxConnection,
  SandboxConnector,
} from "../../src/runtime/workspace.js";

// External model SSE and remote process/file responses are fixtures. Pi, the
// candidate lifecycle, tool adapters, build gate and snapshot code remain real.
// This does not claim that these fixture commands compiled code in OpenSandbox.
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function remoteFixture(
  options: { typecheckFails?: boolean; typecheckLog?: string; typecheckStderr?: string; buildFails?: boolean; previewFails?: boolean; killFails?: boolean } = {},
) {
  const files = new Map<string, Buffer>();
  let live = true;
  const commands: string[] = [];
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(files.get("/opt/pivloom/marker.json") ?? "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const connection: SandboxConnection = {
    sandboxId: randomUUID(),
    kill: async () => {
      if (options.killFails) throw new Error("External kill unavailable");
      live = false;
    },
    isRunning: async () => live,
    renew: async () => {},
    close: async () => {},
    read: async (path) => files.get(path) ?? Buffer.alloc(0),
    write: async (path, content) => {
      files.set(path, Buffer.from(content));
    },
    endpoint: async () => ({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      headers: {},
    }),
    run: async (command) => {
      commands.push(command);
      let stdoutTail = "",
        stderrTail = "",
        exitCode = 0;
      if (command.startsWith("node /opt/pivloom/source-io.mjs")) {
        const staging = command.split("'")[1];
        const request = JSON.parse(files.get(staging)!.toString()) as {
          op: string;
          path: string;
          data: string;
        };
        if (request.op === "write") {
          files.set(
            `/workspace/app/${request.path}`,
            Buffer.from(request.data, "base64"),
          );
          stdoutTail = '{"ok":true}';
        } else if (request.op === "read") {
          stdoutTail = JSON.stringify({
            data: files
              .get(`/workspace/app/${request.path}`)!
              .toString("base64"),
          });
        } else {
          stdoutTail = JSON.stringify({
            files: [...files.keys()]
              .filter((path) => path.startsWith("/workspace/app/"))
              .map((path) => path.slice(15)),
          });
        }
      } else if (command.includes('readFileSync("/workspace/package.json"')) {
        stdoutTail =
          '{"name":"remote-fixture","dependencies":{"react":"19.2.4"}}';
      } else if (
        command.includes('readFileSync("/workspace/package-lock.json"')
      ) {
        stdoutTail = '{"name":"remote-fixture","lockfileVersion":3}';
      } else if (
        options.typecheckFails &&
        command.includes("typescript/bin/tsc")
      ) {
        exitCode = 2;
        stdoutTail = options.typecheckLog ?? "src/App.tsx(1,1): error TS2322: fixture typecheck failure";
        stderrTail = options.typecheckStderr ?? "";
      } else if (command.includes("typescript/bin/tsc")) {
        stdoutTail = "Type check completed";
      } else if (options.buildFails && command.includes("vite.js build")) {
        exitCode = 1;
        stderrTail = "error during build: fixture missing module";
      } else if (options.previewFails && command.startsWith("cp /opt/pivloom/marker.json")) {
        exitCode = 17;
        stderrTail = "fixture marker copy unavailable";
      }
      return {
        id: randomUUID(),
        wait: async () => ({ exitCode, stdoutTail, stderrTail }),
        interrupt: async () => {},
      };
    },
  };
  const connector: SandboxConnector = { create: async () => connection };
  return { connector, files, commands, isLive: () => live };
}

function modelFixture(content: string, reportedUsage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }) {
  const requests: Array<{
    messages: Array<{ role: string; content: unknown }>;
  }> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const delta =
      requests.length === 1
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fixture-write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: "src/App.tsx", content }),
                },
              },
            ],
          }
        : { role: "assistant", content: "已按需求实现。" };
    const chunk = {
      id: "fixture-response",
      object: "chat.completion.chunk",
      created: 1,
      model: "candidate-fixture",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }], usage: reportedUsage })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  return {
    requests,
    config: {
      provider: "candidate-fixture",
      id: "candidate-fixture",
      api: "openai-completions" as const,
      baseUrl: "https://model-fixture.invalid/v1",
      apiKey: "model-fixture-secret",
      fetch,
    },
  };
}

const sandboxConfig = {
  baseUrl: "http://127.0.0.1:18080",
  apiKey: "sandbox-fixture-secret",
  image: "fixture",
};

test("a shared run token budget prevents another provider call and still cleans the candidate sandbox", async () => {
  const remote = await remoteFixture();
  const model = modelFixture("export default function App(){return <h1>不应生成</h1>}");
  const result = await runCandidate({
    runId: randomUUID(), revisionId: randomUUID(), prompt: "创建奖金计算器",
    modelConfig: model.config, sandboxConfig, signal: new AbortController().signal,
    tokenBudget: createRunTokenBudget(1),
  }, { sandboxConnector: remote.connector });
  expect(result).toMatchObject({ status: "failed", cleanup: "confirmed", error: { code: "TOKEN_BUDGET_EXCEEDED" } });
  expect(model.requests).toEqual([]);
  expect(remote.isLive()).toBe(false);
  expect(result.usage).toMatchObject({ input: null, output: null, total: null, cachedTokens: null,
    modelCalls: 0, toolCalls: 0, source: "unreported" });
});

test("a later token budget rejection retains real provider usage in the failed candidate result", async () => {
  const remote = await remoteFixture();
  const model = modelFixture("export default function App(){return <h1>奖金</h1>}", { prompt_tokens: 58_000, completion_tokens: 10, total_tokens: 58_010 });
  const result = await runCandidate({
    runId: randomUUID(), revisionId: randomUUID(), prompt: "创建奖金计算器",
    modelConfig: model.config, sandboxConfig, signal: new AbortController().signal,
    tokenBudget: createRunTokenBudget(60_000),
  }, { sandboxConnector: remote.connector });
  expect(result).toMatchObject({ status: "failed", cleanup: "confirmed", error: { code: "TOKEN_BUDGET_EXCEEDED" },
    usage: { input: 58_000, output: 10, total: 58_010, modelCalls: 1, toolCalls: 1, cachedTokens: null, source: "partial" } });
  expect(result.usage?.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(model.requests).toHaveLength(1);
  expect(remote.isLive()).toBe(false);
});

test("Builder receives the persisted plan and original clarification context, not just the short answer", async () => {
  const remote = await remoteFixture();
  const model = modelFixture("export default function App(){return <h1>奖金计算</h1>}");
  const runId = randomUUID();
  const task = `原始需求：奖金计算页面。\n澄清：奖金怎么算？\n回答：每满1000元奖金100元。\n${"已确认的需求上下文。".repeat(850)}`;
  const input = {
    runId, revisionId: randomUUID(), prompt: "每满1000元奖金100元。", modelConfig: model.config,
    sandboxConfig, signal: new AbortController().signal,
    handoff: {
      runId, fromRoleRunId: randomUUID(), toRole: "builder", attempt: 0,
      baseRevisionId: null, expectedRevisionId: null, sourceHash: null, task, artifactIds: [],
      plan: { schemaVersion: 1, goal: "按明确公式计算奖金", changeSummary: "实现中文计算表单", assumptions: [], outOfScope: ["真实发薪"],
        behaviors: [{ id: "B01", title: "计算整千奖励", precondition: "页面已打开", action: "输入2500并计算", expected: "显示奖金200元", required: true }] },
    } satisfies Handoff,
  };
  const result = await runCandidate(input, { sandboxConnector: remote.connector });
  expect(result.status).toBe("candidate");
  const sent = JSON.stringify(model.requests[0].messages.filter((message) => message.role === "user"));
  expect(sent).toContain("原始需求：奖金计算页面");
  expect(sent).toContain("澄清：奖金怎么算");
  expect(sent).toContain("显示奖金200元");
  expect(sent).toContain("真实发薪");
});

test.each(["other-run", "wrong-role"])("a %s handoff cannot provision a Builder sandbox", async (invalid) => {
  const remote = await remoteFixture();
  const model = modelFixture("export default function App(){return <h1>不应运行</h1>}");
  const runId = randomUUID();
  const handoff: Handoff = {
    runId: invalid === "other-run" ? randomUUID() : runId, fromRoleRunId: randomUUID(),
    toRole: invalid === "wrong-role" ? "coordinator" : "builder", attempt: 0,
    baseRevisionId: null, expectedRevisionId: null, sourceHash: null, task: "计算奖金", artifactIds: [],
    plan: { schemaVersion: 1, goal: "奖金计算", changeSummary: "创建计算器", assumptions: [], outOfScope: [],
      behaviors: [{ id: "B01", title: "计算", precondition: "页面已打开", action: "输入1000", expected: "显示100", required: true }] },
  };
  const result = await runCandidate({ runId, revisionId: randomUUID(), prompt: "计算奖金", handoff,
    modelConfig: model.config, sandboxConfig, signal: new AbortController().signal }, { sandboxConnector: remote.connector });
  expect(result.status).toBe("failed");
  if (result.status !== "failed") throw new Error("Invalid handoff was accepted");
  expect(result.error.code).toBe("INVALID_HANDOFF");
  expect(result.cleanup).toBe("not_created");
  expect(remote.commands).toEqual([]);
  expect(model.requests).toEqual([]);
});

test("the real Pi tool loop implements the supplied task and returns an unreviewed versioned candidate after event flush", async () => {
  const remote = await remoteFixture();
  const source = "export default function App(){return <h1>我的读书清单</h1>}";
  const model = modelFixture(source);
  const registrations: string[] = [],
    events: string[] = [];
  let activeEvents = 0,
    maxActiveEvents = 0;
  const prompt =
    "做一个读书清单，用户可以录入书名和标记已读，不要活动报名或邮箱字段。";
  const revisionId = randomUUID();
  const previewBasePath = `/p/${revisionId}/`;
  const result = await runCandidate(
    {
      runId: randomUUID(),
      revisionId,
      roleRunId: "builder-role",
      sessionId: "builder-session",
      previewBasePath,
      prompt,
      modelConfig: model.config,
      sandboxConfig,
      signal: new AbortController().signal,
      onSandbox: async (binding) => {
        registrations.push(binding.state);
      },
      onEvent: async (event) => {
        maxActiveEvents = Math.max(maxActiveEvents, ++activeEvents);
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push(event.type);
        activeEvents--;
      },
    },
    { sandboxConnector: remote.connector },
  );
  expect(result.status).toBe("candidate");
  if (result.status !== "candidate") throw new Error(JSON.stringify(result));
  expect(result.snapshot.bundle).toMatchObject({
    schemaVersion: 1,
    templateVersion: "react-vite-node24-20260922",
    files: expect.arrayContaining([
      {
        path: "src/App.tsx",
        encoding: "utf8",
        content: source,
        sha256: expect.any(String),
      },
    ]),
  });
  expect(model.requests[0].messages.at(-1)?.content).toEqual([
    { type: "text", text: prompt },
  ]);
  expect(result.toolCalls).toEqual([
    { id: "fixture-write", name: "write", success: true },
  ]);
  expect(registrations).toEqual(["created", "preview_ready", "retained"]);
  expect(maxActiveEvents).toBe(1);
  expect(activeEvents).toBe(0);
  expect(events).toContain("model.stream.started");
  expect(events).not.toContain("browser.action");
  expect(remote.isLive()).toBe(true);
  expect(result.preview.basePath).toBe(previewBasePath);
  expect(
    remote.files.get("/opt/pivloom/vite-config.mjs")!.toString(),
  ).toContain(JSON.stringify(previewBasePath));
});

test("a failed fixed build preserves safe diagnostic sources and destroys the candidate without publishing a preview", async () => {
  const remote = await remoteFixture({ typecheckFails: true });
  const source =
    "export default function App(){ const title: number = 'wrong'; return <h1>{title}</h1> }";
  const model = modelFixture(source);
  const states: string[] = [];
  const result = await runCandidate(
    {
      runId: randomUUID(),
      revisionId: randomUUID(),
      prompt: "实现读书应用",
      modelConfig: model.config,
      sandboxConfig,
      signal: new AbortController().signal,
      onSandbox: async (binding) => {
        states.push(binding.state);
      },
    },
    { sandboxConnector: remote.connector },
  );
  expect(result).toMatchObject({
    status: "failed",
    cleanup: "confirmed",
    error: { code: "TYPECHECK_FAILED" },
    diagnosticBuildStatus: "failed",
    trustedBuild: {
      schemaVersion: 1,
      typecheck: {
        command: expect.stringContaining("typescript/bin/tsc --noEmit"),
        exitCode: 2,
        durationMs: expect.any(Number),
        stdoutTail: "src/App.tsx(1,1): error TS2322: fixture typecheck failure",
        stderrTail: "",
      },
      build: null,
    },
    diagnosticSnapshot: {
      bundle: {
        files: expect.arrayContaining([
          expect.objectContaining({ path: "src/App.tsx", content: source }),
        ]),
      },
    },
  });
  expect(result).not.toHaveProperty("preview");
  if (result.status === "candidate") throw new Error("Expected a failed diagnostic candidate");
  expect(result.error.message).not.toContain("TS2322");
  expect(states).toEqual(["created", "destroyed"]);
  expect(remote.isLive()).toBe(false);
});

test("a failed production build retains its command result and the successful typecheck", async () => {
  const remote = await remoteFixture({ buildFails: true });
  const model = modelFixture("export default function App(){return <h1>读书</h1>}");
  const result = await runCandidate({
    runId: randomUUID(), revisionId: randomUUID(), prompt: "读书清单", modelConfig: model.config,
    sandboxConfig, signal: new AbortController().signal,
  }, { sandboxConnector: remote.connector });
  expect(result).toMatchObject({
    status: "failed", cleanup: "confirmed", error: { code: "BUILD_FAILED" }, diagnosticBuildStatus: "failed",
    trustedBuild: {
      typecheck: { command: expect.stringContaining("typescript/bin/tsc"), exitCode: 0, durationMs: expect.any(Number), stdoutTail: "Type check completed" },
      build: { command: "node /workspace/node_modules/vite/bin/vite.js build --config /opt/pivloom/vite-config.mjs --configLoader native",
        exitCode: 1, durationMs: expect.any(Number), stdoutTail: "", stderrTail: "error during build: fixture missing module" },
    },
  });
  if (result.status === "candidate") throw new Error("Expected a failed diagnostic candidate");
  expect(result.trustedBuild?.sourceHash).toBe(result.diagnosticSnapshot?.sourceHash);
  expect(result.error.message).not.toContain("fixture missing module");
  expect(result).not.toHaveProperty("preview");
  expect(remote.isLive()).toBe(false);
});

test("trusted build diagnostics redact credentials before clipping UTF-8 log tails and keep raw logs out of the public error", async () => {
  const log = "诊断".repeat(2000) + " model-fixture-secret sandbox-fixture-secret Bearer upstream-fixture-token";
  const remote = await remoteFixture({ typecheckFails: true, typecheckLog: log, typecheckStderr: log });
  const model = modelFixture("export default function App(){return <h1>读书</h1>}");
  const result = await runCandidate({
    runId: randomUUID(), revisionId: randomUUID(), prompt: "读书清单", modelConfig: model.config,
    sandboxConfig, signal: new AbortController().signal,
  }, { sandboxConnector: remote.connector });
  if (result.status === "candidate" || !result.trustedBuild?.typecheck) throw new Error("Expected bounded diagnostic metadata");
  const record = result.trustedBuild.typecheck;
  for (const tail of [record.stdoutTail, record.stderrTail]) {
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(2048);
    expect(tail).toContain("[REDACTED]");
    expect(tail).not.toContain("\ufffd");
  }
  for (const secret of [model.config.apiKey, sandboxConfig.apiKey, "upstream-fixture-token"]) {
    expect(JSON.stringify(result.trustedBuild)).not.toContain(secret);
    expect(result.error.message).not.toContain(secret);
  }
  expect(result.error.message).not.toContain("诊断诊断");
});

test("preview failure preserves a build-passed diagnostic revision without making a preview available", async () => {
  const remote = await remoteFixture({ previewFails: true });
  const model = modelFixture("export default function App(){return <h1>读书</h1>}");
  const result = await runCandidate({
    runId: randomUUID(), revisionId: randomUUID(), prompt: "读书清单", modelConfig: model.config,
    sandboxConfig, signal: new AbortController().signal,
  }, { sandboxConnector: remote.connector });
  expect(result).toMatchObject({
    status: "failed", cleanup: "confirmed", error: { code: "PREVIEW_START_FAILED" },
    diagnosticBuildStatus: "passed",
    trustedBuild: { typecheck: { exitCode: 0 }, build: { exitCode: 0 } },
  });
  if (result.status === "candidate") throw new Error("Expected a failed diagnostic candidate");
  expect(result.trustedBuild?.sourceHash).toBe(result.diagnosticSnapshot?.sourceHash);
  expect(result).not.toHaveProperty("preview");
  expect(remote.isLive()).toBe(false);
});

test("a binding persistence failure destroys the built sandbox instead of handing out an unregistered preview", async () => {
  const remote = await remoteFixture();
  const model = modelFixture(
    "export default function App(){return <h1>读书</h1>}",
  );
  const states: string[] = [];
  const result = await runCandidate(
    {
      runId: randomUUID(),
      revisionId: randomUUID(),
      prompt: "我的读书清单",
      modelConfig: model.config,
      sandboxConfig,
      signal: new AbortController().signal,
      onSandbox: async (binding) => {
        states.push(binding.state);
        if (binding.state === "preview_ready")
          throw new Error("DB binding unavailable");
      },
    },
    { sandboxConnector: remote.connector },
  );
  expect(result).toMatchObject({
    status: "failed",
    cleanup: "confirmed",
    error: { code: "SANDBOX_REGISTRATION_FAILED" },
  });
  expect(result).not.toHaveProperty("preview");
  expect(states).toEqual(["created", "preview_ready", "destroyed"]);
  expect(remote.isLive()).toBe(false);
});

test("an event storage failure after actual Pi SSE content stops the model and confirms sandbox cleanup", async () => {
  const remote = await remoteFixture();
  const model = modelFixture(
    "export default function App(){return <h1>读书</h1>}",
  );
  let observedDelta = false;
  const result = await runCandidate(
    {
      runId: randomUUID(),
      revisionId: randomUUID(),
      prompt: "我的读书清单",
      modelConfig: model.config,
      sandboxConfig,
      signal: new AbortController().signal,
      onEvent: async (event) => {
        if (event.type === "model.stream.started") {
          observedDelta = true;
          throw new Error("Event store unavailable");
        }
      },
    },
    { sandboxConnector: remote.connector },
  );
  expect(observedDelta).toBe(true);
  expect(result).toMatchObject({
    status: "failed",
    cleanup: "confirmed",
    error: { code: "EVENT_APPEND_FAILED" },
  });
  expect(remote.isLive()).toBe(false);
});

test("a parent run deadline reports RUN_TIMEOUT and confirmed cleanup rather than user cancellation", async () => {
  const remote = await remoteFixture();
  const model = modelFixture("export default function App(){return <h1>读书</h1>}");
  const controller = new AbortController();
  const result = await runCandidate({
    runId: randomUUID(), revisionId: randomUUID(), prompt: "读书清单", modelConfig: model.config,
    sandboxConfig, signal: controller.signal,
    onEvent: async (event) => { if (event.type === "model.stream.started") controller.abort("RUN_TIMEOUT"); },
  }, { sandboxConnector: remote.connector });
  expect(result).toMatchObject({
    status: "failed", cleanup: "confirmed", error: { code: "RUN_TIMEOUT", message: expect.stringContaining(`${RUN_DEADLINE_MINUTES} 分钟`) },
  });
  expect(remote.isLive()).toBe(false);
  expect(result).not.toHaveProperty("preview");
});

test.each([false, true])(
  "cancel after a real Pi fixture delta reports remote cleanup truth (kill fails: %s)",
  async (killFails) => {
    const remote = await remoteFixture({ killFails });
    const model = modelFixture(
      "export default function App(){return <h1>读书</h1>}",
    );
    const controller = new AbortController();
    const states: string[] = [];
    const result = await runCandidate(
      {
        runId: randomUUID(),
        revisionId: randomUUID(),
        prompt: "我的读书清单",
        modelConfig: model.config,
        sandboxConfig,
        signal: controller.signal,
        onEvent: async (event) => {
          if (event.type === "model.stream.started") controller.abort();
        },
        onSandbox: async (binding) => {
          states.push(binding.state);
        },
      },
      { sandboxConnector: remote.connector },
    );
    expect(result).toMatchObject({
      status: killFails ? "cleanup_pending" : "cancelled",
      cleanup: killFails ? "pending" : "confirmed",
      error: { code: "CANCELLED" },
    });
    expect(remote.isLive()).toBe(killFails);
    expect(states.at(-1)).toBe(killFails ? "cleanup_pending" : "destroyed");
    expect(result).not.toHaveProperty("preview");
  },
);
