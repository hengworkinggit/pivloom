import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiWorkspace } from "./api-workspace";
import { useRollback } from "./use-rollback";

const ownerId = "1e5dce44-654d-4352-bb4b-7680138c1135";
const projectId = "bdaea1e8-29f7-4716-b540-7f1b9cb3dce9";
const from = "810a101e-e123-4dad-90a7-cbbfae291903";
const target = "09d00eb6-661f-4ed7-9e96-a46f4e2c800e";
const operationId = "34ad0f62-4be5-486d-a75e-78a35191a1c2";
const now = "2026-09-24T00:00:00.000Z";
const operation = (status: "preparing" | "committed" | "cancelled") => ({ id: operationId, projectId,
  fromRevisionId: from, targetRevisionId: target, sourceHash: "a".repeat(64), status, error: null,
  createdAt: now, finishedAt: status === "preparing" ? null : now });

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; document.body.replaceChildren(); sessionStorage.clear(); vi.unstubAllGlobals();
});

it("restores an uncertain submission after reload, reuses its key, then refreshes only after committed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  const calls: { path: string; key: string | null }[] = [];
  let posts = 0;
  const request: ApiWorkspace["request"] = async (path, init) => {
    calls.push({ path, key: new Headers(init?.headers).get("Idempotency-Key") });
    if (path === `/projects/${projectId}/rollback`) {
      posts++;
      if (posts === 1) throw new TypeError("network lost after send");
      return { operation: operation("preparing"), replayed: true };
    }
    if (path === `/projects/${projectId}/rollback/${operationId}`) return { operation: operation("committed"), replayed: true };
    throw new Error(`unexpected ${path}`);
  };
  const api = { request };
  const onCommitted = vi.fn(async () => {});
  let state!: ReturnType<typeof useRollback>;
  function Harness() {
    state = useRollback({ api, ownerId, projectId, onCommitted });
    return <p>{state.unknown ? "uncertain" : state.operation?.status ?? "idle"}</p>;
  }
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  await act(async () => { await state.start(target, from); });
  expect(state.unknown).toBe(true);
  const saved = JSON.parse(sessionStorage.getItem(`pivloom.rollback.v1:${ownerId}:${projectId}`)!) as { key: string };
  expect(saved.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(onCommitted).not.toHaveBeenCalled();

  await act(async () => root?.unmount()); root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  expect(container.textContent).toBe("uncertain");
  await act(async () => { await state.confirm(); });
  await act(async () => { await vi.waitFor(() => expect(onCommitted).toHaveBeenCalledWith(target)); });
  expect(calls.filter((call) => call.path === `/projects/${projectId}/rollback`).map((call) => call.key)).toEqual([saved.key, saved.key]);
  expect(state.operation?.status).toBe("committed");
  expect(state.busy).toBe(false);
  expect(sessionStorage.getItem(`pivloom.rollback.v1:${ownerId}:${projectId}`)).toBeNull();
});

it("does not confuse a cancelled preparation with a successful version switch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  const request: ApiWorkspace["request"] = async (path) => {
    if (path === `/projects/${projectId}/rollback`) return { operation: operation("preparing"), replayed: false };
    if (path === `/projects/${projectId}/rollback/${operationId}/cancel`) return { operation: operation("cancelled"), replayed: true };
    if (path === `/projects/${projectId}/rollback/${operationId}`) return new Promise(() => {});
    throw new Error(`unexpected ${path}`);
  };
  const api = { request }, onCommitted = vi.fn();
  let state!: ReturnType<typeof useRollback>;
  function Harness() { state = useRollback({ api, ownerId, projectId, onCommitted }); return <p>{state.operation?.status}</p>; }
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  await act(async () => { await state.start(target, from); });
  await act(async () => { await state.cancel(); });
  expect(state.operation?.status).toBe("cancelled");
  expect(state.busy).toBe(false);
  expect(onCommitted).not.toHaveBeenCalled();
});
