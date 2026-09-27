export interface CandidateBaseSelection { revisionId: string; expectedCurrentRevisionId: string | null }
const key = (ownerId: string, projectId: string) => `pivloom.candidate-base.v2:${ownerId}:${projectId}`;
const legacyKey = (ownerId: string, projectId: string) => `pivloom.candidate-base.v1:${ownerId}:${projectId}`;

// A selection is an owner-scoped editing preference, never an accepted revision.
// Keep it across sign-out so returning users can explain the next request's base.
export function readCandidateBase(ownerId: string, projectId: string): CandidateBaseSelection | null {
  if (typeof window === "undefined") return null;
  try {
    // Earlier UI made this choice easy to leave behind without understanding it.
    // Discard that stored choice once; the next run starts from the accepted version.
    localStorage.removeItem(legacyKey(ownerId, projectId));
    const value: unknown = JSON.parse(localStorage.getItem(key(ownerId, projectId)) ?? "null");
    if (!value || typeof value !== "object" || !("revisionId" in value) || typeof value.revisionId !== "string"
      || !("expectedCurrentRevisionId" in value) || (value.expectedCurrentRevisionId !== null && typeof value.expectedCurrentRevisionId !== "string")) return null;
    return { revisionId: value.revisionId, expectedCurrentRevisionId: value.expectedCurrentRevisionId };
  } catch { return null; }
}

export function saveCandidateBase(ownerId: string, projectId: string, selection: CandidateBaseSelection | null): boolean {
  try {
    if (selection) localStorage.setItem(key(ownerId, projectId), JSON.stringify(selection));
    else localStorage.removeItem(key(ownerId, projectId));
    return true;
  } catch { return false; }
}
