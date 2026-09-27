import type { Revision } from "@pivloom/contracts";

/** Public versions count only accepted results. revisionNo remains the immutable source-snapshot sequence. */
export function acceptedVersionNumber(revision: Revision, completeHistory: readonly Revision[] | null): number | null {
  if (revision.status !== "accepted" || !completeHistory) return null;
  const accepted = completeHistory.filter((item) => item.status === "accepted")
    .sort((a, b) => a.revisionNo - b.revisionNo);
  const index = accepted.findIndex((item) => item.id === revision.id);
  return index < 0 ? null : index + 1;
}

export function displayRevision(revision: Revision, completeHistory: readonly Revision[] | null, english = false): string {
  if (revision.status !== "accepted") return english ? `Attempt #${revision.revisionNo}` : `尝试 #${revision.revisionNo}`;
  const version = acceptedVersionNumber(revision, completeHistory);
  if (version !== null) return english ? `Version ${version}` : `正式版 v${version}`;
  return english ? `Accepted · snapshot #${revision.revisionNo}` : `正式版 · 快照 #${revision.revisionNo}`;
}

export function snapshotLabel(revision: Revision, english = false): string {
  return english ? `Source snapshot #${revision.revisionNo}` : `源码快照 #${revision.revisionNo}`;
}
