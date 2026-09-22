import { createSourceSnapshot } from "./snapshot.js";
import { OpenSandboxWorkspace, shellQuote } from "./workspace.js";
import {
  REACT_TEMPLATE,
  SOURCE_IO_SCRIPT,
  STATIC_PREVIEW_SCRIPT,
} from "./template.js";
import {
  RuntimeError,
  type WorkspaceHandle,
  type SourceFile,
  type CommandResult,
  type TrustedBuildRecord,
  type TrustedCommandRecord,
} from "./types.js";

export async function initializeReactWorkspace(
  workspace: OpenSandboxWorkspace,
  handle: WorkspaceHandle,
): Promise<void> {
  await workspace.initialize(handle, REACT_TEMPLATE, SOURCE_IO_SCRIPT);
  // Reuse the exact dependency graph actually baked into the verified image.
  const pkg = await workspace.executeService(
    handle,
    'node -e \'process.stdout.write(require("fs").readFileSync("/workspace/package.json","utf8"))\'',
    { uid: 0 },
  );
  const lock = await workspace.executeService(
    handle,
    'node -e \'process.stdout.write(require("fs").readFileSync("/workspace/package-lock.json","utf8"))\'',
    { uid: 0 },
  );
  if (pkg.exitCode !== 0 || lock.exitCode !== 0)
    throw new RuntimeError(
      "TEMPLATE_INVALID",
      "沙箱镜像缺少锁定的 React 模板依赖",
    );
  const manifest = JSON.parse(pkg.stdoutTail) as Record<string, unknown>;
  manifest.type = "module";
  manifest.scripts = {
    typecheck: "tsc --noEmit",
    build: "tsc --noEmit && vite build",
    preview: "vite preview --host 0.0.0.0 --port 4173 --strictPort",
  };
  await workspace.write(
    handle,
    "package.json",
    Buffer.from(JSON.stringify(manifest, null, 2)),
  );
  await workspace.write(
    handle,
    "package-lock.json",
    Buffer.from(lock.stdoutTail),
  );
}
export function sourceHash(files: SourceFile[]): string {
  return createSourceSnapshot(files).sourceHash;
}
export async function buildAndPreview(
  workspace: OpenSandboxWorkspace,
  handle: WorkspaceHandle,
  revisionId: string,
  options: {
    signal?: AbortSignal;
    buildTimeoutMs?: number;
    previewBasePath?: string;
  } = {},
): Promise<{
  files: SourceFile[];
  sourceHash: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  commands: CommandResult[];
  trustedBuild: TrustedBuildRecord;
}> {
  const trustedBuild: TrustedBuildRecord = { schemaVersion: 1, sourceHash: null, typecheck: null, build: null };
  const executeGate = async (stage: "typecheck" | "build", command: string): Promise<CommandResult> => {
    const record: TrustedCommandRecord = { command, exitCode: null, durationMs: null, stdoutTail: "", stderrTail: "" };
    trustedBuild[stage] = record;
    const started = performance.now();
    try {
      const result = await workspace.executeService(handle, command, { timeoutMs: options.buildTimeoutMs ?? 120000 });
      Object.assign(record, result);
      return result;
    } finally {
      record.durationMs = Math.max(0, performance.now() - started);
    }
  };
  try {
    const basePath = options.previewBasePath ?? "/";
    if (
      basePath !== "/" &&
      (basePath !== `/p/${revisionId}/` ||
        !/^\/p\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/$/.test(
          basePath,
        ))
    )
      throw new RuntimeError(
        "INVALID_PREVIEW_BASE_PATH",
        "预览路径必须绑定固定版本 ID",
      );
    options.signal?.throwIfAborted();
    await workspace.revokeWriters(handle);
    const files = await workspace.listSourceFiles(handle);
    trustedBuild.sourceHash = sourceHash(files);
    const typescript = files
      .filter((f) => /\.[cm]?tsx?$/.test(f.path))
      .map((f) => shellQuote("/workspace/app/" + f.path));
    if (!typescript.length)
      throw new RuntimeError("BUILD_FAILED", "没有 TypeScript 源码");
    await workspace.writeServiceFile(
      handle,
      "vite-config.mjs",
      `export default {root:'/workspace/app',base:${JSON.stringify(basePath)},build:{outDir:'dist',emptyOutDir:true}};`,
    );
    await workspace.writeServiceFile(
      handle,
      "preview.mjs",
      STATIC_PREVIEW_SCRIPT,
    );
    const typecheckCommand = `node /workspace/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --esModuleInterop --target ES2022 --module ESNext --moduleResolution Bundler --jsx react-jsx --lib ES2022,DOM,DOM.Iterable ${typescript.join(" ")}`;
    const check = await executeGate("typecheck", typecheckCommand);
    if (check.exitCode !== 0)
      throw new RuntimeError(
        "TYPECHECK_FAILED",
        "生成代码未通过类型检查，可查看已保存的源码与诊断记录。",
      );
    options.signal?.throwIfAborted();
    const buildCommand = "node /workspace/node_modules/vite/bin/vite.js build --config /opt/pivloom/vite-config.mjs --configLoader native";
    const built = await executeGate("build", buildCommand);
    if (built.exitCode !== 0)
      throw new RuntimeError(
        "BUILD_FAILED",
        "生成代码未通过生产构建，可查看已保存的源码与诊断记录。",
      );
    await workspace.revokeWriters(handle);
    const finalFiles = await workspace.listSourceFiles(handle),
      hash = sourceHash(finalFiles);
    if (sourceHash(files) !== hash)
      throw new RuntimeError(
        "SOURCE_CHANGED_DURING_BUILD",
        "固定构建期间源码发生变化",
      );
    options.signal?.throwIfAborted();
    const marker = JSON.stringify({ revisionId, sourceHash: hash });
    await workspace.writeServiceFile(handle, "marker.json", marker);
    const copied = await workspace.executeService(
      handle,
      "cp /opt/pivloom/marker.json /workspace/app/dist/pivloom-revision.json && chown -R root:root /workspace/app/dist && chmod -R a-w /workspace/app/dist",
      { uid: 0 },
    );
    if (copied.exitCode !== 0)
      throw new RuntimeError("PREVIEW_START_FAILED", "无法绑定预览版本");
    // Trusted static server runs as root solely to own the read-only built files;
    // generated scripts only execute in the separate unprivileged Builder process.
    await workspace.executeService(
      handle,
      `PIVLOOM_PREVIEW_BASE_PATH=${shellQuote(basePath)} node /opt/pivloom/preview.mjs`,
      {
        uid: 0,
        background: true,
        timeoutMs: 900000,
      },
    );
    const endpoint = await workspace.endpoint(handle, 4173);
    for (let i = 0; i < 30; i++) {
      options.signal?.throwIfAborted();
      try {
        const response = await fetch(endpoint.url + "/pivloom-revision.json", {
          headers: endpoint.headers,
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(3000)])
            : AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const data = (await response.json()) as {
            revisionId?: string;
            sourceHash?: string;
          };
          if (data.revisionId === revisionId && data.sourceHash === hash)
            return {
              files: finalFiles,
              sourceHash: hash,
              upstreamUrl: endpoint.url,
              headers: endpoint.headers,
              commands: [check, built],
              trustedBuild,
            };
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new RuntimeError("PREVIEW_START_FAILED", "预览版本标记未通过健康检查");
  } catch (error) {
    if (error instanceof RuntimeError) throw new RuntimeError(error.code, error.message, trustedBuild);
    throw new RuntimeError("TRUSTED_BUILD_FAILED", "可信构建未能完成，请稍后重试。", trustedBuild);
  }
}
