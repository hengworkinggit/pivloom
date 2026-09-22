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

export interface CreateAppOptions {
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? process.env;
  const configuration = readIdentityConfig(env);
  const bootId = randomUUID();
  const database = configuration.ready ? new PivloomDatabase(configuration.value.databaseUrl) : null;
  const verifier = configuration.ready ? createIdentityVerifier(configuration.value) : null;
  const app = Fastify({
    logger: options.logger ?? false,
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    bodyLimit: 32 * 1024,
  });
  app.decorateRequest("identity", null);
  if (database) app.addHook("onClose", async () => database.close());
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiFailure) {
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
      await registerIdentityRoutes(configured, { database, verifyIdentity: verifier.verify });
      if (env.MODEL_CREDENTIALS_ENCRYPTION_KEY) {
        const vault = createCredentialVault(env.MODEL_CREDENTIALS_ENCRYPTION_KEY);
        const models = createModelProfileService(database, vault);
        await registerModelRoutes(configured, { models, verifyIdentity: verifier.verify });
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
    });
  }

  return app;
}
