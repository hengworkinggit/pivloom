import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  async rewrites() {
    const origin = process.env.API_INTERNAL_ORIGIN ?? "http://127.0.0.1:4000";
    return [{ source: "/api/:path*", destination: `${origin.replace(/\/$/, "")}/api/:path*` }];
  },
};

export default config;
