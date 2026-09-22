import { createClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import type { MeResponse } from "@pivloom/contracts";
import type { IdentityConfig } from "../config/identity.js";
import { ApiFailure, unauthenticated } from "../routes/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    identity: MeResponse["user"] | null;
  }
}

export function createIdentityVerifier(config: IdentityConfig) {
  const client = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      }),
    },
  });

  return {
    async verify(request: FastifyRequest) {
      const header = request.headers.authorization;
      if (!header || header.length > 16_384 || !/^Bearer [A-Za-z0-9._-]+$/.test(header)) {
        throw unauthenticated();
      }
      // getUser validates with Auth; decoding a JWT is never an authentication step.
      const { data, error } = await client.auth.getUser(header.slice(7));
      if (error) {
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
          throw unauthenticated();
        }
        throw new ApiFailure(503, "AUTH_UNAVAILABLE", "身份服务暂时不可用，请稍后重试。", true);
      }
      if (!data.user?.id || !data.user.email) throw unauthenticated();
      const displayName = data.user.user_metadata?.display_name ?? data.user.user_metadata?.name;
      request.identity = {
        id: data.user.id,
        email: data.user.email,
        name: typeof displayName === "string" && displayName.trim()
          ? displayName.trim().slice(0, 120)
          : data.user.email.split("@")[0],
      };
    },
    async healthy() {
      try {
        const response = await fetch(`${config.supabaseUrl}/auth/v1/settings`, {
          headers: { apikey: config.supabaseSecretKey },
          signal: AbortSignal.timeout(5_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
