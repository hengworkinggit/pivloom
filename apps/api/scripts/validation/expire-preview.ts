/**
 * Operator helper for the preview-expiry acceptance run (DEV-10).
 *
 * It expires exactly one project's active preview binding: the remote sandbox
 * recorded in that binding is destroyed by id and its disappearance is
 * confirmed before the row is marked expired. Nothing else is touched, so a
 * concurrent candidate or another project can never be reclaimed by accident.
 *
 * Run: node --env-file=.env.local --import tsx scripts/validation/expire-preview.ts <ownerId> <projectId>
 * It prints ids and states only, never credentials.
 */
import { Pool } from "pg";
import { SandboxManager } from "@alibaba-group/opensandbox";
import { sandboxConnectionConfig } from "../../src/runtime/workspace.js";

const [ownerId, projectId] = process.argv.slice(2);
if (!ownerId || !projectId) throw new Error("usage: expire-preview.ts <ownerId> <projectId>");
for (const [label, value] of [["ownerId", ownerId], ["projectId", projectId]] as const)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${label} must be a uuid`);
const baseUrl = process.env.OPENSANDBOX_BASE_URL;
const apiKey = process.env.OPENSANDBOX_API_KEY;
if (!baseUrl || !apiKey || !process.env.MIGRATION_DATABASE_URL) throw new Error("sandbox and migration configuration are required");

const database = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1 });
const bindings = await database.query<{ id: string; remote_id: string; revision_id: string; state: string }>(
  `SELECT id, remote_id, revision_id, state FROM nano.sandboxes
   WHERE owner_id=$1 AND project_id=$2 AND purpose='preview' AND state IN ('creating','active')`,
  [ownerId, projectId]);
if (bindings.rows.length !== 1)
  throw new Error(`expected exactly one active preview binding, found ${bindings.rows.length}`);
const binding = bindings.rows[0];

const manager = SandboxManager.create({ connectionConfig: sandboxConnectionConfig({ baseUrl, apiKey, image: "unused-for-kill" }) });
try {
  await manager.killSandbox(binding.remote_id);
  let confirmed = false;
  for (let attempt = 0; attempt < 10 && !confirmed; attempt++) {
    try { await manager.getSandboxInfo(binding.remote_id); }
    catch (error) { confirmed = (error as { statusCode?: number }).statusCode === 404; }
    if (!confirmed) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!confirmed) throw new Error("remote sandbox destruction was not confirmed; the binding was left active");
} finally {
  await manager.close().catch(() => undefined);
}

await database.query(
  "UPDATE nano.sandboxes SET state='expired', expires_at=now()-interval '1 minute', last_checked_at=now() WHERE id=$1",
  [binding.id]);
console.log(JSON.stringify({ expiredBinding: binding.id, revisionId: binding.revision_id, sandbox: binding.remote_id, remoteConfirmedGone: true }));
await database.end();
