import { ProjectSummarySchema, type ProjectSummary } from "@pivloom/contracts";
import { z } from "zod";
import type { PivloomDatabase } from "./database.js";
import { ApiFailure } from "../routes/errors.js";

interface ProjectRow {
  id: string;
  title: string;
  current_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const cursorSchema = z.strictObject({ id: z.uuid(), updatedAt: z.iso.datetime() });
const columns = "id, title, current_revision_id, created_at, updated_at";
function summary(row: ProjectRow): ProjectSummary {
  return ProjectSummarySchema.parse({
    id: row.id, title: row.title, currentRevisionId: row.current_revision_id,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    if (value.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("invalid cursor");
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new ApiFailure(422, "INVALID_INPUT", "分页位置无效，请重新打开项目列表。");
  }
}

export function createProjectRepository(database: PivloomDatabase) {
  return {
    async create(ownerId: string, title = "未命名项目") {
      return database.owned(ownerId, async (client) => {
        const result = await client.query<ProjectRow>(
          `INSERT INTO nano.projects (owner_id, title) VALUES ($1, $2) RETURNING ${columns}`,
          [ownerId, title],
        );
        return summary(result.rows[0]);
      });
    },
    async list(ownerId: string, limit = 20, cursor?: string) {
      const after = decodeCursor(cursor);
      return database.owned(ownerId, async (client) => {
        const result = await client.query<ProjectRow>(
          `SELECT ${columns} FROM nano.projects WHERE owner_id = $1
           AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::uuid))
           ORDER BY updated_at DESC, id DESC LIMIT $4`,
          [ownerId, after?.updatedAt ?? null, after?.id ?? null, limit + 1],
        );
        const projects = result.rows.slice(0, limit).map(summary);
        const last = projects.at(-1);
        const nextCursor = result.rows.length > limit && last
          ? Buffer.from(JSON.stringify({ id: last.id, updatedAt: last.updatedAt })).toString("base64url")
          : null;
        return { projects, nextCursor };
      });
    },
    async get(ownerId: string, id: string) {
      return database.owned(ownerId, async (client) => {
        const result = await client.query<ProjectRow>(
          `SELECT ${columns} FROM nano.projects WHERE owner_id = $1 AND id = $2`, [ownerId, id],
        );
        if (!result.rows[0]) throw new ApiFailure(404, "NOT_FOUND", "找不到这个项目。");
        return summary(result.rows[0]);
      });
    },
  };
}
