import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createModelFetch } from "../../src/models/transport.js";
import { sandboxConfiguration } from "../../src/probe/config.js";
import {
  OpenSandboxWorkspace,
  runBuilder,
  initializeReactWorkspace,
  RuntimeError,
  shellQuote,
  type ModelConfig,
  type ProbeEvent,
} from "../../src/runtime/index.js";

const inputSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    baseUrl: z.string().url(),
    api: z
      .enum(["openai-completions", "anthropic-messages"])
      .default("openai-completions"),
    apiKey: z.string().min(1),
    maxTokens: z.number().int().min(1024).max(8192).default(4096),
  })
  .strict();
const configuration = sandboxConfiguration(process.env);
if (!configuration.config)
  throw new Error(
    "OpenSandbox configuration is missing. Load apps/api/.env.local.",
  );
const config = { ...configuration.config, lifetimeMs: 180_000 };
const directory = resolve(
  process.env.G0_ARTIFACT_DIR ??
    fileURLToPath(
      new URL("../../../../.cache/g0-maintenance", import.meta.url),
    ),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const lines = createInterface({ input: process.stdin, terminal: false });
console.info(
  "G0_MODEL_INPUT_READY: send one JSON line through non-echoing stdin; never use a command-line Key.",
);
let [first] = await once(lines, "line");
let modelConfig: ModelConfig;
try {
  const input = inputSchema.parse(JSON.parse(String(first)));
  modelConfig = { ...input, fetch: createModelFetch(input.baseUrl) };
  first = "";
} catch {
  lines.close();
  throw new Error(
    "Temporary model input is invalid; no input values were logged.",
  );
}

const startedAt = new Date().toISOString();
const runId = randomUUID();
const modelWorkspace = new OpenSandboxWorkspace(config);
const controller = new AbortController();
const modelEvents: ProbeEvent[] = [];
const transport = {
  bytes: 0,
  abortObserved: false,
  responseStartedAt: undefined as string | undefined,
  streamClosedAt: undefined as string | undefined,
};
let streamStartedAt: string | undefined;
let abortRequestedAt: string | undefined;
let abortAfterStream = false;
let code = "NOT_RUN";
const requestAbort = () => {
  abortRequestedAt ??= new Date().toISOString();
  abortAfterStream = Boolean(streamStartedAt);
  controller.abort();
};
lines.on("line", (line) => {
  if (line.trim() === "abort" || line.trim() === '{"action":"abort"}')
    requestAbort();
});
process.once("SIGINT", requestAbort);
const deadline = setTimeout(() => controller.abort(), 150_000);
const realFetch = modelConfig.fetch!;
modelConfig.fetch = async (input, init) => {
  const request = new Request(input, init);
  request.signal.addEventListener(
    "abort",
    () => {
      transport.abortObserved = true;
    },
    { once: true },
  );
  const response = await realFetch(request);
  transport.responseStartedAt = new Date().toISOString();
  const reader = response.body?.getReader();
  if (!reader) return response;
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          transport.streamClosedAt = new Date().toISOString();
          stream.close();
        } else {
          transport.bytes += chunk.value.byteLength;
          stream.enqueue(chunk.value);
        }
      } catch (error) {
        transport.streamClosedAt = new Date().toISOString();
        stream.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        transport.streamClosedAt = new Date().toISOString();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
};
const handle = await modelWorkspace.create({
  runId,
  signal: controller.signal,
});
let modelCleanup = { confirmed: false };
try {
  await initializeReactWorkspace(modelWorkspace, handle);
  await runBuilder({
    workspace: modelWorkspace,
    handle,
    modelConfig,
    signal: controller.signal,
    timeoutMs: 120_000,
    prompt:
      "这是人工取消验证。不要调用任何工具。请逐行输出从1到20000的整数，每行加一句不同的中文解释，持续流式输出，直到收到取消信号。",
    onEvent: (event) => {
      modelEvents.push(event);
      if (event.type === "model.stream.started" && !streamStartedAt) {
        streamStartedAt = event.at;
        console.info(
          JSON.stringify({
            event: "G0_STREAM_STARTED",
            at: streamStartedAt,
            receivedBytes: transport.bytes,
            instruction:
              "Now send the line abort to request cancellation after real model output.",
          }),
        );
      }
    },
  });
  code = "COMPLETED_WITHOUT_ABORT";
} catch (error) {
  code = error instanceof RuntimeError ? error.code : "MODEL_ERROR";
} finally {
  clearTimeout(deadline);
  lines.close();
  process.removeListener("SIGINT", requestAbort);
  modelConfig.apiKey = "";
  modelCleanup = await modelWorkspace.destroy(handle);
}
const bytesAtSettlement = transport.bytes;
await new Promise((resolve) => setTimeout(resolve, 500));
const modelPass = Boolean(
  streamStartedAt &&
    abortAfterStream &&
    code === "CANCELLED" &&
    transport.abortObserved &&
    transport.streamClosedAt &&
    modelEvents.some(
      (event) => event.type === "model.stopped" && event.success,
    ) &&
    transport.bytes === bytesAtSettlement &&
    modelCleanup.confirmed,
);
const modelEvidence = {
  status: modelPass ? "PASS" : "FAIL",
  provider: modelConfig.provider,
  modelId: modelConfig.id,
  streamStartedAt,
  abortRequestedAt,
  abortAfterStream,
  resultCode: code,
  transport,
  noAdditionalBytesAfterSettlement: transport.bytes === bytesAtSettlement,
  sdkAbortSettled: modelEvents.some(
    (event) => event.type === "model.stopped" && event.success,
  ),
  cleanup: modelCleanup,
  sandboxId: handle.sandboxId,
  events: modelEvents,
};
console.info(
  JSON.stringify({ event: "G0_MODEL_ABORT_RESULT", ...modelEvidence }),
);

const commandWorkspace = new OpenSandboxWorkspace(config);
const commandHandle = await commandWorkspace.create({
  runId: `${runId}-command`,
  signal: new AbortController().signal,
});
let commandEvidence: Record<string, unknown> = {
  status: "FAIL",
  sandboxId: commandHandle.sandboxId,
};
try {
  const initialized = await commandWorkspace.executeService(
    commandHandle,
    "mkdir -p /workspace/app && chown 1000:1000 /workspace/app",
    { uid: 0 },
  );
  if (initialized.exitCode !== 0)
    throw new Error("Cannot prepare command directory");
  let childPid: number | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const source =
    'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("G0_CHILD_READY="+child.pid);setInterval(()=>{},1000);';
  const command = await commandWorkspace.exec(commandHandle, {
    command: `node -e ${shellQuote(source)}`,
    timeoutMs: 120_000,
    onOutput: (chunk) => {
      const match = chunk.match(/G0_CHILD_READY=(\d+)/);
      if (match) {
        childPid = Number(match[1]);
        resolveReady();
      }
    },
  });
  let settled = false;
  const wait = command.wait().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    ready,
    new Promise<never>((_, reject) => {
      readyTimer = setTimeout(
        () => reject(new Error("Long command never started")),
        20_000,
      );
    }),
  ]).finally(() => clearTimeout(readyTimer));
  const cancelledAt = new Date().toISOString();
  const cleanup = await command.cancel();
  await wait;
  commandEvidence = {
    status: childPid && settled && cleanup.confirmed ? "PASS" : "FAIL",
    sandboxId: commandHandle.sandboxId,
    commandId: command.id,
    childPid,
    cancelledAt,
    waitSettled: settled,
    exitCode: null,
    termination: "entire sandbox removal, confirmed by control-plane absence",
    cleanup,
  };
} catch {
  commandEvidence = {
    status: "FAIL",
    sandboxId: commandHandle.sandboxId,
    reason: "Long-command cancellation did not complete",
  };
} finally {
  commandEvidence = {
    ...commandEvidence,
    finalCleanup: await commandWorkspace.destroy(commandHandle),
  };
}

const lateWorkspace = new OpenSandboxWorkspace(config);
const lateController = new AbortController();
const lateStartedAt = new Date().toISOString();
const lateCreate = lateWorkspace.create({
  runId: `${runId}-late`,
  signal: lateController.signal,
});
const lateTimer = setTimeout(() => lateController.abort(), 30);
let lateCode = "UNEXPECTED_SUCCESS";
try {
  await lateCreate;
} catch (error) {
  lateCode = error instanceof RuntimeError ? error.code : "CREATE_FAILED";
} finally {
  clearTimeout(lateTimer);
}
const resources = lateWorkspace.resources();
const lateEvidence = {
  status:
    lateCode === "CANCELLED" &&
    resources.length === 1 &&
    resources.every((resource) => resource.state === "destroyed")
      ? "PASS"
      : "FAIL",
  startedAt: lateStartedAt,
  resultCode: lateCode,
  resources,
};
const result = {
  schemaVersion: 1,
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  versions: {
    hostNode: process.version,
    pi: "0.86.1",
    opensandboxSdk: "1.1.0",
    image: config.image,
  },
  modelAbort: modelEvidence,
  longCommandCancel: commandEvidence,
  lateCreateCancel: lateEvidence,
};
await writeFile(
  resolve(directory, `abort-${runId}.json`),
  JSON.stringify(result, null, 2),
  { mode: 0o600 },
);
console.info(
  JSON.stringify({
    event: "G0_ABORT_COMPLETE",
    runId,
    modelAbort: modelEvidence.status,
    longCommandCancel: commandEvidence.status,
    lateCreateCancel: lateEvidence.status,
  }),
);
if (
  [modelEvidence.status, commandEvidence.status, lateEvidence.status].some(
    (status) => status !== "PASS",
  )
)
  process.exitCode = 1;
