import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const value: unknown = JSON.parse(await readFile(join(process.cwd(), "version.json"), "utf8"));
    if (value && typeof value === "object" && "component" in value && value.component === "web"
      && "commit" in value && typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit)
      && "builtAt" in value && typeof value.builtAt === "string" && !Number.isNaN(Date.parse(value.builtAt))
      && "buildId" in value && typeof value.buildId === "string"
      && "deploymentId" in value && (value.deploymentId === null || typeof value.deploymentId === "string")) {
      return Response.json(value, { headers: { "cache-control": "no-store" } });
    }
  } catch { /* Local development has no release manifest. */ }
  if (process.env.NODE_ENV === "production")
    return Response.json({ error: "Web artifact version manifest is missing or invalid" }, { status: 503, headers: { "cache-control": "no-store" } });
  return Response.json({ component: "web", commit: null, builtAt: null, buildId: null, deploymentId: null },
    { headers: { "cache-control": "no-store" } });
}
