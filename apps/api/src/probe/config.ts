// The original maintenance HTTP stub is retained only to return an explicit
// retirement response. The tested OpenSandbox implementation is runtime/runProbe.
export const retiredProbeError = {
  code: "PROBE_RETIRED",
  message: "旧维护探针入口已停用，请使用当前 OpenSandbox 验证入口。",
} as const;

export const sandboxEnvironmentKeys = [
  "OPENSANDBOX_BASE_URL",
  "OPENSANDBOX_API_KEY",
  "OPENSANDBOX_IMAGE",
] as const;

export function sandboxConfiguration(env: NodeJS.ProcessEnv) {
  const missing = sandboxEnvironmentKeys.filter((key) => !env[key]?.trim());
  return {
    missing,
    config: missing.length
      ? undefined
      : {
          baseUrl: env.OPENSANDBOX_BASE_URL!.trim(),
          apiKey: env.OPENSANDBOX_API_KEY!.trim(),
          image: env.OPENSANDBOX_IMAGE!.trim(),
          lifetimeMs: 1_200_000,
        },
  };
}
