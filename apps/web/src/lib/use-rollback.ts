"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RollbackRequestSchema, type RollbackOperation, type RollbackRequest, type RollbackResponse } from "@pivloom/contracts";
import type { ApiWorkspace } from "./api-workspace";
import { WorkspaceError } from "./api-workspace";
import { createRollbackApi } from "./rollback-api";
import { errorMessage } from "./utils";

interface Submission { key: string; body: RollbackRequest; operationId?: string }
const terminal = new Set<RollbackOperation["status"]>(["committed", "failed", "cancelled"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageKey(ownerId: string, projectId: string) { return `pivloom.rollback.v1:${ownerId}:${projectId}`; }
function readSubmission(key: string): Submission | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as Partial<Submission> | null;
    const body = RollbackRequestSchema.safeParse(value?.body);
    return value && typeof value.key === "string" && uuid.test(value.key)
      && (!value.operationId || uuid.test(value.operationId)) && body.success
      ? { key: value.key, body: body.data, ...(value.operationId ? { operationId: value.operationId } : {}) } : null;
  } catch { return null; }
}

/** Re-reads a persisted operation after reload. An uncertain POST is only replayed
 * with its original key when the user explicitly asks to confirm its outcome. */
export function useRollback({ api, ownerId, projectId, onCommitted }: {
  api: Pick<ApiWorkspace, "request">; ownerId: string; projectId: string;
  onCommitted: (targetRevisionId: string) => Promise<void> | void;
}) {
  const rollback = useMemo(() => createRollbackApi(api), [api]);
  const key = storageKey(ownerId, projectId);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const submissionRef = useRef<Submission | null>(null);
  const [operation, setOperation] = useState<RollbackOperation | null>(null);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [settling, setSettling] = useState(false);
  const requesting = useRef(false);
  const notified = useRef<string | null>(null);

  useEffect(() => {
    const restored = readSubmission(key);
    if (restored && !submissionRef.current) {
      submissionRef.current = restored;
      setSubmission(restored);
    }
  }, [key]);

  const save = useCallback((value: Submission | null) => {
    submissionRef.current = value;
    setSubmission(value);
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
      setStorageWarning(false);
    } catch { if (value) setStorageWarning(true); }
  }, [key]);

  const accept = useCallback((response: RollbackResponse) => {
    const pending = submissionRef.current;
    if (!pending) return;
    const next = response.operation;
    if (next.projectId !== projectId || next.fromRevisionId !== pending.body.expectedCurrentRevisionId
      || next.targetRevisionId !== pending.body.targetRevisionId
      || pending.operationId && pending.operationId !== next.id) throw new Error("回滚操作与请求版本不一致，请重新读取项目。");
    setOperation(next);
    setError("");
    save(terminal.has(next.status) ? null : { ...pending, operationId: next.id });
  }, [projectId, save]);

  const submit = useCallback(async (pending: Submission) => {
    if (requesting.current) return;
    requesting.current = true;
    setError("");
    try { accept(await rollback.start(projectId, pending.body, pending.key)); }
    catch (reason) {
      // A definite client rejection did not start an operation. A timeout or
      // server error is uncertain and keeps the original key for replay.
      if (reason instanceof WorkspaceError && reason.httpStatus && reason.httpStatus >= 400 && reason.httpStatus < 500)
        save(null);
      setError(errorMessage(reason));
    }
    finally { requesting.current = false; }
  }, [accept, projectId, rollback, save]);

  const start = useCallback(async (targetRevisionId: string, expectedCurrentRevisionId: string) => {
    if (requesting.current || submissionRef.current) return;
    const pending: Submission = { key: crypto.randomUUID(), body: { targetRevisionId, expectedCurrentRevisionId } };
    setOperation(null);
    notified.current = null;
    save(pending);
    await submit(pending);
  }, [save, submit]);

  const confirm = useCallback(async () => {
    const pending = submissionRef.current;
    if (pending) await submit(pending);
  }, [submit]);

  const cancel = useCallback(async () => {
    const pending = submissionRef.current;
    if (!pending?.operationId || requesting.current || operation && terminal.has(operation.status)) return;
    requesting.current = true;
    try { accept(await rollback.cancel(projectId, pending.operationId)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { requesting.current = false; }
  }, [accept, operation, projectId, rollback]);

  const operationStatus = operation?.status;
  useEffect(() => {
    const operationId = submission?.operationId;
    if (!operationId || operationStatus && terminal.has(operationStatus)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const response = await rollback.status(projectId, operationId); if (active) accept(response); }
      catch (reason) { if (active) setError(errorMessage(reason)); }
      if (active) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [accept, operationStatus, projectId, rollback, submission?.operationId]);

  useEffect(() => {
    if (operation?.status === "committed" && notified.current !== operation.id) {
      notified.current = operation.id;
      setSettling(true);
      void Promise.resolve(onCommitted(operation.targetRevisionId)).catch((reason) => setError(errorMessage(reason)))
        .finally(() => setSettling(false));
    }
  }, [onCommitted, operation]);

  return { operation, error, storageWarning, busy: !!submission || settling, unknown: !!submission && !submission.operationId,
    start, confirm, cancel, clearResult: () => { if (!submissionRef.current) { setOperation(null); setError(""); } } };
}
