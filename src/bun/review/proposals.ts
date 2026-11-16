import { readdir } from "node:fs/promises";
import type { ReviewSession } from "../../shared/review-session/types";
import { proposalsFromSession, type ReviewProposal, type StagedProposals } from "../../shared/review-session/proposals";
import { exists, readJSON, scopedPath, writeJSON } from "./workspace";

/** `<project>/.scholarpen/review-proposals/<session>.json`: proposals waiting to be shown in their documents. */
const FOLDER = ".scholarpen/review-proposals";

/**
 * Records the selected round's text revisions for the manuscript. Each
 * document shows them as tracked changes the next time it is open; placing
 * is idempotent, so staging again never duplicates a proposal.
 */
export async function stageReviewProposals(project: string, session: ReviewSession): Promise<StagedProposals> {
  const result = session.rounds.find(round => round.round === session.selectedFinalRound);
  if (session.status !== "completed" || !result) throw new Error("완료된 세션의 최종 후보만 원고에 표시할 수 있습니다.");
  const staged: StagedProposals = {
    schemaVersion: 1, sessionId: session.id, round: result.round, stagedAt: new Date().toISOString(),
    proposals: proposalsFromSession(session, result),
  };
  await writeJSON(project, `${FOLDER}/${session.id}.json`, staged);
  return staged;
}

function validProposal(value: unknown): value is ReviewProposal {
  const p = value as ReviewProposal;
  return !!p && typeof p === "object" && ["key", "sessionId", "id", "document", "blockId", "before", "after", "rationale"]
    .every(field => typeof (p as unknown as Record<string, unknown>)[field] === "string")
    && (p.origin === "applied" || p.origin === "deferred") && Array.isArray(p.comments);
}

export async function readStagedProposals(project: string, sessionId: string): Promise<StagedProposals | null> {
  if (!/^[\w-]+$/.test(sessionId) || !await exists(project, `${FOLDER}/${sessionId}.json`)) return null;
  const staged = await readJSON<StagedProposals>(project, `${FOLDER}/${sessionId}.json`);
  if (staged?.schemaVersion !== 1 || !Array.isArray(staged.proposals)) return null;
  return { ...staged, proposals: staged.proposals.filter(validProposal) };
}

/** Staged proposals of every session for one document of the project. */
export async function stagedProposalsFor(project: string, filename: string): Promise<ReviewProposal[]> {
  if (!await exists(project, FOLDER)) return [];
  const proposals: ReviewProposal[] = [];
  for (const name of (await readdir(await scopedPath(project, FOLDER))).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const staged = await readStagedProposals(project, name.slice(0, -".json".length));
      proposals.push(...(staged?.proposals ?? []).filter(proposal => proposal.document === filename));
    } catch (error) {
      console.error("[review] Unreadable staged proposals", name, error);
    }
  }
  return proposals;
}
