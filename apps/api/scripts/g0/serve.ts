import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProbeApp } from "../../src/probe/app.js";
import { sandboxConfiguration } from "../../src/probe/config.js";

const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const directory = resolve(
  process.env.G0_ARTIFACT_DIR ?? resolve(repository, ".cache/g0-maintenance"),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const port = Number(process.env.G0_PORT ?? "45312");
const previewPort = Number(process.env.G0_PREVIEW_PORT ?? "45311");
const app = await createProbeApp({
  port,
  previewPort,
  env: process.env,
  onResult: async (result, metadata) => {
    const { screenshot, ...evidence } = result.evidence;
    if (screenshot)
      await writeFile(
        resolve(directory, `${metadata.maintenanceRunId}.png`),
        Buffer.from(screenshot.base64, "base64"),
        { mode: 0o600 },
      );
    const path = resolve(directory, `${metadata.maintenanceRunId}.json`);
    await writeFile(
      path + ".tmp",
      JSON.stringify(
        {
          ...metadata,
          ...result,
          evidence: {
            ...evidence,
            screenshot: screenshot
              ? { mimeType: screenshot.mimeType, sha256: screenshot.sha256 }
              : undefined,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(path + ".tmp", path);
    console.info(
      JSON.stringify({
        event: "G0_RESULT",
        maintenanceRunId: metadata.maintenanceRunId,
        runId: result.runId,
        status: result.status,
        checks: result.evidence.checks,
        cleanup: result.cleanup,
      }),
    );
  },
});
try {
  await app.preview.listen({ port: previewPort, host: "127.0.0.1" });
  await app.app.listen({ port, host: "127.0.0.1" });
  console.info(
    JSON.stringify({
      event: "G0_READY",
      bootId: app.bootId,
      pageUrl: `http://localhost:${port}/`,
      previewOrigin: `http://localhost:${previewPort}`,
      sandboxConfigured: sandboxConfiguration(process.env).missing.length === 0,
      evidenceDirectory: directory,
    }),
  );
} catch {
  await app.close();
  throw new Error(
    "G0 loopback listener could not start; check ports and local configuration.",
  );
}
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  console.info(JSON.stringify({ event: "G0_CLOSED", bootId: app.bootId }));
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
