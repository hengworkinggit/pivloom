import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateModelProfileSchema, UpdateModelProfileSchema,
  ModelProfileResponseSchema, ModelProfilesResponseSchema, ModelTestResultSchema, ModelCatalogSchema, ModelEndpointModelsSchema,
} from "@pivloom/contracts";
import { parseInput, requireOwner } from "./identity.js";
import type { ModelProfileService } from "../models/service.js";
import { listModelCatalog, listModelsForEndpoint } from "../runtime/pi.js";

// Endpoint model listings are cached briefly; the listing is stable within a
// credential version and a refresh costs a round trip to the provider.
const endpointModelsCache = new Map<string, {
  source: "catalog" | "endpoint" | "none";
  models: Array<{ id: string; name: string }>;
  expiresAt: number;
}>();
const ENDPOINT_MODELS_TTL_MS = 5 * 60_000;

export async function registerModelRoutes(app: FastifyInstance, options: {
  models: ModelProfileService;
  verifyIdentity: (request: FastifyRequest) => Promise<void>;
}) {
  await app.register(async (secured) => {
    secured.addHook("preHandler", options.verifyIdentity);
    secured.get("/api/v1/model-profiles", async (request) => ModelProfilesResponseSchema.parse({ profiles: await options.models.list(requireOwner(request)) }));
    // Mirrors how Pi itself offers model choice: the catalog supplies the
    // provider, protocol and default endpoint, so a BYOK profile only needs a key.
    secured.get("/api/v1/model-catalog", async () => ModelCatalogSchema.parse(await listModelCatalog()));
    // The models available on one saved credential's endpoint: Pi's catalog for
    // built-in providers, the endpoint's own OpenAI-compatible `/models` list
    // for custom endpoints, so the workbench shows a real dropdown.
    secured.get("/api/v1/model-profiles/:id/models", async (request) => {
      const { id } = parseInput(z.object({ id: z.uuid() }), request.params);
      const ownerId = requireOwner(request);
      const frozen = await options.models.listEndpointModels(ownerId, id);
      const cacheKey = `${id}:${frozen.configVersion}`;
      const cached = endpointModelsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return ModelEndpointModelsSchema.parse({ source: cached.source, models: cached.models });
      const result = await listModelsForEndpoint({ provider: frozen.provider, baseUrl: frozen.baseUrl, apiKey: frozen.apiKey, modelId: frozen.modelId });
      endpointModelsCache.set(cacheKey, { source: result.source, models: result.models, expiresAt: Date.now() + ENDPOINT_MODELS_TTL_MS });
      return ModelEndpointModelsSchema.parse(result);
    });
    secured.post("/api/v1/model-profiles", async (request, reply) => {
      const input = parseInput(CreateModelProfileSchema, request.body);
      return reply.code(201).send(ModelProfileResponseSchema.parse({ profile: await options.models.create(requireOwner(request), input) }));
    });
    secured.patch("/api/v1/model-profiles/:id", async (request) => {
      const { id } = parseInput(z.object({ id: z.uuid() }), request.params);
      const changes = parseInput(UpdateModelProfileSchema, request.body);
      return ModelProfileResponseSchema.parse({ profile: await options.models.update(requireOwner(request), id, changes) });
    });
    secured.delete("/api/v1/model-profiles/:id", async (request, reply) => {
      const { id } = parseInput(z.object({ id: z.uuid() }), request.params);
      await options.models.remove(requireOwner(request), id);
      return reply.code(204).send();
    });
    secured.post("/api/v1/model-profiles/test", async (request) => {
      const input = parseInput(CreateModelProfileSchema, request.body);
      return ModelTestResultSchema.parse(await options.models.testDraft(requireOwner(request), input));
    });
    secured.post("/api/v1/model-profiles/:id/test", async (request) => {
      const { id } = parseInput(z.object({ id: z.uuid() }), request.params);
      return ModelTestResultSchema.parse(await options.models.testSaved(requireOwner(request), id));
    });
  });
}
