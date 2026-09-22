import type { NextConfig } from "next";

const config: NextConfig = {
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
    return [{ source: "/api/:path*", destination: `${origin.replace(/\/$/, "")}/api/:path*` }];
  },
};

export default config;
