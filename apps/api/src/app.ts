import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { readIdentityConfig } from "./config/identity.js";
import { createIdentityVerifier } from "./auth/supabase.js";
import { ApiFailure } from "./routes/errors.js";
import { PivloomDatabase } from "./data/database.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { createCredentialVault } from "./models/credentials.js";
import { createModelProfileService } from "./models/service.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerGenerationRoutes } from "./routes/generation.js";
import { createGenerationService, type GenerationService } from "./generation/service.js";
import type { SourceObjectStore } from "./storage/source.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Reconciles work left behind by a previous process. It is a boot step, not
     * a request step, so it never runs as a side effect of serving traffic.
     */
    recoverStaleRuns(): Promise<number>;
  }
}

export interface CreateAppOptions {
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
  previewListen?: { host: string; port: number };
  sourceObjects?: SourceObjectStore;
}

export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? process.env;
  const configuration = readIdentityConfig(env);
  const bootId = randomUUID();
  const recovering: { run?: () => Promise<number> } = {};
  const database = configuration.ready ? new PivloomDatabase(configuration.value.databaseUrl) : null;
  const verifier = configuration.ready ? createIdentityVerifier(configuration.value) : null;
  let generation: GenerationService | null = null;
  const app = Fastify({
    logger: options.logger ?? false,
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    bodyLimit: 32 * 1024,
  });
  app.decorateRequest("identity", null);
  app.decorate("recoverStaleRuns", async () => (recovering.run ? await recovering.run() : 0));
  app.addHook("onClose", async () => { await generation?.close(); await database?.close(); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiFailure) {
      if (error.code === "SERVICE_BUSY") reply.header("retry-after", "5");
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, retryable: error.retryable, requestId: request.id },
      });
    }
    const inputErrors = {
      400: { code: "INVALID_REQUEST", message: "请求格式不正确，请检查输入后重试。" },
      413: { code: "PAYLOAD_TOO_LARGE", message: "提交内容过大，请缩短后重试。" },
      415: { code: "UNSUPPORTED_MEDIA_TYPE", message: "请求需要使用 JSON 格式。" },
    } as const;
    const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
    if (status === 400 || status === 413 || status === 415) {
      return reply.code(status).send({ error: { ...inputErrors[status], retryable: false, requestId: request.id } });
    }
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。", retryable: true, requestId: request.id },
    });
  });
  app.get("/api/v1/health/live", async () => ({ status: "live", bootId }));
  app.get("/api/v1/health/ready", async (_request, reply) => {
    const checks = database && verifier ? await Promise.all([database.healthy(), verifier.healthy()]) : [false];
    const ready = checks.every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", bootId });
  });
  if (!configuration.ready) {
    app.all("/api/v1/*", async (request, reply) => reply.code(503).send({
      error: {
        code: "CONFIGURATION_MISSING",
        message: "服务尚未配置，请联系维护者。",
        retryable: false,
        requestId: request.id,
      },
    }));
  } else if (database && verifier) {
    app.register(async (configured) => {
      if (env.MODEL_CREDENTIALS_ENCRYPTION_KEY) {
        const vault = createCredentialVault(env.MODEL_CREDENTIALS_ENCRYPTION_KEY);
        const models = createModelProfileService(database, vault);
        await registerModelRoutes(configured, { models, verifyIdentity: verifier.verify });
        if (env.OPENSANDBOX_BASE_URL && env.OPENSANDBOX_API_KEY && env.OPENSANDBOX_IMAGE && env.PREVIEW_BASE_URL) {
          const maxSandboxes = Number(env.SANDBOX_MAX_ACTIVE ?? 2);
          if (!Number.isInteger(maxSandboxes) || maxSandboxes < 1 || maxSandboxes > 2) throw new Error("Invalid sandbox capacity");
          generation = createGenerationService({ database, models, identity: configuration.value, bootId,
            previewOrigin: env.PREVIEW_BASE_URL, maxSandboxes, sourceObjects: options.sourceObjects,
            sandbox: { baseUrl: env.OPENSANDBOX_BASE_URL, apiKey: env.OPENSANDBOX_API_KEY, image: env.OPENSANDBOX_IMAGE, lifetimeMs: 900_000 },
          });
          // Nothing left behind by a previous process may keep a project locked
          // or claim to be running; the server awaits this before it is used.
          const service = generation;
          recovering.run = () => service.recover();
          if (options.previewListen) {
            const service = generation;
            const address = options.previewListen;
            configured.addHook("onReady", async () => service.previews.listen(address));
          }
        }
      } else {
        await configured.register(async (secured) => {
          secured.addHook("preHandler", verifier.verify);
          const unavailable = () => {
            throw new ApiFailure(503, "MODEL_CONFIGURATION_MISSING", "模型凭据服务尚未配置，请联系维护者。", false);
          };
          secured.all("/api/v1/model-profiles", unavailable);
          secured.all("/api/v1/model-profiles/*", unavailable);
        });
      }
      const service = generation;
      await registerIdentityRoutes(configured, { database, verifyIdentity: verifier.verify,
        loadProjectDetail: service ? (ownerId, projectId) => service.projectDetail(ownerId, projectId) : undefined });
      await registerGenerationRoutes(configured, { generation, verifyIdentity: verifier.verify });
    });
  }

  return app;
}
