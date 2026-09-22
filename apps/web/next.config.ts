import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  async headers() {
    const previewOrigin = new URL(process.env.PREVIEW_BASE_URL ?? "http://localhost:45311").origin;
    return [{ source: "/:path*", headers: [
      { key: "Content-Security-Policy", value: `frame-src 'self' ${previewOrigin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` },
      { key: "Referrer-Policy", value: "no-referrer" },
    ] }];
  },
  async rewrites() {
    const origin = process.env.API_INTERNAL_ORIGIN ?? "http://127.0.0.1:4000";
    return [{ source: "/api/:path*", destination: `${origin.replace(/\/$/, "")}/api/:path*` }];
  },
};

export default config;
