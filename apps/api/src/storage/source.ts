import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import type { SourceFileInfo } from "@pivloom/contracts";
import { z } from "zod";
import { ApiFailure } from "../routes/errors.js";

export interface SourceInputFile { path: string; content: Uint8Array | string; sha256?: string; kind?: "file" | "symlink" | "directory" }
export interface SourceScope { ownerId: string; projectId: string; revisionId: string }
export interface SourceReference extends SourceScope {
  key: string; sourceHash: string; templateVersion: string; manifest: SourceFileInfo[];
  sourceBytes: number; compressedBytes: number;
}
declare const verifiedSource: unique symbol;
export type VerifiedSourceSnapshot = SourceReference & { readonly [verifiedSource]: true };
export interface SourceBundle {
  schemaVersion: 1; templateVersion: string;
  files: { path: string; encoding: "utf8"; content: string; sha256: string }[];
  manifest: SourceFileInfo[];
}
export interface SourceObject { key: string; revisionId: string; sourceHash: string; createdAt: string; bytes: number }
export interface SourceObjectStore {
  upload(key: string, body: Uint8Array): Promise<void>;
  download(key: string): Promise<Uint8Array>;
  list(prefix: string): Promise<SourceObject[]>;
}
export interface SourceStore {
  save(scope: SourceScope, templateVersion: string, files: SourceInputFile[]): Promise<VerifiedSourceSnapshot>;
  load(reference: SourceReference): Promise<SourceBundle>;
  verify(reference: SourceReference): Promise<VerifiedSourceSnapshot>;
  listObjects(ownerId: string, projectId: string): Promise<SourceObject[]>;
}

const verified = new WeakSet<object>();
const sourceFailure = (code = "SNAPSHOT_SAVE_FAILED", message = "源码快照保存失败，请稍后重试。") => new ApiFailure(503, code, message, true);
const rejectionMessages = {
  PATH_FORMAT: "源码路径为空、过长或含不支持的字符及目录段",
  PATH_FORBIDDEN: "源码路径属于敏感配置或排除目录",
  FILE_EXTENSION: "源码文件扩展名不受支持",
  SCOPE: "源码对象归属标识无效",
  REFERENCE_HASH: "源码对象摘要标识无效",
  REFERENCE_KEY: "源码对象路径与归属或摘要不匹配",
  TEMPLATE_VERSION: "模板版本为空或过长",
  FILE_COUNT: "源码文件数量不在 1 到 200 之间",
  FILE_KIND: "源码包含非普通文件",
  DUPLICATE_PATH: "源码路径重复",
  FILE_SIZE: "单个源码文件超过 512 KiB",
  UTF8: "源码不是有效的 UTF-8 文本",
  TEXT_ENCODING: "源码文本无法无损转换为 UTF-8",
  CONTROL_CHARACTER: "源码文本包含不支持的控制字符",
  FILE_HASH: "源码摘要与实际字节不符",
  TOTAL_SIZE: "源码总字节数为空或超过 5 MiB",
} as const;
/**
 * Static rejection detail. A source path is already part of the run's public
 * activity ("已读取 src/App.tsx"), so naming the offending path is diagnostic
 * without disclosing file contents, credentials or sandbox internals.
 */
const invalidSource = (reason: keyof typeof rejectionMessages, path?: string) =>
  new ApiFailure(422, "INVALID_SOURCE",
    `源码快照校验失败 [${reason}${path ? `:${path}` : ""}]：${rejectionMessages[reason]}。`);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const forbidden = new Set(["node_modules", "dist", "build", ".git", ".cache", ".next", ".npmrc", ".netrc", ".ssh", "coverage"]);
// A generated frontend legitimately ships static assets (icons, images, fonts,
// web app manifest) next to its source, so the allowlist covers those types as
// well as code. Extensionless tooling files stay explicitly listed.
const allowedExtension = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|json|css|scss|sass|less|html?|svg|txt|md|ya?ml|lock|xml|webmanifest|ico|png|jpe?g|gif|webp|avif|bmp|woff2?|ttf|otf|eot)$/i;

function checkedPath(path: string) {
  const segments = path.split("/");
  if (!path || path.length > 240 || /[\\\x00-\x1f\x7f]/.test(path)
    || segments.some((part) => !part || part === "." || part === "..")) throw invalidSource("PATH_FORMAT");
  if (segments.some((part) => forbidden.has(part.toLowerCase()) || part.toLowerCase().startsWith(".env"))) throw invalidSource("PATH_FORBIDDEN");
  if (!allowedExtension.test(path) && ![".gitignore", "LICENSE", "Makefile"].includes(path))
    // Only the extension leaves this boundary: it is bounded vocabulary from a
    // strict pattern, while a model-authored file name could carry anything.
    throw invalidSource("FILE_EXTENSION", /(\.[a-z0-9]{1,12})$/i.exec(path)?.[1] ?? "(no extension)");
  return path;
}
function checkedScope(scope: SourceScope) {
  if (![scope.ownerId, scope.projectId, scope.revisionId].every((value) => z.uuid().safeParse(value).success)) throw invalidSource("SCOPE");
}
function sourceKey(scope: SourceScope, sourceHash: string) {
  checkedScope(scope);
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw invalidSource("REFERENCE_HASH");
  return `${scope.ownerId}/${scope.projectId}/${scope.revisionId}/${sourceHash}.json.gz`;
}

/** Stable bytes used by the revision marker and storage; timestamps and gzip headers do not enter sourceHash. */
export function prepareSourceSnapshot(templateVersion: string, input: SourceInputFile[]) {
  if (!templateVersion || templateVersion.length > 120) throw invalidSource("TEMPLATE_VERSION");
  if (!input.length || input.length > 200) throw invalidSource("FILE_COUNT");
  let sourceBytes = 0;
  const seen = new Set<string>();
  const files = input.map((file) => {
    if (file.kind && file.kind !== "file") throw invalidSource("FILE_KIND");
    const path = checkedPath(file.path);
    if (seen.has(path)) throw invalidSource("DUPLICATE_PATH");
    seen.add(path);
    const bytes = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : Buffer.from(file.content);
    if (bytes.byteLength > 512 * 1024) throw invalidSource("FILE_SIZE");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw invalidSource("UTF8"); }
    if (typeof file.content === "string" && content !== file.content) throw invalidSource("TEXT_ENCODING");
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw invalidSource("CONTROL_CHARACTER");
    const sha256 = hash(bytes);
    if (file.sha256 && file.sha256 !== sha256) throw invalidSource("FILE_HASH");
    sourceBytes += bytes.byteLength;
    return { path, encoding: "utf8" as const, content, sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (sourceBytes < 1 || sourceBytes > 5 * 1024 * 1024) throw invalidSource("TOTAL_SIZE");
  const canonical = { schemaVersion: 1 as const, templateVersion, files };
  const sourceHash = hash(JSON.stringify(canonical));
  const manifest = files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8"), sha256: file.sha256 }));
  const bundle: SourceBundle = { ...canonical, manifest };
  const compressed = gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
  return { bundle, manifest, sourceHash, sourceBytes, compressed };
}

function checkedReference(reference: SourceReference) {
  if (reference.key !== sourceKey(reference, reference.sourceHash)) throw invalidSource("REFERENCE_KEY");
}
function verifiedReference(reference: SourceReference): VerifiedSourceSnapshot {
  const result = Object.freeze({ ...reference,
    manifest: Object.freeze(reference.manifest.map((item) => Object.freeze({ ...item }))) as unknown as SourceFileInfo[],
  }) as VerifiedSourceSnapshot;
  verified.add(result);
  return result;
}
export function assertVerifiedSourceSnapshot(reference: VerifiedSourceSnapshot) {
  if (!verified.has(reference)) throw sourceFailure("SNAPSHOT_NOT_VERIFIED", "源码对象尚未通过上传读回校验。");
  checkedReference(reference);
}

function supabaseObjects(url: string, secret: string): SourceObjectStore {
  const boundedFetch: typeof globalThis.fetch = (input, init) => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    const listeners: { signal: AbortSignal; listener: () => void }[] = [];
    const detach = () => { for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener); };
    // Keep the controller strongly reachable and the deadline active while the SDK consumes the response body.
    const deadline = setTimeout(() => { controller.abort(new DOMException("Storage request timed out", "TimeoutError")); detach(); }, 15_000);
    deadline.unref();
    for (const signal of signals) {
      const listener = () => { controller.abort(signal.reason); clearTimeout(deadline); detach(); };
      if (signal.aborted) { listener(); break; }
      listeners.push({ signal, listener });
      signal.addEventListener("abort", listener, { once: true });
    }
    return globalThis.fetch(input, { ...init, signal: controller.signal }).catch((error: unknown) => {
      clearTimeout(deadline); detach(); throw error;
    });
  };
  const bucket = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch },
  }).storage.from("pivloom-private");
  return {
    async upload(key, body) {
      const result = await bucket.upload(key, body, { contentType: "application/gzip", upsert: false });
      // A retry may discover its own immutable object; download/hash verification still follows.
      if (result.error && String(result.error.statusCode) !== "409") throw sourceFailure();
    },
    async download(key) {
      const result = await bucket.download(key);
      if (result.error || result.data.size > 8 * 1024 * 1024) throw sourceFailure("SNAPSHOT_UNAVAILABLE", "源码快照暂时无法读取。");
      return new Uint8Array(await result.data.arrayBuffer());
    },
    async list(prefix) {
      const objects: SourceObject[] = [];
      for (let offset = 0; ; offset += 1000) {
        const folders = await bucket.list(prefix, { limit: 1000, offset });
        if (folders.error) throw sourceFailure();
        for (const folder of folders.data) {
          if (!z.uuid().safeParse(folder.name).success) continue;
          const files = await bucket.list(`${prefix}/${folder.name}`, { limit: 1000 });
          if (files.error) throw sourceFailure();
          for (const file of files.data) {
            const match = /^([a-f0-9]{64})\.json\.gz$/.exec(file.name);
            if (match && file.id && file.created_at) objects.push({ key: `${prefix}/${folder.name}/${file.name}`, revisionId: folder.name,
              sourceHash: match[1], createdAt: file.created_at, bytes: Number(file.metadata?.size ?? 0) });
          }
        }
        if (folders.data.length < 1000) break;
      }
      return objects;
    },
  };
}

/** Object-store injection is an external test seam; production callers supply only Supabase configuration. */
export function createSourceStore(configuration: { url: string; secret: string; objects?: SourceObjectStore }): SourceStore {
  const objects = configuration.objects ?? supabaseObjects(configuration.url, configuration.secret);
  async function load(reference: SourceReference) {
    checkedReference(reference);
    try {
      const compressed = await objects.download(reference.key);
      if (compressed.byteLength !== reference.compressedBytes || compressed.byteLength > 8 * 1024 * 1024) throw sourceFailure();
      const decoded: unknown = JSON.parse(gunzipSync(compressed, { maxOutputLength: 12 * 1024 * 1024 }).toString("utf8"));
      const schema = z.strictObject({ schemaVersion: z.literal(1), templateVersion: z.string(),
        files: z.array(z.strictObject({ path: z.string(), encoding: z.literal("utf8"), content: z.string(), sha256: z.string() })).max(200),
        manifest: z.array(z.strictObject({ path: z.string(), bytes: z.number(), sha256: z.string() })).max(200),
      });
      const bundle = schema.parse(decoded);
      const checked = prepareSourceSnapshot(bundle.templateVersion, bundle.files);
      if (checked.sourceHash !== reference.sourceHash || checked.sourceBytes !== reference.sourceBytes
        || bundle.templateVersion !== reference.templateVersion || JSON.stringify(checked.manifest) !== JSON.stringify(bundle.manifest)
        || JSON.stringify(checked.manifest) !== JSON.stringify(reference.manifest)) throw sourceFailure();
      return checked.bundle;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw sourceFailure("SNAPSHOT_UNAVAILABLE", "源码快照读取或完整性校验失败。");
    }
  }
  return {
    async save(scope, templateVersion, files) {
      const prepared = prepareSourceSnapshot(templateVersion, files);
      const reference: SourceReference = { ...scope, key: sourceKey(scope, prepared.sourceHash), sourceHash: prepared.sourceHash,
        templateVersion, manifest: prepared.manifest, sourceBytes: prepared.sourceBytes, compressedBytes: prepared.compressed.byteLength };
      try {
        await objects.upload(reference.key, prepared.compressed);
        await load(reference);
        return verifiedReference(reference);
      } catch { throw sourceFailure(); }
    },
    load,
    async verify(reference) { await load(reference); return verifiedReference(reference); },
    async listObjects(ownerId, projectId) {
      if (![ownerId, projectId].every((value) => z.uuid().safeParse(value).success)) throw invalidSource("SCOPE");
      return objects.list(`${ownerId}/${projectId}`);
    },
  };
}
