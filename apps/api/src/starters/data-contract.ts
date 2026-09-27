import { z } from "zod";
import { AppDataKindSchema, type AppDataKind } from "@pivloom/contracts";
import type { SourceBundle } from "../storage/source.js";
import { ApiFailure } from "../routes/errors.js";

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: AppDataKindSchema,
  collection: z.enum(["registrations", "bookings", "books", "tasks"]),
});
const collections: Record<AppDataKind, string> = {
  "event-signup": "registrations", appointments: "bookings",
  "reading-list": "books", "task-board": "tasks",
};

export function assertManagedDataSource(bundle: SourceBundle, kind: AppDataKind) {
  const manifest = bundle.files.find((file) => file.path === "pivloom.data.json");
  const runtime = bundle.files.find((file) => file.path === "src/pivloom-data.ts");
  const app = bundle.files.find((file) => file.path === "src/App.tsx");
  let declared: z.infer<typeof manifestSchema> | null = null;
  try { if (manifest) declared = manifestSchema.parse(JSON.parse(manifest.content)); }
  catch { /* Publication fails with one stable error below. */ }
  if (!declared || declared.kind !== kind || declared.collection !== collections[kind]
    || !runtime || !app?.content.includes("./pivloom-data"))
    throw new ApiFailure(409, "MANAGED_DATA_SOURCE_REQUIRED",
      "此版本没有完整的托管数据源码，不能作为在线应用发布；请更新模板后再发布。");
}
