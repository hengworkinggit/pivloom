import type { NextConfig } from "next";

const config: NextConfig = {
  // A standalone server keeps the deployed release self-contained instead of
  // shipping the whole monorepo node_modules to the host.
  output: "standalone",
  devIndicators: false,
  poweredByHeader: false,
  async headers() {
    const previewBase = new URL(process.env.PREVIEW_BASE_URL ?? "http://localhost:45311");
    // Each revision uses its own host; keep the configured scheme and port.
    const previewOrigins = `${previewBase.protocol}//*.${previewBase.host}`;
    return [{ source: "/:path*", headers: [
      { key: "Content-Security-Policy", value: `frame-src 'self' ${previewOrigins}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` },
      { key: "Referrer-Policy", value: "no-referrer" },
    ] }];
  },
  async rewrites() {
    const origin = process.env.API_INTERNAL_ORIGIN ?? "http://127.0.0.1:4000";
    // Identity lives on the same public origin as the app, so the browser never
    // needs a second hostname and the session cookie stays first-party.
    const identity = process.env.SUPABASE_INTERNAL_ORIGIN ?? "http://127.0.0.1:54321";
    return [
      { source: "/api/:path*", destination: `${origin.replace(/\/$/, "")}/api/:path*` },
      { source: "/auth/v1/:path*", destination: `${identity.replace(/\/$/, "")}/auth/v1/:path*` },
      { source: "/rest/v1/:path*", destination: `${identity.replace(/\/$/, "")}/rest/v1/:path*` },
      { source: "/storage/v1/:path*", destination: `${identity.replace(/\/$/, "")}/storage/v1/:path*` },
    ];
  },
};

export default config;
