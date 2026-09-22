// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import config from "../../next.config";

afterEach(() => vi.unstubAllEnvs());

test.each([
  [undefined, "http://*.localhost:45311"],
  ["https://preview.example.com:8443", "https://*.preview.example.com:8443"],
  ["https://preview.example.com", "https://*.preview.example.com"],
])("workbench response permits revision preview subdomains for %s", async (previewBase, allowedSource) => {
  vi.stubEnv("PREVIEW_BASE_URL", previewBase);
  const response = await unstable_getResponseFromNextConfig({
    url: "http://localhost:45231/projects/11111111-1111-4111-8111-111111111111",
    nextConfig: config,
  });

  expect(response.headers.get("content-security-policy")).toBe(
    `frame-src 'self' ${allowedSource}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});
