import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";

export interface PrivatePreviewTarget {
  sandboxId: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  capability: string;
}

export function createProbePreview(options: {
  port: number;
  pagePort: number;
  target: () => PrivatePreviewTarget | undefined;
}) {
  const app = Fastify({ logger: false });
  const hosts = new Set([
    `localhost:${options.port}`,
    `127.0.0.1:${options.port}`,
  ]);
  app.addHook("onRequest", async (request, reply) => {
    if (!hosts.has(request.headers.host ?? "")) return reply.code(403).send();
    if (!["GET", "HEAD"].includes(request.method))
      return reply.code(405).send();
    const origin = request.headers.origin;
    if (
      origin &&
      origin !== `http://${request.headers.host}` &&
      ![
        `http://localhost:${options.pagePort}`,
        `http://127.0.0.1:${options.pagePort}`,
      ].includes(origin)
    )
      return reply.code(403).send();
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
  });
  app.get("/enter/:capability", async (request, reply) => {
    const target = options.target();
    if (
      !target ||
      (request.params as { capability: string }).capability !==
        target.capability
    )
      return reply.code(404).send();
    return reply
      .header(
        "Set-Cookie",
        `g0-preview=${target.capability}; HttpOnly; SameSite=Strict; Path=/`,
      )
      .code(303)
      .header("Location", "/")
      .send();
  });
  const proxy = async (request: FastifyRequest, reply: FastifyReply) => {
    const target = options.target();
    if (!target)
      return reply.code(503).type("text/plain").send("预览尚未就绪或已清理。");
    const cookie = request.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("g0-preview="))
      ?.slice(11);
    if (cookie !== target.capability) return reply.code(403).send();
    try {
      const incoming = new URL(request.url, "http://preview.invalid");
      const decoded = decodeURIComponent(request.url.split("?")[0]);
      if (
        decoded.includes("..") ||
        decoded.includes("\\") ||
        decoded.includes("\0")
      )
        return reply.code(400).send();
      const upstream = new URL(target.upstreamUrl);
      upstream.pathname =
        upstream.pathname.replace(/\/$/, "") + incoming.pathname;
      upstream.search = incoming.search;
      const response = await fetch(upstream, {
        method: request.method,
        headers: target.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status >= 300 && response.status < 400)
        return reply.code(502).send();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      try {
        for (;;) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 16 * 1024 * 1024) throw new Error("Preview exceeds limit");
          chunks.push(chunk.value);
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      return reply
        .code(response.status)
        .header(
          "Content-Type",
          response.headers.get("content-type") ?? "application/octet-stream",
        )
        .header(
          "Content-Security-Policy",
          `default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors http://localhost:${options.pagePort} http://127.0.0.1:${options.pagePort}; base-uri 'none'; object-src 'none'; form-action 'none'`,
        )
        .send(Buffer.concat(chunks));
    } catch {
      return reply.code(502).type("text/plain").send("预览连接不可用。");
    }
  };
  app.get("/", proxy);
  app.get("/*", proxy);
  return app;
}
