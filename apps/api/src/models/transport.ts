import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ApiFailure } from "../routes/errors.js";

/**
 * A provider that closes an SSE stream mid-response is a transient transport
 * failure, not a client or configuration error. The trailing phrase is the
 * vocabulary the Pi retry policy uses to classify premature stream endings, so
 * a bounded retry is attempted instead of failing the whole run. The coupling is
 * asserted by a regression test against the installed SDK.
 */
export const MODEL_RESPONSE_INTERRUPTED_MESSAGE = "MODEL_RESPONSE_INTERRUPTED: stream ended before a terminal response event";

/**
 * A provider that accepts the request (HTTP 200) and then stops sending bytes
 * is stalling, not thinking: real reasoning content still arrives as deltas.
 * Without an idle watchdog such a stall burns the whole request budget before it
 * can be retried, so a stalled stream is cut early and classified as transient.
 */
export const MODEL_RESPONSE_STALLED_MESSAGE = "MODEL_RESPONSE_STALLED: stream timed out waiting for the next chunk";

/** Longest tolerated silence between two streamed chunks. */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 60_000;

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
const ipv6Public = new BlockList();
ipv6Public.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2001::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

export interface ModelNetwork {
  lookup(hostname: string): Promise<{ address: string; family: number }[]>;
  request(options: RequestOptions, response: (incoming: IncomingMessage) => void): ClientRequest;
}
const publicNetwork: ModelNetwork = {
  lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  request: httpsRequest,
};

function denied() {
  return new ApiFailure(422, "MODEL_ENDPOINT_NOT_ALLOWED", "模型地址必须是公开 HTTPS 服务，不能指向本机、私网或重定向地址。");
}
function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && ipv6Public.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
function endpoint(value: string, allowSdkQuery = false) {
  let url: URL;
  try { url = new URL(value); } catch { throw denied(); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const betaQuery = allowSdkQuery && url.pathname.endsWith("/messages")
    && url.searchParams.size === 1 && url.searchParams.get("beta") === "true";
  if (url.protocol !== "https:" || url.username || url.password || url.search && !betaQuery || url.hash
    || url.port && url.port !== "443" || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || isIP(hostname) && !publicAddress(hostname)) throw denied();
  return url;
}

async function resolvePublic(url: URL, network: ModelNetwork = publicNetwork) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  let timeout: NodeJS.Timeout | undefined;
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
        network.lookup(hostname),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("DNS_TIMEOUT")), 5_000);
        }),
      ]);
  } catch {
    throw new ApiFailure(422, "MODEL_ENDPOINT_UNREACHABLE", "无法解析模型服务地址，请检查 Base URL。");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw denied();
  return addresses.sort((a, b) => a.family - b.family)[0];
}

export async function validateModelEndpoint(value: string) {
  const url = endpoint(value);
  await resolvePublic(url);
  return url.toString().replace(/\/$/, "");
}

/** One DNS result is validated and pinned to the TLS connection; redirects never follow. */
export function createModelFetch(baseUrl: string, options: { timeoutMs?: number; stallTimeoutMs?: number; network?: ModelNetwork } = {}): typeof globalThis.fetch {
  const base = endpoint(baseUrl);
  const network = options.network ?? publicNetwork;
  const timeoutMs = Math.min(300_000, Math.max(1_000, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 90_000));
  // The idle watchdog must sit well below the request deadline and above any
  // plausible pause between streamed deltas.
  const stallTimeoutMs = Math.max(1, Math.min(options.stallTimeoutMs ?? Math.min(MODEL_STREAM_IDLE_TIMEOUT_MS, timeoutMs / 2), timeoutMs));
  return async (input, init) => {
    const request = new Request(input, init);
    const url = endpoint(request.url, true);
    const basePath = base.pathname.replace(/\/$/, "");
    if (url.origin !== base.origin || url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) throw denied();
    request.signal.throwIfAborted();
    const pinned = await resolvePublic(url, network);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body && body.byteLength > 16 * 1024 * 1024) throw new ApiFailure(413, "MODEL_INPUT_TOO_LARGE", "模型请求超过大小限制。");
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = url.host;
    headers["accept-encoding"] = "identity";
    if (body) headers["content-length"] = String(body.byteLength);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    return new Promise<Response>((resolve, reject) => {
      const outgoing = network.request({
        hostname: pinned.address, family: pinned.family,
        servername: url.hostname.replace(/^\[|\]$/g, ""), port: 443,
        path: url.pathname + url.search, method: request.method, headers, agent: false,
        signal,
      }, (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          incoming.destroy(); outgoing.destroy(); reject(denied()); return;
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const encoding = incoming.headers["content-encoding"];
        let stream: Readable = incoming;
        if (encoding === "gzip") stream = incoming.pipe(createGunzip());
        else if (encoding === "br") stream = incoming.pipe(createBrotliDecompress());
        else if (encoding === "deflate") stream = incoming.pipe(createInflate());
        if (encoding) { responseHeaders.delete("content-encoding"); responseHeaders.delete("content-length"); }
        const limited = Readable.from((async function* () {
          let bytes = 0;
          let stalled = false;
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          const rearm = () => {
            if (watchdog) clearTimeout(watchdog);
            watchdog = setTimeout(() => { stalled = true; incoming.destroy(); }, stallTimeoutMs);
            watchdog.unref?.();
          };
          rearm();
          try {
            for await (const chunk of stream) {
              rearm();
              bytes += Buffer.byteLength(chunk);
              if (bytes > 4 * 1024 * 1024) throw new Error("Model response exceeds the limit");
              yield chunk;
            }
          } catch (error) {
            if (deadline.aborted && signal.reason === deadline.reason) throw new Error("MODEL_REQUEST_TIMEOUT");
            // Our own idle watchdog, not the peer, decided this stream is dead.
            if (stalled && !signal.aborted) throw new Error(MODEL_RESPONSE_STALLED_MESSAGE);
            // Node reports a peer's premature HTTP close as `aborted` too. It is
            // a stream failure, not evidence that our request deadline expired.
            // The wording after the code keeps the Pi retry policy's transient
            // classifier in charge of whether this attempt is retried; see
            // MODEL_RESPONSE_INTERRUPTED_MESSAGE and its regression test.
            if (!signal.aborted && incoming.aborted) throw new Error(MODEL_RESPONSE_INTERRUPTED_MESSAGE);
            throw error;
          } finally { if (watchdog) clearTimeout(watchdog); stream.destroy(); incoming.destroy(); outgoing.destroy(); }
        })());
        const responseBody = Readable.toWeb(limited) as ReadableStream<Uint8Array>;
        resolve(new Response([204, 205, 304].includes(status) ? null : responseBody, { status, headers: responseHeaders }));
      });
      outgoing.on("error", reject);
      if (body) outgoing.write(body);
      outgoing.end();
    });
  };
}
