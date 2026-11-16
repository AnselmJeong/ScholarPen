import { realpath } from "node:fs/promises";
import type * as Y from "yjs";
import { fileSystem } from "../fs/manager";
import type { CollabRegistry, CollabSession } from "../collab/registry";
import { placeReviewProposals, type PlacementResult } from "../collab/review-proposals";
import { REVIEW_PROPOSALS_MAP, type ProposalEntry } from "../../shared/collab/review-proposals";
import type { ResponseSyncStatus, ReviewAddress, ReviewSession, RoundResult } from "../../shared/review-session/types";
import type { ReviewProposal, StagedProposals } from "../../shared/review-session/proposals";
import { reviewEngine } from "./service";
import { readStagedProposals, stageReviewProposals, stagedProposalsFor } from "./proposals";
import { decisionSources } from "./decision-sources";
import { ensureLetter, existingLetter } from "./letter";
import type { SessionStore } from "./session-store";
import { readEditableResponses, updateRevisionResponses } from "./revision-responses";
import { applyRewrittenResponses, commentSyncStates, proposalDecisions, rewriteResponses, type ProposalDecision } from "./response-sync";
import { exists, readJSON, scopedPath, writeJSON } from "./workspace";
import { REVIEW_CALL_TIMEOUT_MS } from "./progress";

async function projectRoot(path: string) {
  return realpath(await fileSystem.resolveProjectPath(path));
}

/** Saves a named version of a document just before proposals first appear in it, so the author can go back to it in History. */
export type BeforePlacing = (session: CollabSession, name: string) => Promise<unknown>;

async function place(session: CollabSession, proposals: ReviewProposal[], beforePlacing?: BeforePlacing): Promise<PlacementResult> {
  const placed = session.ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP);
  const fresh = proposals.filter(proposal => proposal.document === session.filename && !placed.has(proposal.key));
  if (fresh.length && beforePlacing) {
    const sessions = [...new Set(fresh.map(proposal => proposal.sessionId.slice(0, 10)))].join(", ");
    await beforePlacing(session, `심사 수정안 표시 전 (${sessions} 세션)`).catch(error => console.error("[review] Could not name the version before proposals", error));
  }
  return placeReviewProposals(session, proposals);
}

/** Stages a completed session's proposals and shows them at once in the documents that are open. */
export async function stageManuscriptProposals(registry: CollabRegistry, address: ReviewAddress, beforePlacing?: BeforePlacing): Promise<StagedProposals> {
  const engine = await reviewEngine(address.projectPath);
  const staged = await stageReviewProposals(engine.store.project, await engine.store.load(address.sessionId));
  for (const session of registry.list()) {
    const root = await projectRoot(session.projectPath).catch(() => null);
    if (root === engine.store.project) await place(session, staged.proposals, beforePlacing);
  }
  return staged;
}

/** Places the staged proposals of one open document of the project. */
export async function placeManuscriptProposals(registry: CollabRegistry, docKey: string, projectPath: string, filename: string, beforePlacing?: BeforePlacing): Promise<PlacementResult> {
  const session = registry.get(docKey);
  const root = session ? await projectRoot(projectPath).catch(() => null) : null;
  if (!session || !root) return { placed: 0, unplaced: 0, waiting: 0 };
  return place(session, await stagedProposalsFor(root, filename), beforePlacing);
}

/** `<record>/letter/.scholarpen/response-sync.json`: which decisions each response was written from. */
const SYNC_FILE = ".scholarpen/response-sync.json";
interface SyncRecord {
  schemaVersion: 1;
  comments: Record<string, { fingerprint: string; at: string; method: "model" | "template" }>;
  last?: { at: string; updated: string[]; error?: string };
}

async function readSyncRecord(letter: string | null): Promise<SyncRecord> {
  const empty: SyncRecord = { schemaVersion: 1, comments: {} };
  if (!letter || !await exists(letter, SYNC_FILE)) return empty;
  const record = await readJSON<SyncRecord>(letter, SYNC_FILE).catch(() => empty);
  return record?.schemaVersion === 1 && record.comments && typeof record.comments === "object" ? record : empty;
}

function statusOf(decisions: ProposalDecision[], session: ReviewSession, record: SyncRecord, respond = true): ResponseSyncStatus {
  return {
    comments: !respond ? [] : commentSyncStates(session.comments, decisions).map(state => {
      const synced = record.comments[state.commentId];
      return { commentId: state.commentId, proposals: state.proposals, waiting: state.waiting, ready: state.ready,
        current: synced?.fingerprint === state.fingerprint, ...(synced ? { syncedAt: synced.at, method: synced.method } : {}) };
    }),
    proposals: decisions.map(decision => ({ key: decision.proposal.key, id: decision.proposal.id, document: decision.proposal.document,
      blockId: decision.proposal.blockId, state: decision.state, commentIds: decision.proposal.comments.map(comment => comment.id) })),
    ...(record.last ? { lastAt: record.last.at, ...(record.last.error ? { lastError: record.last.error } : {}) } : {}),
  };
}

/** Decisions on the proposals and whether each response follows them; reads only, never runs a model. */
export async function responseSyncStatus(store: SessionStore, session: ReviewSession): Promise<ResponseSyncStatus | undefined> {
  const staged = await readStagedProposals(store.project, session.id).catch(() => null);
  if (!staged?.proposals.length) return undefined;
  const decisions = await proposalDecisions(decisionSources(), store.project, staged);
  const letter = session.status === "completed" ? await existingLetter(store, session) : null;
  return statusOf(decisions, session, await readSyncRecord(letter), staged.respond !== false);
}

type Engine = Awaited<ReturnType<typeof reviewEngine>>;

/** The session's editable response letter (in its review record); written on first use. */
async function letterFolder(engine: Engine, session: ReviewSession, result: RoundResult) {
  const existing = await existingLetter(engine.store, session);
  if (existing) return existing;
  const release = await engine.store.lock(session.id);
  try { return await ensureLetter(engine.store, session, result); }
  finally { await release(); }
}

/** The author's own wording for one response (e.g. filling a [저자: …] note); rewrites keep it until the manuscript changes. */
export async function editReviewResponse(a: ReviewAddress & { commentId: string; response: string; expectedResponse: string }) {
  if (typeof a.response !== "string" || typeof a.expectedResponse !== "string" || a.response.length > 500_000) throw new Error("답변은 500,000자 이내의 텍스트여야 합니다.");
  const engine = await reviewEngine(a.projectPath);
  const session = await engine.store.load(a.sessionId);
  const result = session.rounds.find(round => round.round === session.selectedFinalRound);
  if (session.status !== "completed" || !result) throw new Error("완료된 세션의 답변만 고칠 수 있습니다.");
  await updateRevisionResponses(await letterFolder(engine, session, result), session, result, items => {
    const item = items.find(value => value.commentId === a.commentId);
    if (!item) throw new Error("고칠 답변을 찾을 수 없습니다.");
    if (item.response !== a.expectedResponse && item.response !== a.response) throw new Error("이 답변이 그사이 다시 쓰였습니다. 입력한 내용은 그대로 두었습니다. 최신 답변을 확인한 뒤 다시 저장해 주세요.");
    item.response = a.response;
  });
}

const running = new Map<string, Promise<unknown>>();

/**
 * Rewrites the response to every comment whose proposals the author has now
 * decided in the manuscript (all of them for general comments), so the letter
 * says what the manuscript actually contains. Responses already written from
 * the same decisions are left alone unless `force` is set.
 */
export async function syncReviewResponses(address: ReviewAddress, options: { force?: boolean } = {}): Promise<ResponseSyncStatus | undefined> {
  const engine = await reviewEngine(address.projectPath);
  const key = `${engine.store.project}\n${address.sessionId}`;
  const previous = running.get(key) ?? Promise.resolve();
  const job = previous.catch(() => undefined).then(async () => {
    const project = engine.store.project;
    const session = await engine.store.load(address.sessionId);
    const result = session.rounds.find(round => round.round === session.selectedFinalRound);
    const staged = await readStagedProposals(project, session.id);
    if (session.status !== "completed" || !result || !staged?.proposals.length) return undefined;
    const decisions = await proposalDecisions(decisionSources(), project, staged);
    // Passages carried over from a letter already sent change the manuscript only.
    if (staged.respond === false) return statusOf(decisions, session, { schemaVersion: 1, comments: {} }, false);
    const revision = await letterFolder(engine, session, result);
    const record = await readSyncRecord(revision);
    const targets = commentSyncStates(session.comments, decisions)
      .filter(state => state.ready && (options.force || record.comments[state.commentId]?.fingerprint !== state.fingerprint));
    if (!targets.length) return statusOf(decisions, session, record);
    const comments = session.comments.filter(comment => targets.some(target => target.commentId === comment.id));
    const current = await readEditableResponses(revision, result);
    const { responses, error } = await rewriteResponses(session, comments, current, decisions, {
      complete: (system, prompt) => engine.providers.complete({
        provider: "anthropic", model: session.roles.reviser.model, stage: "responses-sync", language: session.input.language,
        system, prompt, images: [], signal: AbortSignal.timeout(REVIEW_CALL_TIMEOUT_MS),
      }),
    });
    await updateRevisionResponses(revision, session, result, items => { applyRewrittenResponses(items, session.comments, responses, decisions); });
    const at = new Date().toISOString();
    for (const target of targets) record.comments[target.commentId] = { fingerprint: target.fingerprint, at, method: responses.get(target.commentId)!.method };
    record.last = { at, updated: targets.map(target => target.commentId), ...(error ? { error } : {}) };
    await writeJSON(revision, SYNC_FILE, record);
    return statusOf(decisions, session, record);
  });
  running.set(key, job);
  try { return await job; }
  finally { if (running.get(key) === job) running.delete(key); }
}

const SETTLED = new Set(["accepted", "edited", "rejected", "dismissed"]);

/**
 * Rewrites responses on its own shortly after the author settles proposals in
 * an open document, batching a run of decisions into one rewrite.
 */
export class ResponseSyncScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly observers = new Map<string, () => void>();
  private readonly stops: Array<() => void> = [];

  constructor(registry: CollabRegistry, private readonly run: (address: ReviewAddress) => Promise<unknown> = syncReviewResponses,
    private readonly delayMs = 4_000) {
    for (const session of registry.list()) this.attach(session);
    this.stops.push(registry.onSessionOpened(session => this.attach(session)) as () => void,
      registry.onSessionClosed(session => this.detach(session.docKey)) as () => void);
  }

  dispose() {
    for (const stop of this.stops) stop();
    for (const docKey of [...this.observers.keys()]) this.detach(docKey);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private attach(session: CollabSession) {
    if (this.observers.has(session.docKey)) return;
    const map = session.ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP);
    const observer = (event: Y.YMapEvent<ProposalEntry>) => {
      const sessions = new Set<string>();
      for (const key of event.keysChanged) {
        const entry = map.get(key);
        if (entry && SETTLED.has(entry.state)) sessions.add(entry.sessionId);
      }
      for (const sessionId of sessions) this.schedule(session.projectPath, sessionId);
    };
    map.observe(observer);
    this.observers.set(session.docKey, () => map.unobserve(observer));
  }

  private detach(docKey: string) {
    this.observers.get(docKey)?.();
    this.observers.delete(docKey);
  }

  private schedule(projectPath: string, sessionId: string) {
    const key = `${projectPath}\n${sessionId}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.run({ projectPath, sessionId }).catch(error => console.error("[review] Could not rewrite responses", error));
    }, this.delayMs));
  }
}
