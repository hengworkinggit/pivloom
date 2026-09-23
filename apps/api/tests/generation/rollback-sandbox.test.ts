import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { restorePreview } from "../../src/generation/restore.js";
import { REACT_TEMPLATE_VERSION } from "../../src/runtime/snapshot.js";
import type { SandboxConnection, SandboxConnector } from "../../src/runtime/workspace.js";
import { prepareSourceSnapshot, sourceBundleFiles } from "../../src/storage/source.js";

// Exercises the real OpenSandboxWorkspace, source I/O protocol, build gates,
// full-tree hash and HTTP marker against a deterministic sandbox-connection
// fixture. It is not a live OpenSandbox deployment or model-generated app.
describe("rollback preview rebuild from an immutable full tree", () => {
  const basePackage = { name: "rollback-fixture", version: "1.0.0" };
  const packageJson = JSON.stringify({ ...basePackage, type: "module", scripts: {
    typecheck: "tsc --noEmit", build: "tsc --noEmit && vite build",
    preview: "vite preview --host 0.0.0.0 --port 4173 --strictPort",
  } }, null, 2);
  const lock = '{"name":"rollback-fixture","lockfileVersion":3}';
  const saved = prepareSourceSnapshot(REACT_TEMPLATE_VERSION, [
    { path: "src/App.tsx", content: "export default function App(){return <p>one</p>}\n" },
    { path: "src/界面.tsx", content: "export const label='一';\n" },
    { path: "package.json", content: packageJson },
    { path: "package-lock.json", content: lock },
  ]);
  let server: Server, origin: string;
  let marker: string | null = null;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/pivloom-revision.json" && marker) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(marker);
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Fixture HTTP endpoint unavailable");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connector(injectExtraDuringBuild = false) {
    const files = new Map<string, Buffer>();
    const staging = new Map<string, Buffer>();
    let killed = false;
    let createCount = 0;
    const sandboxId = randomUUID();
    const connection: SandboxConnection = {
      sandboxId,
      async kill() { killed = true; },
      async isRunning() { return !killed; },
      async renew() {},
      async close() {},
      async endpoint() { return { url: origin, headers: {} }; },
      async write(path, data) { staging.set(path, Buffer.from(data)); },
      async read(path) { return staging.get(path) ?? Buffer.alloc(0); },
      async run(command) {
        let stdoutTail = "";
        if (command.startsWith("node /opt/pivloom/source-io.mjs ")) {
          const path = command.slice("node /opt/pivloom/source-io.mjs ".length).replace(/^'|'$/g, "");
          const body = JSON.parse(staging.get(path)!.toString("utf8")) as { op: string; path?: string; data?: string };
          if (body.op === "write") { files.set(body.path!, Buffer.from(body.data!, "base64")); stdoutTail = '{"ok":true}'; }
          else if (body.op === "read") stdoutTail = JSON.stringify({ data: files.get(body.path!)?.toString("base64") ?? "" });
          else if (body.op === "list") stdoutTail = JSON.stringify({ files: [...files.keys()] });
        } else if (command.includes('readFileSync("/workspace/package.json"')) stdoutTail = JSON.stringify(basePackage);
        else if (command.includes('readFileSync("/workspace/package-lock.json"')) stdoutTail = lock;
        else if (command.includes("vite.js build") && injectExtraDuringBuild)
          files.set("src/residual.ts", Buffer.from("export const residual=true;\n"));
        else if (command.startsWith("cp /opt/pivloom/marker.json")) marker = staging.get("/opt/pivloom/marker.json")?.toString("utf8") ?? null;
        return { id: randomUUID(), async wait() { return { exitCode: 0, stdoutTail, stderrTail: "" }; }, async interrupt() {} };
      },
    };
    const sandboxConnector: SandboxConnector = { async create() { createCount++; return connection; } };
    return { sandboxConnector, files, get killed() { return killed; }, get createCount() { return createCount; } };
  }

  test("recreates exactly the old path/content set including Unicode, without calling a model", async () => {
    marker = null;
    const remote = connector();
    const revisionId = randomUUID();
    const result = await restorePreview({ revisionId, sourceHash: saved.sourceHash,
      files: sourceBundleFiles(saved.bundle), sandboxConfig: { baseUrl: origin, apiKey: "fixture", image: "fixture" },
      signal: new AbortController().signal,
    }, { sandboxConnector: remote.sandboxConnector });
    expect(remote.createCount).toBe(1);
    expect(remote.killed).toBe(false);
    expect(result.sourceHash).toBe(saved.sourceHash);
    expect(result.files.map((file) => file.path).sort()).toEqual(saved.manifest.map((file) => file.path).sort());
    for (const file of result.files)
      expect(createHash("sha256").update(remote.files.get(file.path)!).digest("hex")).toBe(file.sha256);
    expect(JSON.parse(marker!)).toEqual({ revisionId, sourceHash: saved.sourceHash });
    expect(result.trustedBuild.typecheck?.exitCode).toBe(0);
    expect(result.trustedBuild.build?.exitCode).toBe(0);
  });

  test("rejects a residual extra source file and destroys the candidate sandbox", async () => {
    marker = null;
    const remote = connector(true);
    await expect(restorePreview({ revisionId: randomUUID(), sourceHash: saved.sourceHash,
      files: sourceBundleFiles(saved.bundle), sandboxConfig: { baseUrl: origin, apiKey: "fixture", image: "fixture" },
      signal: new AbortController().signal,
    }, { sandboxConnector: remote.sandboxConnector })).rejects.toMatchObject({ code: "SOURCE_CHANGED_DURING_BUILD" });
    expect(remote.killed).toBe(true);
    expect(marker).toBeNull();
  });
});
