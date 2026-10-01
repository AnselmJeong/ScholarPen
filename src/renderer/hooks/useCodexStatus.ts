import { useEffect, useState } from "react";
import type { CodexStatus } from "../../shared/codex";
import { rpc } from "../rpc";

export function useCodexStatus(enabled: boolean): CodexStatus | null {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!enabled) return;
    let cancelled = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const next = await rpc.getCodexStatus();
        if (!cancelled) setStatus(next);
      } catch (error) {
        if (!cancelled) setStatus({ state: "error", ordinaryUsageAllowed: null, quotas: [],
          error: error instanceof Error ? error.message : String(error) });
      } finally { checking = false; }
    };
    void check();
    const timer = setInterval(check, 10_000);
    window.addEventListener("focus", check);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("focus", check); };
  }, [enabled]);
  return enabled ? status : null;
}
