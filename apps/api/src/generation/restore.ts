import { buildAndPreview, initializeReactWorkspace } from "../runtime/generation.js";
import {
  OpenSandboxWorkspace,
  type SandboxConnector,
} from "../runtime/workspace.js";
import {
  RuntimeError,
  type SandboxConfig,
  type SourceFile,
  type TrustedBuildRecord,
  type WorkspaceHandle,
} from "../runtime/types.js";

export interface RestorePreviewInput {
  revisionId: string;
  sourceHash: string;
  /** The immutable saved snapshot; the restored build must reproduce its hash. */
  files: SourceFile[];
  sandboxConfig: SandboxConfig;
  signal: AbortSignal;
  onSandbox?: (handle: WorkspaceHandle) => Promise<void>;
}

export interface RestorePreviewResult {
  handle: WorkspaceHandle;
  trustedBuild: TrustedBuildRecord;
  sourceHash: string;
  upstreamUrl: string;
  headers: Record<string, string>;
}

/** Rebuilds a preview for an already saved revision. It never calls a model and
 * never creates a revision; the only side effect is a fresh sandbox whose
 * source hash is verified against the saved snapshot before it is published. */
export async function restorePreview(
  input: RestorePreviewInput,
  boundaries: { sandboxConnector?: SandboxConnector } = {},
): Promise<RestorePreviewResult> {
  const workspace = new OpenSandboxWorkspace(
    {
      ...input.sandboxConfig,
      lifetimeMs: Math.min(input.sandboxConfig.lifetimeMs ?? 900_000, 900_000),
    },
    boundaries.sandboxConnector,
  );
  let handle: WorkspaceHandle | undefined;
  let published = false;
  try {
    input.signal.throwIfAborted();
    handle = await workspace.create({
      runId: `restore-${input.revisionId}`,
      signal: input.signal,
      onCreated: async (created) => {
        handle = created;
        await input.onSandbox?.(created);
      },
    });
    await initializeReactWorkspace(workspace, handle, input.files);
    input.signal.throwIfAborted();
    const built = await buildAndPreview(workspace, handle, input.revisionId, {
      signal: input.signal,
      buildTimeoutMs: 90_000,
      previewBasePath: `/p/${input.revisionId}/`,
    });
    if (built.sourceHash !== input.sourceHash)
      throw new RuntimeError(
        "RESTORE_VERSION_MISMATCH",
        "重建的源码与已保存版本不一致，未发布新的预览。",
      );
    input.signal.throwIfAborted();
    await workspace.releaseClient(handle);
    published = true;
    return {
      handle,
      trustedBuild: built.trustedBuild,
      sourceHash: built.sourceHash,
      upstreamUrl: built.upstreamUrl,
      headers: built.headers,
    };
  } finally {
    if (!published && handle) await workspace.destroy(handle).catch(() => undefined);
  }
}
