"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createLiveRefresh } from "@/lib/liveRefresh";

/** Pass a memoized loader. Changing it resets the resource and invalidates
 * in-flight requests, including React Strict Mode's first effect run. */
export function useLiveData<T>(load: () => Promise<T>) {
  const [snapshot, setSnapshot] = useState<{ load: typeof load; data: T } | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    const resource = createLiveRefresh(load, (data) => setSnapshot({ load, data }));
    refreshRef.current = resource.refresh;
    void resource.refresh();
    return () => resource.dispose();
  }, [load]);

  return { data: snapshot?.load === load ? snapshot.data : null, refresh };
}
