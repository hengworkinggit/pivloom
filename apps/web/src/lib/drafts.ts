export const promptLimit = 8_000;
const prefix = "pivloom.draft.v1:";
const ownerPrefix = (ownerId: string) => `${prefix}${encodeURIComponent(ownerId)}:`;
const draftKey = (ownerId: string, projectId: string) => `${ownerPrefix(ownerId)}${encodeURIComponent(projectId)}`;

// A draft belongs to this tab's browser session, never to a model profile or message.
// Storage may be disabled; callers can keep their current React input without blocking work.
export function saveDraft(ownerId: string, projectId: string, value: string) {
  if (typeof window === "undefined") return false;
  try {
    if (value) window.sessionStorage.setItem(draftKey(ownerId, projectId), value);
    else window.sessionStorage.removeItem(draftKey(ownerId, projectId));
    return true;
  } catch { return false; }
}
export function readDraft(ownerId: string, projectId: string) {
  if (typeof window === "undefined") return "";
  try { return window.sessionStorage.getItem(draftKey(ownerId, projectId)) ?? ""; }
  catch { return ""; }
}
// A session-level model override: the chosen provider credential + catalog
// model the user picked in this browser session, applied to every run until
// changed. Runs still freeze (profileId, configVersion, modelId) on submit.
const sessionModelPrefix = "pivloom.session-model.v1:";
const sessionModelKey = (ownerId: string, projectId: string) => `${sessionModelPrefix}${encodeURIComponent(ownerId)}:${encodeURIComponent(projectId)}`;
export function saveSessionModel(ownerId: string, projectId: string, profileId: string, modelId: string | null) {
  if (typeof window === "undefined") return false;
  try {
    if (modelId) window.sessionStorage.setItem(sessionModelKey(ownerId, projectId), JSON.stringify({ profileId, modelId }));
    else window.sessionStorage.removeItem(sessionModelKey(ownerId, projectId));
    return true;
  } catch { return false; }
}
export function readSessionModel(ownerId: string, projectId: string): { profileId: string; modelId: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(sessionModelKey(ownerId, projectId));
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { profileId?: unknown }).profileId !== "string"
      || typeof (parsed as { modelId?: unknown }).modelId !== "string") return null;
    return { profileId: (parsed as { profileId: string }).profileId, modelId: (parsed as { modelId: string }).modelId };
  } catch { return null; }
}
export function clearDrafts(ownerId: string) {
  if (typeof window === "undefined") return;
  try {
    const storage = window.sessionStorage;
    const scopedPrefix = ownerPrefix(ownerId);
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(scopedPrefix)) storage.removeItem(key);
    }
  } catch { /* Protected views still clear immediately if browser storage is unavailable. */ }
}
