import { z } from "zod";

export const ModelProtocolSchema = z.enum(["openai-completions", "anthropic-messages"]);
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>;
export const ModelCapabilitiesSchema = z.object({
  streaming: z.enum(["verified", "unknown"]),
  tools: z.enum(["verified", "unknown"]),
  vision: z.literal("unknown"),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
export const ModelTestResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  message: z.string(),
  capabilities: ModelCapabilitiesSchema,
  testedAt: z.iso.datetime(),
});
export type ModelTestResult = z.infer<typeof ModelTestResultSchema>;

const apiKey = z.string().trim().min(8).max(4096).refine(
  (value) => !/[•●*]/.test(value) && !/[\r\n\0]/.test(value),
  "请输入完整密钥，不要提交掩码。",
);
export const CreateModelProfileSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  provider: ModelProtocolSchema,
  baseUrl: z.url().max(2048),
  modelId: z.string().trim().min(1).max(160),
  apiKey,
  isDefault: z.boolean().optional(),
});
export type CreateModelProfile = z.infer<typeof CreateModelProfileSchema>;
export const UpdateModelProfileSchema = CreateModelProfileSchema.partial().refine(
  (value) => Object.keys(value).length > 0, "至少修改一项配置。",
);
export type UpdateModelProfile = z.infer<typeof UpdateModelProfileSchema>;
export const ModelProfileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: ModelProtocolSchema,
  baseUrl: z.url(),
  modelId: z.string(),
  configVersion: z.number().int().positive(),
  keyMask: z.string(),
  isDefault: z.boolean(),
  capabilities: ModelCapabilitiesSchema,
  lastTest: ModelTestResultSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export const ModelProfileResponseSchema = z.object({ profile: ModelProfileSchema });
export const ModelProfilesResponseSchema = z.object({ profiles: z.array(ModelProfileSchema) });
