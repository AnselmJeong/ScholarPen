import { open } from "node:fs/promises";
import type { ReviewProgress, ReviewSession } from "../../shared/review-session/types";
import { scopedPath } from "./workspace";
export const REVIEW_CALL_TIMEOUT_MS = 12 * 60_000;
export interface LiveReviewOutput { stage: string; startedAt: string; receivedCharacters: number; lastOutputAt?: string }

/** Only operational metadata leaves the backend; never prompts, manuscript text or model reasoning. */
export function progressFromJournal(session: ReviewSession, journal: string, live?: LiveReviewOutput): ReviewProgress {
  const result: ReviewProgress = { checkedAt: new Date().toISOString(), recent: [] };
  for (const line of journal.split("\n")) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)) || typeof e.kind !== "string") continue;
    const stage = typeof e.stage === "string" ? e.stage : "";
    if (e.kind === "run-start") { result.runStartedAt = e.at; result.activeCall = undefined; }
    if (e.kind === "stage-start") { result.stageStartedAt = e.at; result.activeCall = undefined; }
    if (e.kind === "model-start") {
      result.runStartedAt ??= e.at;
      result.activeCall = { stage, provider: String(e.provider ?? ""), model: String(e.model ?? ""),
        startedAt: e.at, attempt: typeof e.attempt === "number" ? e.attempt : 1, timeoutMs: REVIEW_CALL_TIMEOUT_MS };
    }
    if (["model-complete", "model-error", "schema-error"].includes(e.kind) && result.activeCall?.stage === stage) result.activeCall = undefined;
    if (e.kind === "model-complete" || e.kind === "cache-used") result.lastCompleted = { stage, at: e.at };
    if (e.kind === "stopped") result.activeCall = undefined;
    if (["run-start", "stage-start", "model-start", "model-complete", "model-error", "schema-error", "cache-used", "author-check", "review-warning", "stopped"].includes(e.kind)) {
      result.recent.push({ at: e.at, kind: e.kind, stage, ...(typeof e.attempt === "number" ? { attempt: e.attempt } : {}) });
    }
  }
  result.recent = result.recent.slice(-8);
  if (session.status !== "running") result.activeCall = undefined;
  if (result.activeCall && live?.stage === result.activeCall.stage && Date.parse(live.startedAt) >= Date.parse(result.activeCall.startedAt)) {
    result.activeCall.receivedCharacters = live.receivedCharacters;
    result.activeCall.lastOutputAt = live.lastOutputAt;
  }
  return result;
}

export async function readReviewProgress(root: string, session: ReviewSession, live?: LiveReviewOutput) {
  let file;
  try { file = await open(await scopedPath(root, ".state/journal.jsonl"), "r"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return progressFromJournal(session, "", live); throw e; }
  try {
    const size = (await file.stat()).size;
    const offset = Math.max(0, size - 64 * 1024);
    const bytes = Buffer.alloc(size - offset);
    const read = await file.read(bytes, 0, bytes.length, offset);
    let journal = bytes.subarray(0, read.bytesRead).toString("utf8");
    if (offset) journal = journal.slice(journal.indexOf("\n") + 1);
    return progressFromJournal(session, journal, live);
  } finally { await file.close(); }
}
