import { afterEach, describe, expect, test, vi } from "vitest";
import { activatePublishedOwner, clearVisitedPublishedOwners } from "./published-session";

afterEach(async () => { await clearVisitedPublishedOwners(async () => new Response(null, { status: 204 })); });

describe("published owner access", () => {
  test("exchanges a grant on the app origin and clears its host cookie on sign-out", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const url = "https://11111111-1111-4111-8111-111111111111.app.example.test/";
    expect(await activatePublishedOwner({ url, grant: "a".repeat(64) }, transport)).toBe(url);
    expect(transport).toHaveBeenCalledWith(`${url}__pivloom/session`, expect.objectContaining({
      method: "POST", credentials: "include", headers: { Authorization: `Published ${"a".repeat(64)}` },
    }));
    await clearVisitedPublishedOwners(transport);
    expect(transport).toHaveBeenCalledWith(`${url}__pivloom/session/clear`, expect.objectContaining({
      method: "POST", credentials: "include",
    }));
  });
  test("rejects a URL carrying credentials or a query before exchange", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(activatePublishedOwner({ url: "https://user:pass@app.example.test/?grant=oops", grant: "a".repeat(64) }, transport))
      .rejects.toThrow("已发布应用地址不正确");
    expect(transport).not.toHaveBeenCalled();
  });
});
