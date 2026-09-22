import { createServer, request as httpRequest, type IncomingMessage, type RequestListener } from "node:http";
import type { RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { createModelFetch } from "../../src/models/transport.js";

// This is an isolated external-network seam fixture. Production HTTPS pinning remains enabled;
// only the injected socket adapter maps an already validated target to a local HTTP server.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  const targets: RequestOptions[] = [];
  return {
    targets,
    request: (options: RequestOptions, listener: (incoming: IncomingMessage) => void) => {
      targets.push(options);
      return httpRequest({ ...options, hostname: "127.0.0.1", port, agent: false }, listener);
    },
  };
}

test("DNS rebinding cannot replace the validated IP used by the actual connection", async () => {
  const upstream = await fixture((_request, response) => response.end("fixture-ok"));
  let resolutions = 0;
  const transport = createModelFetch("https://model-fixture.invalid/v1", { network: {
    lookup: async () => [{ address: ++resolutions === 1 ? "93.184.215.14" : "127.0.0.1", family: 4 }],
    request: upstream.request,
  } });
  const response = await transport("https://model-fixture.invalid/v1/chat/completions", { method: "POST", body: "{}" });
  expect(await response.text()).toBe("fixture-ok");
  expect(resolutions).toBe(1);
  expect(upstream.targets).toHaveLength(1);
  expect(upstream.targets[0]).toMatchObject({
    hostname: "93.184.215.14", family: 4, servername: "model-fixture.invalid", port: 443,
    path: "/v1/chat/completions", agent: false, headers: { host: "model-fixture.invalid" },
  });
  await expect(transport("https://model-fixture.invalid/v1/chat/completions")).rejects.toMatchObject({ code: "MODEL_ENDPOINT_NOT_ALLOWED" });
  expect(resolutions).toBe(2);
  expect(upstream.targets).toHaveLength(1);
});

test("a mixed public/private DNS answer is rejected before opening any connection", async () => {
  const upstream = await fixture((_request, response) => response.end("must-not-connect"));
  const transport = createModelFetch("https://model-fixture.invalid/v1", { network: {
    lookup: async () => [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.8", family: 4 }],
    request: upstream.request,
  } });
  await expect(transport("https://model-fixture.invalid/v1/chat/completions")).rejects.toMatchObject({ code: "MODEL_ENDPOINT_NOT_ALLOWED" });
  expect(upstream.targets).toHaveLength(0);
});

test("an upstream redirect to a private target is refused without a second request", async () => {
  let requests = 0;
  const upstream = await fixture((_request, response) => {
    requests++;
    response.writeHead(302, { location: "https://127.0.0.1/private" });
    response.end();
  });
  const transport = createModelFetch("https://model-fixture.invalid/v1", { network: {
    lookup: async () => [{ address: "93.184.215.14", family: 4 }], request: upstream.request,
  } });
  await expect(transport("https://model-fixture.invalid/v1/chat/completions", {
    headers: { authorization: "Bearer fixture-never-real" },
  })).rejects.toMatchObject({ code: "MODEL_ENDPOINT_NOT_ALLOWED" });
  expect(requests).toBe(1);
  expect(upstream.targets).toHaveLength(1);
});

test("a non-responsive upstream is aborted within the configured deadline and its socket closes", async () => {
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const upstream = await fixture((request) => request.socket.once("close", markClosed));
  const transport = createModelFetch("https://model-fixture.invalid/v1", { timeoutMs: 1_000, network: {
    lookup: async () => [{ address: "93.184.215.14", family: 4 }], request: upstream.request,
  } });
  const start = Date.now();
  await expect(transport("https://model-fixture.invalid/v1/chat/completions")).rejects.toMatchObject({ name: "AbortError" });
  await closed;
  expect(Date.now() - start).toBeLessThan(3_000);
  expect(upstream.targets).toHaveLength(1);
}, 4_000);

test("the permitted Anthropic SDK query reaches only the configured messages endpoint", async () => {
  let requestedPath: string | undefined;
  const upstream = await fixture((request, response) => {
    requestedPath = request.url;
    response.end("fixture-query-ok");
  });
  const transport = createModelFetch("https://model-fixture.invalid/v1", { network: {
    lookup: async () => [{ address: "93.184.215.14", family: 4 }], request: upstream.request,
  } });
  const result = await transport("https://model-fixture.invalid/v1/messages?beta=true", { method: "POST", body: "{}" });
  expect(await result.text()).toBe("fixture-query-ok");
  expect(requestedPath).toBe("/v1/messages?beta=true");
  expect(upstream.targets).toHaveLength(1);
});
