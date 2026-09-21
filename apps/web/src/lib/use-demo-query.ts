"use client";

import { useCallback, useEffect, useState } from "react";
import { demoApi } from "./mock-api";
import { errorMessage } from "./utils";

export function useDemoQuery<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((v) => v + 1), []);
  useEffect(() => {
    let mounted = true;
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const result = await loader();
        if (mounted && current === request) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (mounted && current === request) setError(errorMessage(e));
      }
    };
    void load();
    const unsubscribe = demoApi.subscribe(() => void load());
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [loader, refreshKey]);
  return { data, error, refresh };
}
