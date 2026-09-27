import { expect, test } from "vitest";
import type { Revision } from "@pivloom/contracts";
import { acceptedVersionNumber, displayRevision, snapshotLabel } from "./revision-label";

const revision = (revisionNo: number, status: Revision["status"]): Revision => ({
  id: `00000000-0000-4000-8000-${String(revisionNo).padStart(12, "0")}`,
  projectId: "00000000-0000-4000-8000-000000000100",
  runId: `00000000-0000-4000-8000-${String(revisionNo + 100).padStart(12, "0")}`,
  revisionNo, attempt: 0, sourceHash: "a".repeat(64), templateVersion: "fixture",
  buildStatus: "passed", status, createdAt: "2026-09-25T00:00:00Z", manifest: [],
});

test("accepted versions count successful changes while failed source snapshots keep separate audit numbers", () => {
  const history = [revision(54, "accepted"), revision(53, "candidate"), revision(52, "accepted"),
    revision(50, "accepted"), revision(7, "accepted"), revision(6, "candidate"),
    revision(2, "accepted"), revision(1, "accepted")];
  expect(history.filter((item) => item.status === "accepted").slice(-3).map((item) => displayRevision(item, history)))
    .toEqual(["正式版 v3", "正式版 v2", "正式版 v1"]);
  expect(displayRevision(history[0], history)).toBe("正式版 v6");
  expect(snapshotLabel(history[0])).toBe("源码快照 #54");
  expect(displayRevision(history[1], history)).toBe("尝试 #53");
  expect(acceptedVersionNumber(history[0], null)).toBeNull();
  expect(displayRevision(history[0], null)).toBe("正式版 · 快照 #54");
});
