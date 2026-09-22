import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateModelProfileSchema, UpdateModelProfileSchema,
  ModelProfileResponseSchema, ModelProfilesResponseSchema, ModelTestResultSchema, ModelCatalogSchema,
} from "@pivloom/contracts";
import { parseInput, requireOwner } from "./identity.js";
import type { ModelProfileService } from "../models/service.js";
import { listModelCatalog } from "../runtime/pi.js";

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
