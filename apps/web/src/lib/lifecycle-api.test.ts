import { afterEach, expect, it } from "vitest";
import { CreateRunRequestSchema } from "@pivloom/contracts";
import { createApiWorkspace, type IdentityPort } from "./api-workspace";
import { createGenerationApi } from "./generation-api";

afterEach(() => sessionStorage.clear());

function workspaceWith(respond: (path: string, init?: RequestInit) => Response) {
  const owner = "1e5dce44-654d-4352-bb4b-7680138c1135";
  const session = { userId: owner, accessToken: "fixture-session" };
  const identity: IdentityPort = {
    getSession: async () => session, getUser: async () => ({ id: owner }), signIn: async () => session,
    refreshSession: async () => session, signOut: async () => {}, subscribe: () => () => {},
  };
  const calls: { path: string; key: string | null; body: unknown }[] = [];
  const workspace = createApiWorkspace(identity, async (input, init) => {
    const path = String(input);
    if (path.endsWith("/me")) return Response.json({ user: { id: owner, name: "Owner", email: "owner@example.test" } });
    calls.push({ path, key: new Headers(init?.headers).get("Idempotency-Key"), body: init?.body ? JSON.parse(String(init.body)) : null });
    return respond(path, init);
  });
  return { workspace, calls, owner };
}

it("stops a run through the durable cancel endpoint, not a browser-side abort", async () => {
  const { workspace, calls } = workspaceWith(() => Response.json({
    runId: "74b24d87-1342-4d43-8c4e-f82e766a0633", state: "cancel_requested", phase: "cleanup", cleanupState: "pending",
  }));
  await workspace.initialize();
  const run = await createGenerationApi(workspace).cancel("74b24d87-1342-4d43-8c4e-f82e766a0633");
  expect(run).toEqual({ runId: "74b24d87-1342-4d43-8c4e-f82e766a0633", state: "cancel_requested", phase: "cleanup", cleanupState: "pending" });
  expect(calls[0]?.path).toBe("/api/v1/runs/74b24d87-1342-4d43-8c4e-f82e766a0633/cancel");
  // Every mutating request is idempotent so a retry can never stop twice.
  expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  workspace.dispose();
});

it("restores a preview by revision and reports the rebuilding state", async () => {
  const revisionId = "0c7f0dbb-0d1a-4f1c-9a4e-2a1f0a7c4c11";
  const { workspace, calls } = workspaceWith(() => Response.json({
    operationId: "1d5a2f5a-6a1e-4a5c-9f2d-6a4b8c0e3f21",
    preview: { state: "restoring", revisionId, sourceHash: "a".repeat(64), url: null, expiresAt: null, error: "正在从已保存的源码重建预览，不会调用模型。" },
  }));
  await workspace.initialize();
  const result = await createGenerationApi(workspace).restorePreview("bdaea1e8-29f7-4716-b540-7f1b9cb3dce9", revisionId);
  expect(result.preview.state).toBe("restoring");
  expect(calls[0]?.path).toBe("/api/v1/projects/bdaea1e8-29f7-4716-b540-7f1b9cb3dce9/preview/restore");
  expect(calls[0]?.body).toEqual({ revisionId });
  expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  workspace.dispose();
});

it("accepts a retry body that links the failed run and no clarification parent", () => {
  const parsed = CreateRunRequestSchema.parse({
    text: "创建读书清单", expectedCurrentRevisionId: null, modelProfileId: "438088cb-5fd0-4704-ad57-3b64ed47c55f",
    modelConfigVersion: 1, retryOfRunId: "74b24d87-1342-4d43-8c4e-f82e766a0633", parentRunId: null,
  });
  expect(parsed.retryOfRunId).toBe("74b24d87-1342-4d43-8c4e-f82e766a0633");
  expect(parsed.parentRunId).toBeNull();
  // A retry and a clarification answer are mutually exclusive by construction.
  expect(() => CreateRunRequestSchema.parse({
    text: "创建读书清单", expectedCurrentRevisionId: null, modelProfileId: "438088cb-5fd0-4704-ad57-3b64ed47c55f",
    modelConfigVersion: 1, retryOfRunId: "74b24d87-1342-4d43-8c4e-f82e766a0633", parentRunId: "74b24d87-1342-4d43-8c4e-f82e766a0634",
  })).toThrow();
});
