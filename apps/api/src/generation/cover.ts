import { z } from "zod";
import { RemoteBrowser } from "../runtime/browser.js";
import type { SandboxConfig } from "../runtime/types.js";
import { OpenSandboxWorkspace, type SandboxConnector } from "../runtime/workspace.js";

/** Capture the app already running in its accepted Preview sandbox. This uses
 * no model call and creates no additional sandbox or review verdict. */
export async function capturePreviewCover(input: {
  sandbox: SandboxConfig; connector?: SandboxConnector;
  sandboxId: string; expiresAt: string; revisionId: string;
}): Promise<Buffer> {
  const revisionId = z.uuid().parse(input.revisionId);
  const workspace = new OpenSandboxWorkspace(input.sandbox, input.connector);
  const handle = { sandboxId: input.sandboxId, expiresAt: input.expiresAt };
  await workspace.connect(handle);
  const browser = new RemoteBrowser(workspace, handle, undefined, undefined, AbortSignal.timeout(15_000));
  try {
    await browser.open(`/p/${revisionId}/`);
    await browser.resize(1000, 600);
    const image = await browser.screenshot();
    return Buffer.from(image.base64, "base64");
  } finally {
    const closed = await browser.close().catch(() => ({ confirmed: false }));
    await workspace.releaseClient(handle).catch(() => {});
    if (!closed.confirmed) throw new Error("Cover browser cleanup unconfirmed");
  }
}
