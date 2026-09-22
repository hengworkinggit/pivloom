"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { INITIAL_AUTH } from "./api-workspace";
import { getWorkspaceAuth } from "./workspace";
import { errorMessage } from "./utils";

export function useWorkspaceAuth() {
  const auth = getWorkspaceAuth();
  const snapshot = useSyncExternalStore(auth.subscribe, auth.getSnapshot, () => INITIAL_AUTH);
  useEffect(() => { void auth.initialize(); }, [auth]);
  return { ...snapshot, auth };
}

/** A query belongs to one identity epoch and one loader, never to a later login. */
export function usePrivateQuery<T>(loader: () => Promise<T>) {
  const { epoch, status } = useWorkspaceAuth();
  const [state, setState] = useState<{ epoch: number; loader: typeof loader; data?: T; error: string }>();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (status !== "authenticated") return;
    let active = true;
    loader().then((data) => {
      if (active) setState({ epoch, loader, data, error: "" });
    }).catch((error) => {
      if (active) setState({ epoch, loader, error: errorMessage(error) });
    });
    return () => { active = false; };
  }, [epoch, status, loader, version]);
  const current = status === "authenticated" && state?.epoch === epoch && state.loader === loader ? state : undefined;
  return { data: current?.data, error: current?.error ?? "", refresh };
}
