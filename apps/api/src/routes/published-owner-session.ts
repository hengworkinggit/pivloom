import { randomBytes } from "node:crypto";

interface BoundSession { ownerId: string; projectId: string; sessionId: string; expiresAt: number }
const cookieName = "pivloom_published_owner";
const ownerAccessDuration = 12 * 60 * 60 * 1000;

/** Opaque, project-bound cookie for an owner's published app. Generated app
 * code never receives the workbench JWT, password or one-time exchange grant. */
export function createPublishedOwnerSessions(isSessionActive: (ownerId: string, sessionId: string) => Promise<boolean>) {
  const grants = new Map<string, BoundSession>();
  const cookies = new Map<string, BoundSession>();
  const token = () => randomBytes(32).toString("hex");
  const parseCookie = (header: string | undefined) => (header ?? "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? "";
  const attributes = (age: number) => `Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${age}`;
  function prune() {
    const now = Date.now();
    for (const [key, item] of grants) if (item.expiresAt <= now) grants.delete(key);
    for (const [key, item] of cookies) if (item.expiresAt <= now) cookies.delete(key);
  }
  return {
    async issue(ownerId: string, projectId: string, sessionId: string) {
      if (!await isSessionActive(ownerId, sessionId)) return null;
      prune();
      const grant = token();
      grants.set(grant, { ownerId, projectId, sessionId, expiresAt: Date.now() + 60_000 });
      return grant;
    },
    async exchange(grant: string, projectId: string) {
      const bound = grants.get(grant);
      grants.delete(grant);
      if (!bound || bound.projectId !== projectId || bound.expiresAt <= Date.now()
        || !await isSessionActive(bound.ownerId, bound.sessionId)) return null;
      const cookie = token();
      cookies.set(cookie, { ...bound, expiresAt: Date.now() + ownerAccessDuration });
      return `${cookieName}=${cookie}; ${attributes(Math.floor(ownerAccessDuration / 1000))}`;
    },
    async owner(cookieHeader: string | undefined, projectId: string) {
      const cookie = parseCookie(cookieHeader);
      const bound = cookies.get(cookie);
      if (!bound || bound.projectId !== projectId) return null;
      if (bound.expiresAt <= Date.now() || !await isSessionActive(bound.ownerId, bound.sessionId)) {
        cookies.delete(cookie);
        return null;
      }
      return bound.ownerId;
    },
    clear(cookieHeader: string | undefined) {
      cookies.delete(parseCookie(cookieHeader));
      return `${cookieName}=; ${attributes(0)}`;
    },
  };
}
