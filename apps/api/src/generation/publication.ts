import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Sandbox } from "@alibaba-group/opensandbox";
import type { SandboxConfig } from "../runtime/types.js";
import { sandboxConnectionConfig } from "../runtime/workspace.js";
import { ApiFailure } from "../routes/errors.js";

export interface Publication {
  projectId: string;
  revisionId: string;
  sourceHash: string;
  url: string;
  publishedAt: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/i;

/** Static releases remain on the host after the short-lived preview sandbox expires. */
export function createPublicationStore(options: { root: string; baseUrl: string; sandbox: SandboxConfig }) {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password)
    throw new Error("Published app base must be an HTTPS origin");
  const root = options.root;
  function location(projectId: string) {
    if (!uuid.test(projectId)) throw new ApiFailure(404, "NOT_FOUND", "找不到这个项目。");
    return join(root, projectId);
  }
  function url(projectId: string) { return `https://${projectId}.${base.host}/`; }
  async function get(projectId: string): Promise<Publication | null> {
    try {
      const record: unknown = JSON.parse(await readFile(join(location(projectId), "publication.json"), "utf8"));
      if (!record || typeof record !== "object") return null;
      const value = record as Partial<Publication>;
      if (value.projectId !== projectId || !value.revisionId || !uuid.test(value.revisionId)
        || !value.sourceHash || !hash.test(value.sourceHash) || typeof value.publishedAt !== "string") return null;
      await stat(join(location(projectId), "current", "index.html"));
      return { projectId, revisionId: value.revisionId, sourceHash: value.sourceHash,
        publishedAt: value.publishedAt, url: url(projectId) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function hostAllowed(host: string) {
    const suffix = `.${base.hostname.toLowerCase()}`;
    const name = host.trim().toLowerCase().replace(/\.$/, "");
    if (!name.endsWith(suffix)) return false;
    const projectId = name.slice(0, -suffix.length);
    return uuid.test(projectId) && !!await get(projectId);
  }
  async function publicFile(host: string, requestPath: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const suffix = `.${base.hostname.toLowerCase()}`;
    const name = host.trim().toLowerCase().replace(/\.$/, "");
    if (!name.endsWith(suffix)) return null;
    const projectId = name.slice(0, -suffix.length);
    if (!uuid.test(projectId) || !await get(projectId)) return null;
    let path: string;
    try { path = decodeURIComponent(requestPath); } catch { return null; }
    if (path.startsWith("/") || path.includes("\\") || path.includes("%") || path.length > 240) return null;
    const parts = path ? path.split("/") : [];
    if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return null;
    const rootPath = join(location(projectId), "current");
    const selected = parts.length ? join(rootPath, ...parts) : join(rootPath, "index.html");
    let bytes: Buffer;
    let servedPath = selected;
    try { bytes = await readFile(selected); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (parts.at(-1)?.includes(".") ?? false)) return null;
      servedPath = join(rootPath, "index.html");
      bytes = await readFile(servedPath).catch(() => Buffer.alloc(0));
      if (!bytes.length) return null;
    }
    const extension = servedPath.split(".").at(-1)?.toLowerCase();
    const mime = ({ html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
      json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      webp: "image/webp", gif: "image/gif", ico: "image/x-icon", wasm: "application/wasm",
      woff: "font/woff", woff2: "font/woff2", txt: "text/plain; charset=utf-8", map: "application/json" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
    return { bytes, mime };
  }
  async function publish(input: { projectId: string; revisionId: string; sourceHash: string; sandboxId: string }): Promise<Publication> {
    const { projectId, revisionId, sourceHash, sandboxId } = input;
    if (!uuid.test(projectId) || !uuid.test(revisionId) || !hash.test(sourceHash))
      throw new ApiFailure(422, "INVALID_PUBLICATION", "发布版本无效。");
    const sandbox = await Sandbox.connect({ connectionConfig: sandboxConnectionConfig(options.sandbox), sandboxId, readyTimeoutSeconds: 15 });
    const files = new Map<string, Buffer>();
    try {
      const listing = await sandbox.commands.run("find dist -type f -printf '%P\\n' | sort", {
        workingDirectory: "/workspace/app", timeoutSeconds: 15, uid: 1000, gid: 1000,
      });
      if (listing.error || listing.exitCode !== 0)
        throw new ApiFailure(409, "PUBLICATION_BUILD_MISSING", "预览构建产物不可用，请重新启动预览。");
      const paths = listing.logs.stdout.flatMap((item) => item.text.split(/\r?\n/)).map((path) => path.trim()).filter(Boolean);
      if (paths.length < 2 || paths.length > 500 || !paths.includes("index.html") || !paths.includes("pivloom-revision.json"))
        throw new ApiFailure(409, "PUBLICATION_BUILD_MISSING", "预览构建产物不完整，请重新启动预览。");
      let total = 0;
      for (const path of paths) {
        const parts = path.split("/");
        if (!path || path.length > 240 || path.includes("\\") || parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")))
          throw new ApiFailure(409, "INVALID_PUBLICATION_FILE", "构建产物包含无效路径。");
        const bytes = Buffer.from(await sandbox.files.readBytes(`/workspace/app/dist/${path}`));
        total += bytes.length;
        if (total > 50 * 1024 * 1024) throw new ApiFailure(413, "PUBLICATION_TOO_LARGE", "构建产物超过发布大小上限。");
        files.set(path, bytes);
      }
    } finally { await sandbox.close(); }
    let marker: { revisionId?: string; sourceHash?: string };
    try { marker = JSON.parse(files.get("pivloom-revision.json")!.toString("utf8")); }
    catch { throw new ApiFailure(409, "PUBLICATION_VERSION_MISMATCH", "构建版本标识不可读取。"); }
    if (marker.revisionId !== revisionId || marker.sourceHash !== sourceHash)
      throw new ApiFailure(409, "PUBLICATION_VERSION_MISMATCH", "预览与已保存版本不一致，不能发布。");

    const projectRoot = location(projectId);
    const releases = join(projectRoot, "releases");
    const release = join(releases, `${revisionId}-${randomUUID()}`);
    const stage = join(releases, `.stage-${randomUUID()}`);
    await mkdir(stage, { recursive: true });
    await chmod(projectRoot, 0o755);
    await chmod(releases, 0o755);
    await chmod(stage, 0o755);
    try {
      for (const [path, original] of files) {
        const target = join(stage, path);
        await mkdir(dirname(target), { recursive: true });
        await chmod(dirname(target), 0o755);
        const bytes = /\.(?:html|js|css|json|svg|txt|map)$/.test(path)
          ? Buffer.from(original.toString("utf8").replaceAll(`/p/${revisionId}/`, "/")) : original;
        await writeFile(target, bytes);
        await chmod(target, 0o644);
      }
      await rename(stage, release);
    } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
    const next = join(projectRoot, `.current-${randomUUID()}`);
    await symlink(release, next);
    await rename(next, join(projectRoot, "current"));
    const record: Publication = { projectId, revisionId, sourceHash, publishedAt: new Date().toISOString(), url: url(projectId) };
    const recordTemp = join(projectRoot, `.publication-${randomUUID()}.json`);
    await writeFile(recordTemp, JSON.stringify(record));
    await chmod(recordTemp, 0o644);
    await rename(recordTemp, join(projectRoot, "publication.json"));
    return record;
  }
  return { get, hostAllowed, publicFile, publish };
}
