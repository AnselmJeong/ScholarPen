/** One unit of AI work on a document, as shown in the Activity panel. */
export interface AgentJobView {
  id: string;
  docKey: string;
  kind: "comment" | "review" | "draft";
  label: string;
  state: "queued" | "waiting" | "working" | "done" | "failed" | "cancelled";
  threadId?: string;
  blockId?: string;
  /** Persona that runs the job (stage 6). */
  agent?: string;
  detail?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface AgentActivityMessage {
  docKey: string;
  jobs: AgentJobView[];
  paused: boolean;
  canUndo: boolean;
}
