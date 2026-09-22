import Fastify from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { retiredProbeError, sandboxConfiguration } from "./config.js";
import { probePage } from "./page.js";
import { createModelFetch } from "../models/transport.js";
import { runProbe, destroyProbePreview } from "../runtime/probe.js";
import { sandboxConnectionConfig } from "../runtime/workspace.js";
import type { ProbeEvent, ProbeResult, ModelConfig } from "../runtime/types.js";
import { createProbePreview, type PrivatePreviewTarget } from "./preview.js";

const RunInput = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    model: z
      .object({
        provider: z.string().trim().min(1).max(80),
        api: z.enum(["openai-completions", "anthropic-messages"]),
        baseUrl: z.string().url().max(2048),
        id: z.string().trim().min(1).max(160),
        apiKey: z.string().trim().min(1).max(4096),
        maxTokens: z.number().int().min(1024).max(8192).default(4096),
      })
      .strict(),
  })
  .strict();
interface MaintenanceRun {
  id: string;
  status: "running" | "cancelling" | "cleaned" | ProbeResult["status"];
  message: string;
  events: ProbeEvent[];
  controller: AbortController;
  promise?: Promise<void>;
  result?: ProbeResult;
  cleanupPromise?: Promise<void>;
}

export async function createProbeApp(options: {
  port: number;
  previewPort?: number;
  env: NodeJS.ProcessEnv;
  onResult?: (
    result: ProbeResult,
    metadata: { bootId: string; maintenanceRunId: string },
  ) => Promise<void>;
}) {
  const previewPort = options.previewPort ?? 45311;
  if (
    ![options.port, previewPort].every(
      (port) => Number.isInteger(port) && port > 0 && port < 65536,
    ) ||
    options.port === previewPort
  )
    throw new Error("G0 requires two distinct loopback ports");
  const app = Fastify({ logger: false, bodyLimit: 32_768 });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    return reply
      .code(
        status === 413
          ? 413
          : status === 415
            ? 415
            : status === 400
              ? 400
              : 500,
      )
      .send({
        error: {
          code:
            status === 400 || status === 413 || status === 415
              ? "INVALID_REQUEST"
              : "INTERNAL_ERROR",
          message: "维护请求未完成，请检查输入或服务连接。",
        },
      });
  });
  const bootId = randomUUID();
  const csrfToken = randomBytes(32).toString("hex");
  const runs = new Map<string, MaintenanceRun>();
  let current: MaintenanceRun | undefined;
  let previewTarget: PrivatePreviewTarget | undefined;
  const preview = createProbePreview({
    port: previewPort,
    pagePort: options.port,
    target: () => previewTarget,
  });
  const configuration = sandboxConfiguration(options.env);
  const publicRun = (run: MaintenanceRun) => {
    const screenshot = run.result?.evidence.screenshot;
    return {
      id: run.id,
      bootId,
      status: run.status,
      message: run.message,
      events: run.events,
      result: run.result
        ? {
            ...run.result,
            events: undefined,
            evidence: {
              ...run.result.evidence,
              screenshot: screenshot
                ? { mimeType: screenshot.mimeType, sha256: screenshot.sha256 }
                : undefined,
            },
          }
        : undefined,
    };
  };
  const persist = async (run: MaintenanceRun) => {
    if (run.result)
      await options.onResult?.(run.result, {
        bootId,
        maintenanceRunId: run.id,
      });
  };
  const cleanup = async (run: MaintenanceRun) => {
    if (run.cleanupPromise) return run.cleanupPromise;
    run.cleanupPromise = (async () => {
      run.controller.abort();
      await run.promise;
      const id = run.result?.cleanup.sandboxId;
      if (
        id &&
        run.result &&
        run.result.cleanup.state !== "confirmed" &&
        configuration.config
      ) {
        const destroyed = await destroyProbePreview(configuration.config, id);
        run.result.cleanup = {
          state: destroyed.confirmed ? "confirmed" : "pending",
          sandboxId: id,
        };
        if (!destroyed.confirmed) {
          run.status = "cleanup_pending";
          run.message = "沙箱清理待确认，请重试清理。";
          await persist(run);
          return;
        }
      }
      if (id && previewTarget?.sandboxId === id) previewTarget = undefined;
      run.status = "cleaned";
      run.message = "本次沙箱已确认清理。";
      await persist(run);
    })().finally(() => {
      run.cleanupPromise = undefined;
    });
    return run.cleanupPromise;
  };
  const hosts = new Set([
    `localhost:${options.port}`,
    `127.0.0.1:${options.port}`,
  ]);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!hosts.has(request.headers.host ?? "")) {
      return reply
        .code(403)
        .send({ error: { code: "LOCAL_ONLY", message: "仅限本机维护入口。" } });
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== `http://${request.headers.host}`
    ) {
      return reply
        .code(403)
        .send({
          error: { code: "ORIGIN_REJECTED", message: "请从本机探针页面操作。" },
        });
    }
    const path = new URL(request.url, "http://localhost").pathname;
    if (
      path !== "/" &&
      path !== "/probe" &&
      request.headers["x-g0-csrf"] !== csrfToken
    ) {
      return reply
        .code(403)
        .send({
          error: { code: "CSRF_REJECTED", message: "请刷新维护页面后重试。" },
        });
    }
  });
  app.get("/", async (_request, reply) => {
    const nonce = randomBytes(18).toString("base64");
    return reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; frame-src http://localhost:${previewPort} http://127.0.0.1:${previewPort}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      )
      .type("text/html;charset=utf-8")
      .send(probePage(csrfToken, nonce));
  });
  app.post("/probe", async (_request, reply) => {
    return reply.code(410).send({ error: retiredProbeError });
  });
  app.post("/runs", async (request, reply) => {
    if (!configuration.config)
      return reply
        .code(503)
        .send({
          error: {
            code: "CONFIGURATION_MISSING",
            message: "请准备沙箱连接配置。",
          },
          missing: configuration.missing,
        });
    if (
      current &&
      (["running", "cancelling", "ready", "cleanup_pending"].includes(
        current.status,
      ) ||
        ["retained_until_expiry", "pending"].includes(
          current.result?.cleanup.state ?? "",
        ))
    )
      return reply
        .code(409)
        .send({
          error: {
            code: "CLEANUP_REQUIRED",
            message: "请先完成或清理当前沙箱，再开始下一次验证。",
          },
        });
    const input = RunInput.safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({
          error: {
            code: "INVALID_INPUT",
            message: "请检查需求、模型协议、地址和本次 Key。",
          },
        });
    let modelConfig: ModelConfig;
    try {
      modelConfig = {
        ...input.data.model,
        fetch: createModelFetch(input.data.model.baseUrl),
      };
      sandboxConnectionConfig(configuration.config);
    } catch {
      return reply
        .code(400)
        .send({
          error: {
            code: "INVALID_CONFIGURATION",
            message:
              "模型地址须为可用的公网 HTTPS 地址，沙箱管理地址须为受控 origin。",
          },
        });
    }
    input.data.model.apiKey = "";
    const run: MaintenanceRun = {
      id: randomUUID(),
      status: "running",
      message: "任务已接受，正在创建沙箱。",
      events: [],
      controller: new AbortController(),
    };
    current = run;
    runs.set(run.id, run);
    if (runs.size > 8) runs.delete(runs.keys().next().value!);
    const previewHost = request.headers.host!.startsWith("localhost:")
      ? "localhost"
      : "127.0.0.1";
    run.promise = (async () => {
      try {
        run.result = await runProbe({
          prompt: input.data.prompt,
          modelConfig,
          sandboxConfig: configuration.config!,
          signal: run.controller.signal,
          onEvent: (event) => {
            run.events.push(event);
            run.message = event.message;
          },
          publishPreview: async (binding) => {
            const url = new URL(binding.upstreamUrl);
            if (
              url.origin !== new URL(configuration.config!.baseUrl).origin ||
              url.pathname !==
                `/v1/sandboxes/${binding.sandboxId}/proxy/4173` ||
              url.search ||
              url.username ||
              url.password
            )
              throw new Error("Unexpected preview endpoint");
            const capability = randomBytes(24).toString("hex");
            previewTarget = {
              sandboxId: binding.sandboxId,
              upstreamUrl: binding.upstreamUrl,
              headers: binding.headers,
              capability,
            };
            return `http://${previewHost}:${previewPort}/enter/${capability}`;
          },
        });
        run.status = run.result.status;
        run.message =
          run.status === "ready"
            ? "真实生成、构建与 Chrome 检查通过，请操作下方应用。"
            : run.status === "cancelled"
              ? "任务已取消；请核对下方沙箱清理状态。"
              : "本次验证未通过，请查看阶段与错误。";
        if (run.status !== "ready") previewTarget = undefined;
        await persist(run);
      } catch {
        run.status = run.result?.cleanup.sandboxId
          ? "cleanup_pending"
          : "failed";
        run.message = "验证或证据保存未完成，请检查维护者记录并清理沙箱。";
      } finally {
        modelConfig.apiKey = "";
      }
    })();
    return reply.code(202).send({ id: run.id, bootId });
  });
  app.get("/runs/current", async (_request, reply) =>
    current
      ? publicRun(current)
      : reply
          .code(404)
          .send({ error: { code: "NO_RUN", message: "尚无维护任务。" } }),
  );
  app.get("/runs/:id", async (request, reply) => {
    const run = runs.get((request.params as { id: string }).id);
    return run
      ? publicRun(run)
      : reply
          .code(404)
          .send({ error: { code: "RUN_NOT_FOUND", message: "任务不存在。" } });
  });
  app.post("/runs/:id/cancel", async (request, reply) => {
    const run = runs.get((request.params as { id: string }).id);
    if (!run)
      return reply
        .code(404)
        .send({ error: { code: "RUN_NOT_FOUND", message: "任务不存在。" } });
    if (run.status === "running") {
      run.status = "cancelling";
      run.message = "正在停止 Pi 与沙箱，请等待结束确认。";
      run.controller.abort();
    }
    return reply
      .code(run.status === "cancelling" ? 202 : 200)
      .send(publicRun(run));
  });
  app.delete("/runs/:id", async (request, reply) => {
    const run = runs.get((request.params as { id: string }).id);
    if (!run)
      return reply
        .code(404)
        .send({ error: { code: "RUN_NOT_FOUND", message: "任务不存在。" } });
    await cleanup(run);
    return publicRun(run);
  });
  app.addHook("onClose", async () => {
    for (const run of runs.values()) await cleanup(run).catch(() => {});
    await preview.close();
  });
  return { app, preview, bootId, close: () => app.close() };
}
