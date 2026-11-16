import { composeWritingContext } from "../ai/context-composer";
import { normalizeStyleLanguage } from "../../shared/author-style";
import { join, extname } from "node:path";
import { mkdir, readFile, lstat, realpath } from "node:fs/promises";
import { fileSystem } from "../fs/manager";
import { codexClient } from "../codex/client";
import { claudeClient } from "../claude/client";
import { completeAgentModel } from "../agent/providers";
import { codexQuotaError } from "../../shared/codex";
import type { ReviewAddress, ReviewView, FigureApproval } from "../../shared/review-session/types";
import { SessionStore } from "./session-store";
import { ReviewEngine } from "./orchestrator";
import { atomicWrite, hash, writeJSON, readJSON, scopedPath } from "./workspace";
import { currentResponses } from './current-responses';
import { responseLetterMarkdown, responseLetterHTML } from '../../shared/review-session/response-letter';
import { context, figureImage } from "./context";
import { readReviewProgress } from "./progress";
import { readStagedProposals } from "./proposals";
const engines = new Map<string, ReviewEngine>();
export async function reviewEngine(projectPath: string) {
  const project = await realpath(await fileSystem.resolveProjectPath(projectPath));
  let engine = engines.get(project);
  if (!engine) {
    engine = new ReviewEngine(new SessionStore(project), {
      async check(input) {
        const codex = await codexClient.status(); const error = codexQuotaError(codex, input.reviewerModel); if (error) throw new Error(error);
        const claude = await claudeClient.status(); if (claude.state !== "connected") throw new Error(claude.error || "Settings에서 Claude 구독에 연결해 주세요.");
        if (!(await codexClient.models()).some(m => m.id === input.reviewerModel) || !(await claudeClient.models()).includes(input.reviserModel)) throw new Error("선택 모델을 구독 연결에서 사용할 수 없습니다. 모델을 바꾸려면 새 세션을 시작해 주세요.");
        return { codex: codex.cliVersion ?? "unknown", anthropic: claude.cliVersion ?? "unknown" };
      },
      async complete(r) { return completeAgentModel({ provider: r.provider, model: r.model, messages: await composeWritingContext([{ role: "system", content: r.system }, { role: "user", content: r.prompt, images: r.images }], project, { purpose: r.stage.startsWith("responses-") ? "author-response" : r.stage.startsWith("plan-") ? "rewrite" : "review-evaluate", language: normalizeStyleLanguage(r.language), model: r.model }), signal: r.signal, onOutput: r.onOutput }, await fileSystem.getSettings()); },
    }); engines.set(project, engine);
  }
  return engine;
}
export async function reviewView(a: ReviewAddress): Promise<ReviewView> {
  const engine = await reviewEngine(a.projectPath); const session = await engine.recover(a.sessionId);
  const result = session.rounds.find(r => r.round === session.selectedFinalRound) ?? session.rounds.at(-1);
  const root = await engine.store.root(a.sessionId);
  const view: ReviewView = { session, root, responsesMarkdown: '', changes: result?.changes ?? [], progress: await readReviewProgress(root, session, engine.liveOutput(a.sessionId)) };
  const staged = await readStagedProposals(engine.store.project, a.sessionId).catch(() => null);
  if (staged) view.staged = staged;
  if (result) {
    try {
      view.responseDocument = await currentResponses(engine.store, session, result);
      view.responsesMarkdown = responseLetterMarkdown(session, view.responseDocument.responses);
    } catch (error) { view.responseError = error instanceof Error ? error.message : String(error); }
  }
  return view;
}

/** The folder one session's letter is exported to; exporting again replaces its files. */
export function responseExportName(sessionId: string) {
  const [year, month, day, , uuid] = sessionId.split("-");
  return `response-${year}-${month}-${day}-${uuid}`;
}

/** Export only the complete current letter, without sealed AI reports or manuscript files. */
export async function exportReviewResponses(a: ReviewAddress): Promise<string> {
  const engine = await reviewEngine(a.projectPath); const release = await engine.store.lock(a.sessionId);
  try {
    const session = await engine.store.load(a.sessionId);
    const result = session.rounds.find(r => r.round === session.selectedFinalRound);
    if (session.status !== 'completed' || !result) throw new Error('먼저 세션을 완료해 주세요.');
    const document = await currentResponses(engine.store, session, result);
    await mkdir(await scopedPath(engine.store.project, 'exports'), { recursive: true });
    const destination = await scopedPath(engine.store.project, `exports/${responseExportName(session.id)}`);
    await mkdir(destination, { recursive: true });
    await atomicWrite(destination, 'response-to-reviewers.md', responseLetterMarkdown(session, document.responses));
    await atomicWrite(destination, 'response-to-reviewers.html', responseLetterHTML(session, document.responses));
    await writeJSON(destination, 'response.json', { schemaVersion: 1, source: document.source, editedCommentIds: document.editedCommentIds, responses: document.responses });
    if (!session.exportedPaths.includes(destination)) { session.exportedPaths.push(destination); await engine.store.save(session); }
    return destination;
  } finally { await release(); }
}
export async function decideFigure(a: ReviewAddress & { approvalId: string; decision: "approved" | "kept" | "deferred" }) {
  if (!["approved", "kept", "deferred"].includes(a.decision)) throw new Error("Invalid approval decision");
  const engine = await reviewEngine(a.projectPath); const release = await engine.store.lock(a.sessionId);
  try {
    const s = await engine.store.load(a.sessionId); const item = s.approvals.find(x => x.id === a.approvalId);
    if (!item || s.status === "running" || s.status === "completed" || s.status === "cancelled" || item.round <= s.completedCycles || item.status === "imported") throw new Error("This figure request is sealed or unavailable");
    item.status = a.decision;
    await writeJSON(await engine.store.root(s.id), `approvals/${item.id}.json`, { schemaVersion: 1, ...item }); await engine.store.save(s); return s;
  } finally { await release(); }
}
export async function importFigure(a: ReviewAddress & { approvalId: string }, selectedPath: string) {
  const engine = await reviewEngine(a.projectPath); const release = await engine.store.lock(a.sessionId);
  try {
    const s = await engine.store.load(a.sessionId); const item = s.approvals.find(x => x.id === a.approvalId);
    if (!item || item.status !== "approved" || s.status === "running" || s.status === "completed" || s.status === "cancelled" || item.round <= s.completedCycles) throw new Error("유효한 그림별 승인이 필요합니다.");
    const ext = extname(selectedPath).toLowerCase(); if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) throw new Error("PNG/JPEG/WebP/GIF replacement required");
    const info = await lstat(selectedPath); if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024) throw new Error("Replacement must be a regular image no larger than 5 MB");
    const bytes = await readFile(selectedPath); const root = await engine.store.root(s.id);
    const outputPath = `approvals/${item.id}${ext}`; await atomicWrite(root, outputPath, bytes);
    await figureImage(root, { id: item.figureId, source: outputPath, document: "", blockId: "", path: [], caption: "", hash: "", available: true });
    item.outputPath = outputPath; item.outputHash = hash(bytes); item.status = "imported";
    await writeJSON(root, `approvals/${item.id}.json`, { schemaVersion: 1, ...item }); await engine.store.save(s); return s;
  } finally { await release(); }
}
export async function reviewFigurePreview(a: ReviewAddress & { figureId: string; round: number }) {
  const engine = await reviewEngine(a.projectPath); const s = await engine.store.load(a.sessionId); const root = await engine.store.root(s.id);
  if (!Number.isInteger(a.round) || a.round < 0 || a.round > s.completedCycles) throw new Error("Invalid preview round");
  const project = join(root, a.round ? `rounds/${String(a.round).padStart(2, "0")}/project` : "original/project");
  const c = await context(project, s.input.documents); const f = c.figures.find(f => f.id === a.figureId); if (!f) throw new Error("Unknown figure"); return (await figureImage(project, f)).dataUrl;
}
export async function reviewManuscript(a: ReviewAddress & { round: number }) {
  const engine = await reviewEngine(a.projectPath); const s = await engine.store.load(a.sessionId);
  if (!Number.isInteger(a.round) || a.round < 0 || a.round > s.completedCycles) throw new Error("Unknown manuscript version");
  const root = await engine.store.root(s.id); const folder = a.round ? `rounds/${String(a.round).padStart(2, "0")}/project` : "original/project";
  const c = await context(join(root, folder), s.input.documents);
  return JSON.stringify(c.documents);
}

/** Read immutable review evidence for a chapter in an editable revision. Never runs a model. */
async function revisionSource(a: { projectPath: string; filename: string }) {
  const revision = await realpath(await fileSystem.resolveProjectPath(a.projectPath));
  const { dirname, basename } = await import('node:path');
  if (basename(dirname(revision)) !== 'revisions') return null;
  const project = await fileSystem.resolveProjectPath(dirname(dirname(revision)));
  const origin = await readJSON<{ sessionId: string; round: number; baselineHash: string }>(revision, '.scholarpen/review-origin.json');
  const store = new SessionStore(project); const session = await store.load(origin.sessionId);
  if (!session.input.documents.includes(a.filename)) return null;
  const result = session.rounds.find(r => r.round === origin.round);
  if (!result || result.packageHash !== origin.baselineHash) throw new Error('이 사본의 비교 기준을 확인할 수 없습니다.');
  return { revision, project, store, session, result };
}

export async function reviewRevisionContext(a: { projectPath: string; filename: string }) {
  const source = await revisionSource(a); if (!source) return null;
  const { revision, project, store, session, result } = source;
  const { chapterContext } = await import('../../shared/review-session/chapter-context');
  const { readEditableResponses } = await import('./revision-responses');
  const editableResponses = await readEditableResponses(revision, result);
  const original = await readJSON<unknown[]>(await store.root(session.id), `original/project/documents/${a.filename}`);
  return { ...chapterContext(session, result, a.filename, project), original, editableResponses };
}

/** Writes only the working revision, never the sealed session or original manuscript. */
export async function reviewSaveRevisionResponse(a: import('../../shared/review-session/chapter-context').RevisionResponseSave) {
  const source = await revisionSource(a);
  if (!source) throw new Error('이 원고에 연결된 수정 답변서가 없습니다.');
  const { saveRevisionResponse } = await import('./revision-responses');
  return saveRevisionResponse(source.revision, source.session, source.result, a);
}
