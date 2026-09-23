import { expect, it, vi } from "vitest";
import { createRollbackApi } from "./rollback-api";

const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
const from = "810a101e-e123-4dad-90a7-cbbfae291903";
const target = "09d00eb6-661f-4ed7-9e96-a46f4e2c800e";
const operationId = "34ad0f62-4be5-486d-a75e-78a35191a1c2";
const key = "62ad0f62-4be5-486d-a75e-78a35191a1c2";
const response = { operation: { id: operationId, projectId, fromRevisionId: from, targetRevisionId: target,
  sourceHash: "a".repeat(64), status: "preparing", error: null,
  createdAt: "2026-09-24T00:00:00.000Z", finishedAt: null }, replayed: false };

it("sends the exact rollback CAS pair and stable idempotency key, then reads/cancels the same operation", async () => {
  const request = vi.fn(async () => response);
  const api = createRollbackApi({ request });
  expect((await api.start(projectId, { targetRevisionId: target, expectedCurrentRevisionId: from }, key)).operation.id).toBe(operationId);
  expect(request).toHaveBeenNthCalledWith(1, `/projects/${projectId}/rollback`, {
    method: "POST", headers: { "Idempotency-Key": key },
    body: JSON.stringify({ targetRevisionId: target, expectedCurrentRevisionId: from }),
  });
  await api.status(projectId, operationId);
  expect(request).toHaveBeenNthCalledWith(2, `/projects/${projectId}/rollback/${operationId}`);
  await api.cancel(projectId, operationId);
  expect(request).toHaveBeenNthCalledWith(3, `/projects/${projectId}/rollback/${operationId}/cancel`, { method: "POST" });
});

it("rejects an incomplete rollback request before any network call", async () => {
  const request = vi.fn(async () => response);
  const api = createRollbackApi({ request });
  await expect(api.start(projectId, { targetRevisionId: target } as never, key)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
