import { randomUUID } from "node:crypto";
import {
  AppDataKindSchema, AppRecordSchema, BookingSubmissionSchema, RegistrationSubmissionSchema,
  type AppDataKind, type AppRecord, type BookingSubmission, type RegistrationSubmission,
} from "@pivloom/contracts";
import type { PivloomDatabase } from "./database.js";
import { ApiFailure } from "../routes/errors.js";

type Collection = "registrations" | "bookings";
type Submission = RegistrationSubmission | BookingSubmission;
interface RecordRow {
  id: string; collection: Collection; payload_json: Record<string, unknown>; confirmed: boolean;
  created_at: Date; updated_at: Date;
}
const collectionFor = (kind: AppDataKind): Collection => kind === "event-signup" ? "registrations" : "bookings";
const record = (row: RecordRow): AppRecord => AppRecordSchema.parse({
  id: row.id, collection: row.collection, ...row.payload_json, confirmed: row.confirmed,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
});

/** Runtime data is scoped to a project and survives source revisions and sandboxes. */
export function createAppDataRepository(database: PivloomDatabase) {
  return {
    profileForOwner: (ownerId: string, projectId: string): Promise<AppDataKind | null> =>
      database.owned(ownerId, async (client) => {
        const row = (await client.query("SELECT kind FROM nano.app_data_profiles WHERE owner_id=$1 AND project_id=$2", [ownerId, projectId])).rows[0];
        return row ? AppDataKindSchema.parse(row.kind) : null;
      }),
    profileForPublished: (projectId: string): Promise<{ ownerId: string; kind: AppDataKind } | null> =>
      database.system(async (client) => {
        const row = (await client.query("SELECT * FROM nano.app_data_profile($1)", [projectId])).rows[0];
        return row ? { ownerId: row.o_owner_id as string, kind: AppDataKindSchema.parse(row.o_kind) } : null;
      }),
    submit: (ownerId: string, projectId: string, kind: AppDataKind, raw: unknown, idempotencyKey: string) => {
      const parsed = kind === "event-signup" ? RegistrationSubmissionSchema.safeParse(raw) : BookingSubmissionSchema.safeParse(raw);
      if (!parsed.success) throw new ApiFailure(422, "INVALID_APP_DATA", "提交内容不符合要求，请检查后重试。");
      const data = parsed.data as Submission;
      if (kind === "appointments" && (data as BookingSubmission).date < new Date().toISOString().slice(0, 10))
        throw new ApiFailure(422, "INVALID_BOOKING_DATE", "预约日期不能早于今天。");
      const collection = collectionFor(kind);
      const uniqueKey = kind === "event-signup"
        ? `${(data as RegistrationSubmission).category}:${(data as RegistrationSubmission).email.toLowerCase()}`
        : `${(data as BookingSubmission).date}T${(data as BookingSubmission).time}`;
      return database.owned(ownerId, async (client) => {
        const project = (await client.query("SELECT id FROM nano.projects WHERE owner_id=$1 AND id=$2 FOR UPDATE", [ownerId, projectId])).rows[0];
        if (!project) throw new ApiFailure(404, "NOT_FOUND", "找不到这个项目。");
        const profile = (await client.query("SELECT kind FROM nano.app_data_profiles WHERE owner_id=$1 AND project_id=$2", [ownerId, projectId])).rows[0];
        if (profile?.kind !== kind) throw new ApiFailure(409, "APP_DATA_UNAVAILABLE", "这个应用未启用对应的数据集合。");
        const prior = (await client.query(`SELECT id,payload_json=$5::jsonb AS same_payload FROM nano.app_records
          WHERE owner_id=$1 AND project_id=$2 AND collection=$3 AND idempotency_key=$4`,
        [ownerId, projectId, collection, idempotencyKey, data])).rows[0];
        if (prior) {
          if (prior.same_payload !== true)
            throw new ApiFailure(409, "IDEMPOTENCY_CONFLICT", "同一提交标识对应了不同内容。");
          return { id: prior.id as string, accepted: true as const, replayed: true };
        }
        const count = (await client.query("SELECT count(*)::int AS n FROM nano.app_records WHERE owner_id=$1 AND project_id=$2", [ownerId, projectId])).rows[0].n as number;
        if (count >= 10_000) throw new ApiFailure(429, "APP_DATA_LIMIT", "这个应用已达到数据记录上限，请先导出或清理旧记录。");
        const recent = (await client.query("SELECT count(*)::int AS n FROM nano.app_records WHERE owner_id=$1 AND project_id=$2 AND created_at>now()-interval '1 hour'", [ownerId, projectId])).rows[0].n as number;
        if (recent >= 1_000) throw new ApiFailure(429, "APP_DATA_RATE_LIMIT", "这个应用近期提交较多，请稍后重试。", true);
        const inserted = (await client.query(`INSERT INTO nano.app_records
          (id,owner_id,project_id,collection,idempotency_key,unique_key,payload_json)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,collection,unique_key) DO NOTHING RETURNING id`,
        [randomUUID(), ownerId, projectId, collection, idempotencyKey, uniqueKey, data])).rows[0];
        if (!inserted) throw new ApiFailure(409, kind === "appointments" ? "SLOT_TAKEN" : "ALREADY_REGISTERED",
          kind === "appointments" ? "这个时段已被预约，请选择其他时间。" : "这个邮箱已报名该活动类别。");
        return { id: inserted.id as string, accepted: true as const, replayed: false };
      });
    },
    bookedSlots: (ownerId: string, projectId: string, date: string): Promise<string[]> =>
      database.owned(ownerId, async (client) => {
        const rows = (await client.query(`SELECT payload_json->>'time' AS time FROM nano.app_records
          WHERE owner_id=$1 AND project_id=$2 AND collection='bookings' AND payload_json->>'date'=$3 ORDER BY time`,
        [ownerId, projectId, date])).rows;
        return rows.map((row) => row.time as string);
      }),
    list: (ownerId: string, projectId: string, kind: AppDataKind, offset = 0, limit = 50) =>
      database.owned(ownerId, async (client) => {
        const profile = (await client.query("SELECT kind FROM nano.app_data_profiles WHERE owner_id=$1 AND project_id=$2", [ownerId, projectId])).rows[0];
        if (profile?.kind !== kind) throw new ApiFailure(404, "NOT_FOUND", "找不到这个应用数据集合。");
        const rows = (await client.query(`SELECT id,collection,payload_json,confirmed,created_at,updated_at
          FROM nano.app_records WHERE owner_id=$1 AND project_id=$2 AND collection=$3
          ORDER BY created_at DESC,id DESC OFFSET $4 LIMIT $5`,
        [ownerId, projectId, collectionFor(kind), offset, limit + 1])).rows as RecordRow[];
        return { records: rows.slice(0, limit).map(record), nextOffset: rows.length > limit ? offset + limit : null };
      }),
    setConfirmed: (ownerId: string, projectId: string, id: string, confirmed: boolean): Promise<AppRecord> =>
      database.owned(ownerId, async (client) => {
        const row = (await client.query(`UPDATE nano.app_records SET confirmed=$4,updated_at=now()
          WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING id,collection,payload_json,confirmed,created_at,updated_at`,
        [ownerId, projectId, id, confirmed])).rows[0] as RecordRow | undefined;
        if (!row) throw new ApiFailure(404, "NOT_FOUND", "找不到这条记录。");
        return record(row);
      }),
    remove: (ownerId: string, projectId: string, id: string): Promise<void> =>
      database.owned(ownerId, async (client) => {
        const removed = await client.query("DELETE FROM nano.app_records WHERE owner_id=$1 AND project_id=$2 AND id=$3 RETURNING id", [ownerId, projectId, id]);
        if (!removed.rowCount) throw new ApiFailure(404, "NOT_FOUND", "找不到这条记录。");
      }),
  };
}
