"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TerminalRunStates, type ProjectDetailResponse, type RoleRun, type Run, type RunEvent } from "@pivloom/contracts";
import { getApiWorkspace } from "@/lib/workspace";
import { createGenerationApi } from "@/lib/generation-api";
import { WorkspaceError } from "@/lib/api-workspace";
import { mergeRunEvents } from "@/lib/run-events";
import { errorMessage } from "@/lib/utils";

function hasFinalProjectSnapshot(project: ProjectDetailResponse, run: Run) {
  const snapshotRun = project.activeRun ?? project.latestRun;
  return snapshotRun?.id === run.id && snapshotRun.state === run.state
    && snapshotRun.resultRevisionId === run.resultRevisionId
    && (!run.resultRevisionId || project.currentRevision?.id === run.resultRevisionId || project.latestCandidate?.id === run.resultRevisionId);
}

export function useGenerationState(projectId: string) {
  const workspace = getApiWorkspace();
  const generation = useMemo(() => createGenerationApi(workspace), [workspace]);
  const [view, setView] = useState<{ project: ProjectDetailResponse; run: Run | null; roles: RoleRun[]; events: RunEvent[] }>();
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<"idle" | "connecting" | "connected" | "polling" | "unavailable">("idle");
  const [acceptedRequestId, setAcceptedRequestId] = useState<string | null>(null);
  const alive = useRef(true);
  const sequence = useRef(0);
  const acceptedId = useRef<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  const refresh = useCallback(function requestSnapshot(): Promise<void> {
    if (inFlight.current) {
      // Preserve one trailing read (including a newly accepted run), without
      // superseding the response already on its way over a slow connection.
      refreshAgain.current = true;
      return inFlight.current;
    }
    const current = ++sequence.current;
    const load = async () => {
      try {
        let project = await workspace.getProject(projectId);
        const snapshotRun = project.activeRun ?? project.latestRun;
        const runId = acceptedId.current ?? snapshotRun?.id;
        const detail = runId ? await generation.getRun(runId) : null;
        // Completion can commit between the two reads. Re-read the project so
        // the terminal run is not published alongside its pre-result snapshot.
        if (detail && TerminalRunStates.has(detail.run.state) && !hasFinalProjectSnapshot(project, detail.run)) {
          project = await workspace.getProject(projectId);
        }
        if (!alive.current || current !== sequence.current) return;
        const acknowledgedId = acceptedId.current;
        // The owned run detail confirms acceptance even when another tab has
        // already advanced the project's latest run beyond this request.
        if (acknowledgedId && detail?.run.id === acknowledgedId && detail.run.projectId === projectId) {
          acceptedId.current = null;
          setAcceptedRequestId((pendingId) => pendingId === acknowledgedId ? null : pendingId);
        }
        const refreshedRun = project.activeRun ?? project.latestRun;
        const snapshotNamesParent = !!detail?.run.parentRunId && detail.run.parentRunId === refreshedRun?.id;
        // An accepted answer is newer than its needs-input parent. An unrelated
        // newer run named by the project still remains authoritative.
        const visibleRun = refreshedRun && refreshedRun.id !== detail?.run.id && !snapshotNamesParent ? refreshedRun : detail?.run ?? refreshedRun;
        // The project may already name another tab's newer run. Read that run's
        // role records once even when it is terminal and needs no regular poll.
        if (snapshotNamesParent || visibleRun && visibleRun.id !== detail?.run.id) refreshAgain.current = true;
        setView((previous) => {
          // A delayed snapshot cannot restart a run whose terminal result is
          // already visible, or discard its saved revision while reconnecting.
          if (previous?.run && visibleRun?.id === previous.run.id
            && TerminalRunStates.has(previous.run.state)
            && (visibleRun.state !== previous.run.state
              || visibleRun.resultRevisionId !== previous.run.resultRevisionId
              || previous.run.cleanupState === "confirmed" && visibleRun.cleanupState !== "confirmed"
              || hasFinalProjectSnapshot(previous.project, previous.run) && !hasFinalProjectSnapshot(project, visibleRun))) return previous;
          return {
            project, run: visibleRun,
            roles: detail && visibleRun?.id === detail.run.id ? detail.roles : [],
            events: detail && visibleRun?.id === detail.run.id ? mergeRunEvents(previous?.events ?? [], detail.events, detail.run.id) : [],
          };
        });
        setError("");
      } catch (reason) {
        if (alive.current && current === sequence.current) setError(errorMessage(reason));
      }
    };
    const pending = load().finally(() => {
      inFlight.current = null;
      const trailing = refreshAgain.current;
      refreshAgain.current = false;
      if (trailing && alive.current) void requestSnapshot();
    });
    inFlight.current = pending;
    return pending;
  }, [generation, projectId, workspace]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { alive.current = false; sequence.current += 1; window.removeEventListener("focus", focus); };
  }, [refresh]);

  const run = view?.run;
  const active = !!run && !TerminalRunStates.has(run.state);
  const awaitingAccepted = !!acceptedRequestId && run?.id !== acceptedRequestId;
  const awaitingCleanup = run?.cleanupState === "pending";
  const awaitingFinalSnapshot = !!view && !!run && TerminalRunStates.has(run.state) && !hasFinalProjectSnapshot(view.project, run);
  const connectionUnavailable = active && connection === "unavailable";
  useEffect(() => {
    // Cleanup can finish after the terminal event; keep reading until confirmed.
    if (connectionUnavailable) return;
    if (!active && !awaitingAccepted && !awaitingCleanup && !awaitingFinalSnapshot) return;
    const interval = setInterval(() => { void refresh(); }, 2500);
    return () => clearInterval(interval);
  }, [active, awaitingAccepted, awaitingCleanup, awaitingFinalSnapshot, connectionUnavailable, refresh, run?.id]);

  const cursor = useRef("0");
  const runId = run?.id;
  useEffect(() => {
    if (!active || !runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;
    cursor.current = "0";
    const connect = async () => {
      if (controller.signal.aborted) return;
      setConnection("connecting");
      try {
        await generation.events(runId, cursor.current, (event) => {
          if (controller.signal.aborted) return;
          cursor.current = event.eventId;
          backoff = 1000;
          setConnection("connected");
          setView((previous) => previous && previous.run?.id === event.runId
            ? { ...previous, events: mergeRunEvents(previous.events, [event], event.runId) } : previous);
          if (["run.phase", "role.started", "role.completed", "revision.saved", "preview.ready", "check.completed", "run.finished"].includes(event.type)) void refresh();
        }, controller.signal);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof WorkspaceError && reason.httpStatus === 404) {
          setConnection("unavailable");
          return;
        }
        // Other failures recover through the authoritative snapshot boundary.
      }
      if (controller.signal.aborted) return;
      setConnection("polling");
      void refresh();
      const retryDelay = Math.min(8000, Math.round(backoff * (0.9 + Math.random() * 0.2)));
      timer = setTimeout(() => { void connect(); }, retryDelay);
      backoff = Math.min(backoff * 2, 8000);
    };
    void connect();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, generation, refresh, runId]); // A phase update must not reopen the same connection.

  const accepted = async (runId: string) => {
    acceptedId.current = runId;
    setAcceptedRequestId(runId);
    await refresh();
  };
  return { view, error, connection: awaitingAccepted || awaitingFinalSnapshot ? "awaiting_snapshot" : active ? connection : "idle", active: active || awaitingAccepted || awaitingFinalSnapshot, generation, refresh, accepted };
}
