import { createHash } from "node:crypto";
import type { PivloomDatabase } from "./database.js";

const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Immutable-revision card images remain available after Preview expires. */
export function createCoverRepository(database: PivloomDatabase) {
  return {
    async save(ownerId: string, projectId: string, revisionId: string, bytes: Uint8Array) {
      const png = Buffer.from(bytes);
      if (png.length < 8 || png.length > 2 * 1024 * 1024 || !png.subarray(0, 8).equals(pngHeader))
        throw new Error("Invalid project cover PNG");
      const sha256 = createHash("sha256").update(png).digest("hex");
      return database.owned(ownerId, async (client) => {
        const revision = await client.query(`SELECT id FROM nano.revisions
          WHERE owner_id=$1 AND project_id=$2 AND id=$3 AND status='accepted' AND build_status='passed'`,
        [ownerId, projectId, revisionId]);
        if (!revision.rowCount) return false;
        await client.query(`INSERT INTO nano.revision_covers(revision_id,project_id,owner_id,png,sha256)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(revision_id) DO UPDATE
          SET png=excluded.png,sha256=excluded.sha256,captured_at=now()`,
        [revisionId, projectId, ownerId, png, sha256]);
        return true;
      });
    },
    read: (ownerId: string, revisionId: string): Promise<{ bytes: Buffer; sha256: string } | null> =>
      database.owned(ownerId, async (client) => {
        const row = (await client.query<{ png: Buffer; sha256: string }>(
          "SELECT png,sha256 FROM nano.revision_covers WHERE owner_id=$1 AND revision_id=$2",
          [ownerId, revisionId])).rows[0];
        return row ? { bytes: row.png, sha256: row.sha256 } : null;
      }),
    exists: (ownerId: string, revisionId: string): Promise<boolean> =>
      database.owned(ownerId, async (client) => (await client.query(
        "SELECT 1 FROM nano.revision_covers WHERE owner_id=$1 AND revision_id=$2", [ownerId, revisionId])).rowCount === 1),
  };
}
