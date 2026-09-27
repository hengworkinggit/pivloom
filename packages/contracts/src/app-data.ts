import { z } from "zod";

export const PublicAppDataKindSchema = z.enum(["event-signup", "appointments"]);
export const PersonalAppDataKindSchema = z.enum(["reading-list", "task-board"]);
export const AppDataKindSchema = z.enum(["event-signup", "appointments", "reading-list", "task-board"]);
export type AppDataKind = z.infer<typeof AppDataKindSchema>;
export type PublicAppDataKind = z.infer<typeof PublicAppDataKindSchema>;
export type PersonalAppDataKind = z.infer<typeof PersonalAppDataKindSchema>;
export const EventCategorySchema = z.enum(["创意沙龙", "产品分享", "周末工作坊"]);
export const AppointmentTimeSchema = z.enum(["09:00", "10:30", "13:00", "14:30", "16:00"]);

export const RegistrationSubmissionSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(160),
  category: EventCategorySchema,
});
export const BookingSubmissionSchema = z.strictObject({
  date: z.iso.date(),
  time: AppointmentTimeSchema,
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().min(3).max(160),
});
export type RegistrationSubmission = z.infer<typeof RegistrationSubmissionSchema>;
export type BookingSubmission = z.infer<typeof BookingSubmissionSchema>;

export const RegistrationRecordSchema = RegistrationSubmissionSchema.extend({
  id: z.uuid(), collection: z.literal("registrations"), confirmed: z.boolean(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export const BookingRecordSchema = BookingSubmissionSchema.extend({
  id: z.uuid(), collection: z.literal("bookings"), confirmed: z.boolean(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export const AppRecordSchema = z.discriminatedUnion("collection", [RegistrationRecordSchema, BookingRecordSchema]);
export type AppRecord = z.infer<typeof AppRecordSchema>;
export const AppRecordsResponseSchema = z.object({ records: z.array(AppRecordSchema), nextOffset: z.number().int().nonnegative().nullable() });
export const AppSubmissionResponseSchema = z.object({ id: z.uuid(), accepted: z.literal(true), replayed: z.boolean() });
export const BookedSlotsResponseSchema = z.object({ date: z.iso.date(), occupied: z.array(AppointmentTimeSchema) });

export const ReadingListValueSchema = z.array(z.strictObject({
  id: z.uuid(), title: z.string().trim().min(1).max(200), author: z.string().trim().min(1).max(160),
  status: z.enum(["想读", "在读", "已读"]),
})).max(1000);
export const TaskBoardValueSchema = z.array(z.strictObject({
  id: z.uuid(), title: z.string().trim().min(1).max(200),
  stage: z.enum(["待办", "进行中", "已完成"]), priority: z.enum(["普通", "重要", "紧急"]),
})).max(1000);
export const PrivateStateResponseSchema = z.object({
  version: z.number().int().nonnegative(), value: z.array(z.unknown()),
});
