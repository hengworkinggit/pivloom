"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Adapted from Dyad's useCancellationRequestLatch at
 * https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/components/chat/useCancellationRequestLatch.ts
 * Copyright (c) Dyad contributors. Apache-2.0; see third_party/dyad.
 * Chat IDs became Run UUIDs; rejected HTTP requests can release the latch.
 */
export function useCancellationRequestLatch(options: {
  runId?: string;
  isActive: boolean;
  isCancellationSettling: boolean;
}) {
  const { runId, isActive, isCancellationSettling } = options;
  const requestedRunIdRef = useRef<string | null>(null);
  const observedSettlingRunIdRef = useRef<string | null>(null);
  const [requestedRunId, setRequestedRunId] = useState<string | null>(null);

  useEffect(() => {
    if (requestedRunIdRef.current !== null && requestedRunIdRef.current !== runId) {
      requestedRunIdRef.current = null;
      observedSettlingRunIdRef.current = null;
      setRequestedRunId(null);
    }
  }, [runId]);

  useEffect(() => {
    if (!runId || requestedRunIdRef.current !== runId) return;
    if (isCancellationSettling) {
      observedSettlingRunIdRef.current = runId;
      return;
    }
    if (!isActive || observedSettlingRunIdRef.current === runId) {
      requestedRunIdRef.current = null;
      observedSettlingRunIdRef.current = null;
      setRequestedRunId((current) => current === runId ? null : current);
    }
  }, [runId, isActive, isCancellationSettling]);

  const requestCancellation = useCallback(() => {
    if (!runId || requestedRunIdRef.current === runId) return false;
    requestedRunIdRef.current = runId;
    observedSettlingRunIdRef.current = null;
    setRequestedRunId(runId);
    return true;
  }, [runId]);

  const releaseRejectedRequest = useCallback(() => {
    if (!runId || requestedRunIdRef.current !== runId) return;
    requestedRunIdRef.current = null;
    observedSettlingRunIdRef.current = null;
    setRequestedRunId((current) => current === runId ? null : current);
  }, [runId]);

  return {
    isCancellationRequested: isCancellationSettling || requestedRunId === runId,
    requestCancellation,
    releaseRejectedRequest,
  };
}
