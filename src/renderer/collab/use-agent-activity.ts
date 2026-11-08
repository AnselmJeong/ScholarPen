import { useEffect, useState } from "react";
import { onCollabActivity, rpc } from "../rpc";
import type { AgentActivityMessage } from "../../shared/collab/agent-types";

/** The AI collaborator's job queue for one open document, kept current. */
export function useAgentActivity(docKey: string | null) {
  const [activity, setActivity] = useState<AgentActivityMessage | null>(null);
  useEffect(() => {
    if (!docKey) return;
    let cancelled = false;
    setActivity(null);
    rpc.collabAgentStatus(docKey)
      .then((status) => { if (!cancelled && status) setActivity(status); })
      .catch(() => undefined);
    const off = onCollabActivity((message) => {
      if (message.docKey === docKey) setActivity(message);
    });
    return () => { cancelled = true; off(); };
  }, [docKey]);
  return activity;
}
