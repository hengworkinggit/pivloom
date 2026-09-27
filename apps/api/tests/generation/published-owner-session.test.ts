import { describe, expect, test } from "vitest";
import { createPublishedOwnerSessions } from "../../src/routes/published-owner-session.js";

describe("published owner sessions", () => {
  test("one-time grants bind a host cookie to its project and live login", async () => {
    let active = true;
    const sessions = createPublishedOwnerSessions(async (owner, session) =>
      active && owner === "owner-a" && session === "login-a");
    const grant = await sessions.issue("owner-a", "project-a", "login-a");
    expect(grant).toMatch(/^[a-f0-9]{64}$/);
    expect(await sessions.exchange(grant!, "project-b")).toBeNull();
    expect(await sessions.exchange(grant!, "project-a")).toBeNull();
    const next = await sessions.issue("owner-a", "project-a", "login-a");
    const setCookie = await sessions.exchange(next!, "project-a");
    expect(setCookie).toContain("HttpOnly; SameSite=Lax; Secure");
    const cookie = setCookie!.split(";")[0];
    expect(await sessions.owner(cookie, "project-a")).toBe("owner-a");
    expect(await sessions.owner(cookie, "project-b")).toBeNull();
    active = false;
    expect(await sessions.owner(cookie, "project-a")).toBeNull();
  });
});
