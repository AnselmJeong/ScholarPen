import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeStatus } from "@shared/claude";
import { rpc } from "../rpc";

export function useClaudeStatus(enabled: boolean) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const epoch = useRef(0);
  const checking = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    const requestEpoch = epoch.current;
    if (!enabled || checking.current === requestEpoch) return;
    checking.current = requestEpoch;
    try {
      const next = await rpc.getClaudeStatus();
      if (epoch.current === requestEpoch) setStatus(next);
    } catch (error) {
      if (epoch.current === requestEpoch) setStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
    } finally { if (checking.current === requestEpoch) checking.current = null; }
  }, [enabled]);
  useEffect(() => {
    epoch.current++; setStatus(null);
    void refresh();
    if (!enabled) return () => { epoch.current++; };
    const timer = setInterval(() => { void refresh(); }, 10_000);
    window.addEventListener("focus", refresh);
    return () => { epoch.current++; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [enabled, refresh]);
  useEffect(() => {
    if (status?.state !== "signingIn") return;
    const timer = setInterval(() => { void refresh(); }, 2_000);
    return () => clearInterval(timer);
  }, [status?.state, refresh]);
  return { status: enabled ? status : null, refresh };
}
