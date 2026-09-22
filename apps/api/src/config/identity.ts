export interface IdentityConfig {
  appOrigin: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  databaseUrl: string;
}

export type IdentityConfiguration =
  | { ready: true; value: IdentityConfig }
  | { ready: false; missing: string[] };

export function readIdentityConfig(env: NodeJS.ProcessEnv): IdentityConfiguration {
  const required = ["APP_ORIGIN", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "DATABASE_URL"] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) return { ready: false, missing };
  try {
    const appOrigin = new URL(env.APP_ORIGIN!);
    const supabaseUrl = new URL(env.SUPABASE_URL!);
    const databaseUrl = new URL(env.DATABASE_URL!);
    if (!/^https?:$/.test(appOrigin.protocol) || !/^https?:$/.test(supabaseUrl.protocol)
      || !/^postgres(?:ql)?:$/.test(databaseUrl.protocol)
      || appOrigin.username || appOrigin.password || supabaseUrl.username || supabaseUrl.password) {
      return { ready: false, missing: ["VALID_IDENTITY_CONFIGURATION"] };
    }
    return {
      ready: true,
      value: {
        appOrigin: appOrigin.origin,
        supabaseUrl: supabaseUrl.origin,
        supabaseSecretKey: env.SUPABASE_SECRET_KEY!.trim(),
        databaseUrl: env.DATABASE_URL!.trim(),
      },
    };
  } catch {
    return { ready: false, missing: ["VALID_IDENTITY_CONFIGURATION"] };
  }
}
