import { createClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import type { MeResponse } from "@pivloom/contracts";
import type { IdentityConfig } from "../config/identity.js";
import { ApiFailure, unauthenticated } from "../routes/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    identity: MeResponse["user"] | null;
    /** Extracted only after Auth verifies the token; private Preview checks it
     * against auth.sessions before issuing or serving a resource grant. */
    identitySessionId: string | null;
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
      let sessionId: string | null = null;
      try {
        const claims: unknown = JSON.parse(Buffer.from(header.slice(7).split(".")[1] ?? "", "base64url").toString());
        if (claims && typeof claims === "object" && "sub" in claims && claims.sub === data.user.id
          && "session_id" in claims && typeof claims.session_id === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.session_id))
          sessionId = claims.session_id;
      } catch { /* Other authenticated routes may still accept an opaque Auth token. */ }
      const displayName = data.user.user_metadata?.display_name ?? data.user.user_metadata?.name;
      request.identitySessionId = sessionId;
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
