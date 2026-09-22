import { afterEach, expect, it } from "vitest";
import { createApiWorkspace, type IdentityPort } from "./api-workspace";
import { createGenerationApi, savePendingSubmission, readPendingSubmission, clearPendingSubmission } from "./generation-api";

afterEach(() => sessionStorage.clear());

it("replays an unknown submission with its frozen body and key through the authenticated HTTP boundary", async () => {
  const owner = "1e5dce44-654d-4352-bb4b-7680138c1135";
  const project = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
  const session = { userId: owner, accessToken: "fixture-session" };
  const identity: IdentityPort = {
    getSession: async () => session, getUser: async () => ({ id: owner }), signIn: async () => session,
    refreshSession: async () => session, signOut: async () => {}, subscribe: () => () => {},
  };
  const requests: { key: string | null; body: unknown }[] = [];
  const workspace = createApiWorkspace(identity, async (input, init) => {
    if (String(input).endsWith("/me")) return Response.json({ user: { id: owner, name: "Owner", email: "owner@example.test" } });
    requests.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: JSON.parse(String(init?.body)) });
    if (requests.length === 1) throw new TypeError("Connection lost after the server accepted the run");
    return Response.json({ runId: "74b24d87-1342-4d43-8c4e-f82e766a0633", state: "accepted", eventsUrl: "/api/v1/runs/fixture/events", replayed: true });
  });
  await workspace.initialize();
  const generation = createGenerationApi(workspace);
  const pending = {
    key: "b14a806a-5cfb-43be-b3b7-828c772c2de7",
    body: { text: "创建读书清单", expectedCurrentRevisionId: null, modelProfileId: "438088cb-5fd0-4704-ad57-3b64ed47c55f", modelConfigVersion: 1, retryOfRunId: null, parentRunId: null },
  };
  savePendingSubmission(owner, project, pending);
  await expect(generation.start(project, pending)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  const restored = readPendingSubmission(owner, project);
  expect(readPendingSubmission("other-owner", project)).toBeNull();
  expect(restored).toEqual(pending);
  if (!restored) throw new Error("The accepted-or-unknown request must survive a refresh");
  expect((await generation.start(project, restored)).replayed).toBe(true);
  expect(requests).toEqual([{ key: pending.key, body: pending.body }, { key: pending.key, body: pending.body }]);
  clearPendingSubmission(owner, project);
  expect(readPendingSubmission(owner, project)).toBeNull();
  workspace.dispose();
});
