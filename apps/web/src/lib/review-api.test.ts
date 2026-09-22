import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createApiWorkspace, type IdentityPort } from "./api-workspace";
import { createGenerationApi } from "./generation-api";

afterEach(() => vi.unstubAllGlobals());

const owner = "1e5dce44-654d-4352-bb4b-7680138c1135";
const revisionId = "09d00eb6-661f-4ed7-9e96-a46f4e2c800e";
const check = {
  id: "29b07531-d902-4fa0-b1b8-65d52c908cbb", runId: "74b24d87-1342-4d43-8c4e-f82e766a0633",
  roleRunId: "e861ce71-b069-44df-b13b-7c462265d8ee", attempt: 0, revisionId, sourceHash: "a".repeat(64),
  sandboxId: "fixture-sandbox", browserSessionId: "fixture-review-session", verdict: "failed",
  items: [{ behaviorId: "B01", verdict: "failed", expected: "报名记录出现在列表中", actual: "提交后没有新增记录",
    observationEventIds: ["17a2b292-e2a0-4296-a841-f6a2d036e94a"], screenshotIds: [], reproSteps: ["填写姓名", "提交报名"] }],
  summary: "报名提交尚未达到预期。", artifacts: [], createdAt: "2026-09-22T00:00:00.000Z",
};

function identity(): IdentityPort {
  const session = { userId: owner, accessToken: "fixture-review-token" };
  return { getSession: async () => session, getUser: async () => ({ id: owner }), signIn: async () => session,
    refreshSession: async () => session, signOut: async () => {}, subscribe: () => () => {} };
}

it("reads a saved check through the authenticated revision HTTP boundary", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const workspace = createApiWorkspace(identity(), async (input, init) => {
    if (String(input).endsWith("/me")) return Response.json({ user: { id: owner, name: "Owner", email: "owner@example.test" } });
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    return Response.json({ check });
  });
  await workspace.initialize();
  try {
    expect(await createGenerationApi(workspace).getCheck(revisionId)).toEqual(check);
    expect(requests).toEqual([{ url: `/api/v1/revisions/${revisionId}/check`, authorization: "Bearer fixture-review-token" }]);
  } finally { workspace.dispose(); }
});

it("refreshes authentication before loading a private screenshot and verifies its saved hash", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const requests: { url: string; authorization: string | null }[] = [];
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqqEAAAAASUVORK5CYII="), (letter) => letter.charCodeAt(0));
  const artifact = { id: "9d3a8a11-f37b-41ca-8c21-b5657085b494", mimeType: "image/png" as const,
    sha256: "101070e7bd1de3933a1fee8c8ecc791c7a58eacbae4d9d41ab8e1d7e17cd4326" };
  const workspace = createApiWorkspace({ ...identity(), refreshSession: async () => ({ userId: owner, accessToken: "fixture-refreshed" }) }, async (input, init) => {
    if (String(input).endsWith("/me")) return Response.json({ user: { id: owner, name: "Owner", email: "owner@example.test" } });
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    if (requests.length === 1) return Response.json({}, { status: 401 });
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  });
  await workspace.initialize();
  try {
    const image = await createGenerationApi(workspace).getArtifact(check.id, artifact);
    expect(image.type).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    expect(requests).toEqual([
      { url: `/api/v1/checks/${check.id}/artifacts/${artifact.id}`, authorization: "Bearer fixture-review-token" },
      { url: `/api/v1/checks/${check.id}/artifacts/${artifact.id}`, authorization: "Bearer fixture-refreshed" },
    ]);
  } finally { workspace.dispose(); }
});

it("rejects oversized UTF-8 check items at the public response boundary with a readable error", async () => {
  const oversized = { ...check, items: Array.from({ length: 5 }, (_, index) => ({ ...check.items[0], behaviorId: `B0${index + 1}`,
    expected: "测".repeat(2000), actual: "试".repeat(2000), reproSteps: Array.from({ length: 8 }, () => "步".repeat(500)) })) };
  const workspace = createApiWorkspace(identity(), async (input) => String(input).endsWith("/me")
    ? Response.json({ user: { id: owner, name: "Owner", email: "owner@example.test" } }) : Response.json({ check: oversized }));
  await workspace.initialize();
  try {
    await expect(createGenerationApi(workspace).getCheck(revisionId).then(() => "accepted", (error: Error) => error.message)).resolves.toContain("检查记录格式不正确");
  } finally { workspace.dispose(); }
});
