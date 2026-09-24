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
  active_run_state?: string | null;
  active_run_position?: string | number | null;
}

const cursorSchema = z.strictObject({ id: z.uuid(), updatedAt: z.iso.datetime() });
const columns = "id, title, current_revision_id, created_at, updated_at";
const activeStates = new Set(["queued", "accepted", "planning", "building", "verifying", "repairing", "finalizing", "cancel_requested"]);
function summary(row: ProjectRow): ProjectSummary {
  // Only a real active task is reported; a settled run leaves the field null so
  // the card keeps showing the saved version instead of a stale progress state.
  const state = row.active_run_state && activeStates.has(row.active_run_state) ? row.active_run_state : null;
  const position = row.active_run_position === null || row.active_run_position === undefined
    ? null : Number(row.active_run_position);
  return ProjectSummarySchema.parse({
    id: row.id, title: row.title, currentRevisionId: row.current_revision_id,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    activeRunState: state,
    activeRunPosition: state === "queued" && Number.isFinite(position) ? position : null,
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
        // The card states what the project is really doing. A project whose task
        // is still waiting for capacity must not read as an idle "已有版本", and
        // the queue position comes from the scheduler's own ordering.
        const result = await client.query<ProjectRow>(
          `SELECT ${columns},
             active.state AS active_run_state,
             queue.queue_position AS active_run_position
           FROM nano.projects
           LEFT JOIN LATERAL (
             SELECT r.state FROM nano.runs r
             WHERE r.owner_id = nano.projects.owner_id AND r.project_id = nano.projects.id
               AND (r.state IN ('queued','accepted','planning','building','verifying','repairing','finalizing','cancel_requested')
                 OR r.cleanup_state = 'pending')
             ORDER BY r.created_at DESC, r.id DESC LIMIT 1
           ) active ON true
           LEFT JOIN nano.queue_candidates() queue ON queue.run_id = (
             SELECT r.id FROM nano.runs r
             WHERE r.owner_id = nano.projects.owner_id AND r.project_id = nano.projects.id AND r.state = 'queued'
             ORDER BY r.queued_at, r.id LIMIT 1)
           WHERE nano.projects.owner_id = $1
           AND ($2::timestamptz IS NULL OR (nano.projects.updated_at, nano.projects.id) < ($2::timestamptz, $3::uuid))
           ORDER BY nano.projects.updated_at DESC, nano.projects.id DESC LIMIT $4`,
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
