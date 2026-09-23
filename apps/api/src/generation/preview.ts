import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import Fastify from "fastify";
import type { Preview } from "@pivloom/contracts";

export interface PreviewRegistration {
  ownerId: string;
  projectId: string;
  revisionId: string;
  sandboxId: string;
  sourceHash: string;
  expiresAt: string;
  upstreamUrl: string;
  headers: Record<string, string>;
}
interface PreviewEntry extends PreviewRegistration { capability: string; revoked: boolean }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cookieName = "pivloom_preview";
function matches(left: string, right: string) {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/** A separate origin serves only registered immutable candidates. Platform bearer
 * tokens and sandbox control headers are never forwarded to each other. */
export function createPreviewGateway(options: { publicOrigin: string; appOrigin: string; sandboxOrigin: string }) {
  const publicOrigin = new URL(options.publicOrigin);
  const sandboxOrigin = new URL(options.sandboxOrigin).origin;
  const appOrigin = new URL(options.appOrigin).origin;
  const localPreview = publicOrigin.hostname === "localhost";
  if (isIP(publicOrigin.hostname.replace(/^\[|\]$/g, "")))
    throw new Error("Preview requires a DNS hostname; IP origins cannot isolate revisions");
  if (publicOrigin.origin === appOrigin) throw new Error("Preview requires an independent origin");
  // Production app and preview DNS must share a site. Do not guess public
  // suffixes here; deployment owns that DNS relationship and this scheme check.
  if (!localPreview && publicOrigin.protocol !== new URL(appOrigin).protocol)
    throw new Error("Preview and workbench require the same URL scheme");
  const entries = new Map<string, PreviewEntry>();
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  function revisionOrigin(revisionId: string) {
    const origin = new URL(publicOrigin);
    origin.hostname = `${revisionId}.${publicOrigin.hostname}`;
    return origin;
  }
  app.addHook("onRequest", async (request, reply) => {
    const revisionId = (request.params as { revisionId?: unknown } | null)?.revisionId;
    if (typeof revisionId !== "string" || !uuid.test(revisionId) || request.headers.host !== revisionOrigin(revisionId).host)
      return reply.code(403).send("预览来源无效。");
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; worker-src 'none'; frame-ancestors ${appOrigin}`);
  });
  app.setErrorHandler((_error, _request, reply) => reply.code(502).send("预览暂时不可用。"));

  function view(entry: PreviewEntry): Preview {
    const expired = entry.revoked || Date.parse(entry.expiresAt) <= Date.now();
    return {
      state: expired ? "expired" : "ready", revisionId: entry.revisionId, sourceHash: entry.sourceHash,
      url: expired ? null : `${revisionOrigin(entry.revisionId).origin}/p/${entry.revisionId}/enter/${entry.capability}`,
      expiresAt: entry.expiresAt, error: expired ? "预览已到期，源码仍已保存。" : null,
    };
  }
  function find(revisionId: string) { return uuid.test(revisionId) ? entries.get(revisionId) : undefined; }
  app.get<{ Params: { revisionId: string; capability: string } }>("/p/:revisionId/enter/:capability", async (request, reply) => {
    const entry = find(request.params.revisionId);
    if (!entry || !matches(request.params.capability, entry.capability)) return reply.code(404).send("找不到预览。");
    if (view(entry).state !== "ready") return reply.code(410).send("预览已到期，源码仍已保存。");
    const maxAge = Math.max(0, Math.floor((Date.parse(entry.expiresAt) - Date.now()) / 1000));
    reply.header("set-cookie", `${cookieName}=${entry.capability}; Path=/p/${entry.revisionId}/; HttpOnly; SameSite=${localPreview ? "None" : "Lax"}; Max-Age=${maxAge}${localPreview || publicOrigin.protocol === "https:" ? "; Secure" : ""}`);
    return reply.code(303).header("location", `/p/${entry.revisionId}/`).send();
  });
  app.route<{ Params: { revisionId: string; "*": string } }>({
    method: ["GET", "HEAD"], url: "/p/:revisionId/*",
    async handler(request, reply) {
      const entry = find(request.params.revisionId);
      if (!entry) return reply.code(404).send("找不到预览。");
      if (view(entry).state !== "ready") return reply.code(410).send("预览已到期，源码仍已保存。");
      const cookie = (request.headers.cookie ?? "").split(";").map((value) => value.trim()).find((value) => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? "";
      if (!matches(cookie, entry.capability)) return reply.code(403).send("请从工作台打开预览。");
      const tail = request.params["*"];
      if (tail.split("/").some((part) => part === ".." || part === "." || part.includes("\\") || part.includes("%") || /[\u0000-\u001f]/.test(part))) return reply.code(404).send("找不到资源。");
      const path = `/p/${entry.revisionId}/${tail.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetch(`${entry.upstreamUrl.replace(/\/$/, "")}${path}`, {
        method: request.method, headers: entry.headers, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return reply.code(response.status === 404 ? 404 : 502).send("预览资源不可用。");
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      reply.type(contentType);
      if (request.method === "HEAD") { await response.body?.cancel(); return reply.send(); }
      if (!response.body) return reply.send("");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); return reply.code(502).send("预览资源过大。"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      return reply.send(Buffer.concat(chunks));
    },
  });

  return {
    app,
    register(input: PreviewRegistration): Preview {
      const target = new URL(input.upstreamUrl);
      if (!uuid.test(input.revisionId) || !uuid.test(input.sandboxId) || !/^[a-f0-9]{64}$/.test(input.sourceHash) || !Number.isFinite(Date.parse(input.expiresAt)) || target.origin !== sandboxOrigin || target.pathname.replace(/\/$/, "") !== `/v1/sandboxes/${input.sandboxId}/proxy/4173` || target.search || target.hash || target.username || target.password) throw new Error("Invalid registered preview target");
      const old = entries.get(input.revisionId);
      if (old && !old.revoked && old.sandboxId !== input.sandboxId) old.revoked = true;
      const entry: PreviewEntry = { ...input, headers: { ...input.headers }, capability: randomBytes(32).toString("hex"), revoked: false };
      entries.set(input.revisionId, entry);
      return view(entry);
    },
    get(ownerId: string, revisionId: string): Preview | null {
      const entry = entries.get(revisionId);
      return entry?.ownerId === ownerId ? view(entry) : null;
    },
    revoke(revisionId: string, expectedSandboxId?: string) {
      const entry = entries.get(revisionId);
      if (entry && (expectedSandboxId === undefined || entry.sandboxId === expectedSandboxId)) entry.revoked = true;
    },
    async listen(address: { host: string; port: number }) { await app.listen(address); },
    async close() { await app.close(); entries.clear(); },
  };
}
export type PreviewGateway = ReturnType<typeof createPreviewGateway>;
