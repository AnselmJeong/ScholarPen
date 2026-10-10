import * as Y from "yjs";
import type { OllamaMessage } from "../../../shared/rpc-types";
import { COLLAB_FRAGMENT, COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import {
  addThreadComment,
  aiRequestKey,
  readThreads,
  threadWantsAI,
  updateThreadMeta,
  type ThreadMeta,
  type ThreadSnapshot,
} from "../../../shared/collab/threads";
import type { AgentJobView } from "../../../shared/collab/agent-types";
import { isAIUser, SCHOLARPEN_AI } from "../../../shared/collab/personas";
import type { CollabRegistry, CollabSession } from "../registry";
import { applyBlockRewrite, captureBlock, nextSuggestionId, type BlockBase, type EditMode, type EditOutcome } from "./block-edit";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../../shared/collab/change-sets";
import {
  blockContent,
  blocksInRange,
  findBlock,
  hasInlineContent,
  hasSuggestionMarks,
  listBlocks,
  readDoc,
  readableText,
  threadRange,
  type BlockRef,
} from "./doc-model";
import { PresenceTracker } from "./presence";
import { rememberResolvedReviewBlocks } from "./resolved-review";
import { buildCommentEditMessages, buildDocumentPlanMessages, clip, parseCommentEditResponse, parseDocumentPlan } from "./prompts";
import {
  asksForHumanize,
  buildHumanizeDiagnosisMessages,
  CHANGE_RATE_ABORT,
  CHANGE_RATE_WARN,
  changeRate,
  humanizeGuidance,
  isKoreanProse,
  parseHumanizeDiagnosis,
  sampleParagraphs,
} from "./humanize/humanize";
import { manuscriptLanguage } from "./humanize/language";
import { englishHumanizeGuidance } from "./humanize/english";
import { cleanDocumentWatermarks } from "./watermark/document";
import { editableSegments, parseTextEdits } from "./text-edits";
import { completeWithDeadline } from "./completion";
import { protectedRewritePreview, restoreProtectedSelection } from "../../../shared/ai-text-protection";
import type { Node as PMNode } from "prosemirror-model";
import { asksForAIScore, formatAIDetectionReport, type AIDetectionReport } from "../../../shared/ai-detection";
import { analyzeAIText } from "../../ai-detector/service";
import { resolveMentionedFiles, type MentionedFileContext } from "../../agent/mention-resolver";
import { runBulkComments } from "./bulk-comments";
import { projectBulkSources, type BulkSources } from "./bulk-sources";
import { editLevelExceeded, editLevelGuidance, editLevelLabel, editLevelOf, EDIT_LEVEL_MAX_CHANGE, WRITING_MAP, type EditLevel } from "../../../shared/collab/writing";
import { glossaryGuidance, type Glossary } from "../../../shared/glossary";
import { mapGuidance, type ManuscriptMap } from "../../../shared/manuscript-map";
import { recordRevision, REVISIONS_MAP, type RevisionEntry, type RevisionParagraph } from "../../../shared/collab/revision-log";

/** Yjs transaction origin of every AI text edit; the undo manager tracks it. */
export const AI_ORIGIN = "ai-agent";
/** Origin of AI bookkeeping (comment anchors, review state) that "undo AI edit" must not revert. */
export const AI_META_ORIGIN = "ai-meta";
export const AI_EDITS_MAP = "aiEdits";

export interface CollabAgentDeps {
  resolveMentionedFiles?: typeof resolveMentionedFiles;
  analyzeAIText?: (text: string, signal: AbortSignal) => Promise<AIDetectionReport>;
  complete(messages: OllamaMessage[], signal: AbortSignal): Promise<string>;
  /** Larger output budget for a whole-manuscript revision and its outcome ledger. */
  completeBulk?: (messages: OllamaMessage[], signal: AbortSignal) => Promise<string>;
  onActivity(docKey: string, jobs: AgentJobView[]): void;
  now?: () => number;
  /** How long the AI waits for the author to leave a paragraph before working on it anyway. */
  waitForAuthorMs?: number;
  pollMs?: number;
  /** Per-model-call deadline, not a limit on processing the whole manuscript. */
  completionTimeoutMs?: number;
  /** The project's glossary and manuscript map, followed by every AI edit; none when absent. */
  projectGuide?: (session: CollabSession) => Promise<{ glossary: Glossary; map: ManuscriptMap }>;
  /** The project around a document for coordinated revisions; defaults to its files on disk. */
  bulkSources?: (session: CollabSession) => BulkSources | Promise<BulkSources>;
  /** Decides suggestion vs direct edits for a block (zones refine this in stage 5). */
  editModeFor?: (session: CollabSession, blockId: string) => EditMode;
}

export interface Attachment {
  session: CollabSession;
  presence: PresenceTracker;
  undo: Y.UndoManager;
  stop: () => void;
  releaseHold: (() => void) | null;
}

interface Job {
  references?: MentionedFileContext[];
  /** Edit level, glossary and manuscript map for every prompt of this job. */
  policy?: string;
  level?: EditLevel;
  view: AgentJobView;
  run: (job: Job, attachment: Attachment, signal: AbortSignal) => Promise<void>;
}

/** Paragraphs sent to the model in one edit call. */
const MAX_BLOCKS_PER_CALL = 5;
/** Most paragraphs one request edits; larger requests continue on the next reply. */
const MAX_DOCUMENT_BLOCKS = 60;
/** Manuscript text per planning call; longer manuscripts are planned in parts. */
const PLAN_PART_CHARS = 60_000;
const RECENT_JOBS = 12;

let jobCounter = 0;

export class CollabAgent {
  private readonly attachments = new Map<string, Attachment>();
  private readonly queue: Job[] = [];
  private readonly history = new Map<string, AgentJobView[]>();
  private readonly seen = new Set<string>();
  private running: { job: Job; controller: AbortController } | null = null;
  private paused = false;
  private readonly now: () => number;
  private readonly stopRegistry: Array<() => void> = [];

  constructor(private readonly registry: CollabRegistry, private readonly deps: CollabAgentDeps) {
    this.now = deps.now ?? Date.now;
    for (const session of registry.list()) this.attach(session);
    const offOpened = registry.onSessionOpened((session) => this.attach(session));
    const offClosed = registry.onSessionClosed((session) => this.detach(session.docKey));
    this.stopRegistry.push(() => { offOpened(); }, () => { offClosed(); });
  }

  dispose() {
    this.running?.controller.abort();
    for (const stop of this.stopRegistry) stop();
    for (const docKey of [...this.attachments.keys()]) this.detach(docKey);
  }

  isPaused() {
    return this.paused;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) this.running?.controller.abort();
    else void this.pump();
  }

  jobs(docKey: string) {
    return this.history.get(docKey) ?? [];
  }

  /** Reverts the most recent AI change to the document text. */
  undoLast(docKey: string) {
    const attachment = this.attachments.get(docKey);
    if (!attachment || attachment.undo.undoStack.length === 0) return false;
    attachment.undo.undo();
    return true;
  }

  canUndo(docKey: string) {
    return (this.attachments.get(docKey)?.undo.undoStack.length ?? 0) > 0;
  }

  /** Re-checks a document's threads; used after an editor reconnects. */
  rescan(docKey: string) {
    const attachment = this.attachments.get(docKey);
    if (attachment) this.scanThreads(attachment);
  }

  private attach(session: CollabSession) {
    if (this.attachments.has(session.docKey)) return;
    const presence = new PresenceTracker(session, this.now);
    const undo = new Y.UndoManager(session.ydoc.getXmlFragment(COLLAB_FRAGMENT), {
      trackedOrigins: new Set([AI_ORIGIN]),
      captureTimeout: 0,
    });
    const threads = session.ydoc.getMap(COLLAB_THREADS_MAP);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onThreads = (_events: unknown, transaction: Y.Transaction) => {
      // Resolve all (or resolving the active request) cancels in-flight edits too.
      if (transaction.origin !== AI_META_ORIGIN && this.running?.job.view.docKey === session.docKey) {
        const runningId = this.running.job.view.threadId;
        if (runningId && !readThreads(threads).some(thread => thread.id === runningId && !thread.resolved)) {
          this.running.controller.abort();
        }
      }
      // Record resolution synchronously, before another review or thread deletion.
      rememberResolvedReviewBlocks(session, AI_META_ORIGIN);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => this.scanThreads(attachment), 250);
    };
    threads.observeDeep(onThreads);
    const attachment: Attachment = {
      session,
      presence,
      undo,
      releaseHold: null,
      stop: () => {
        if (timer) clearTimeout(timer);
        threads.unobserveDeep(onThreads);
      },
    };
    this.attachments.set(session.docKey, attachment);

    // A process restart must not silently repeat a failed or partially applied edit.
    session.ydoc.transact(() => {
      for (const thread of readThreads(threads)) {
        if (thread.meta.status === "in-progress") {
          updateThreadMeta(threads, thread.id, { assignee: "me", status: "open", statusNote: "Interrupted. Ask AI to retry when ready." });
          addThreadComment(threads, thread.id, SCHOLARPEN_AI.userId, "The previous AI task was interrupted. Any existing suggestions remain available for review. Ask AI to retry when ready.");
        }
      }
      for (const thread of readThreads(threads)) {
        if (!thread.meta.bulkRequestId) continue;
        const owner = readThreads(threads).find(item => item.id === thread.meta.bulkRequestId);
        if (!owner || owner.resolved || owner.meta.assignee !== "ai") {
          updateThreadMeta(threads, thread.id, { bulkRequestId: undefined, assignee: "me", manual: true });
        }
      }
    }, AI_META_ORIGIN);
    this.scanThreads(attachment);
  }

  private detach(docKey: string) {
    const attachment = this.attachments.get(docKey);
    if (!attachment) return;
    attachment.stop();
    attachment.presence.destroy();
    attachment.undo.destroy();
    this.attachments.delete(docKey);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].view.docKey === docKey) this.queue.splice(i, 1);
    }
  }

  private scanThreads(attachment: Attachment) {
    rememberResolvedReviewBlocks(attachment.session, AI_META_ORIGIN);
    const threads = readThreads(attachment.session.ydoc.getMap(COLLAB_THREADS_MAP));
    for (const thread of threads) {
      if (!threadWantsAI(thread)) continue;
      const last = [...thread.comments].reverse().find((comment) => !comment.deleted)!;
      const key = `${attachment.session.docKey}:${aiRequestKey(thread)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.enqueue(attachment, {
        kind: "comment",
        threadId: thread.id,
        agent: SCHOLARPEN_AI.id,
        label: clip(last.text.replace(/\s+/g, " "), 80, "start"),
      }, (job, att, signal) => this.runCommentJob(job, att, thread.id, signal));
    }
  }

  /** Adds a job for a document; jobs run one at a time across all documents. */
  enqueue(
    attachment: Attachment,
    view: Pick<AgentJobView, "kind" | "label" | "threadId" | "blockId" | "agent">,
    run: Job["run"],
  ) {
    const job: Job = {
      view: { id: `job-${++jobCounter}`, docKey: attachment.session.docKey, state: "queued", createdAt: this.now(), ...view },
      run,
    };
    this.queue.push(job);
    this.record(job.view);
    void this.pump();
    return job.view.id;
  }

  attachmentFor(docKey: string) {
    return this.attachments.get(docKey) ?? null;
  }

  attachmentList() {
    return [...this.attachments.values()];
  }

  /** True while a job for this document is queued or running. */
  isBusy(docKey: string) {
    return this.running?.job.view.docKey === docKey || this.queue.some((job) => job.view.docKey === docKey);
  }

  private record(view: AgentJobView) {
    const list = (this.history.get(view.docKey) ?? []).filter((item) => item.id !== view.id);
    list.unshift({ ...view });
    this.history.set(view.docKey, list.slice(0, RECENT_JOBS));
    this.deps.onActivity(view.docKey, this.history.get(view.docKey)!);
  }

  private update(job: Job, patch: Partial<AgentJobView>) {
    Object.assign(job.view, patch);
    this.record(job.view);
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused) return;
    const job = this.queue.shift();
    if (!job) return;
    const attachment = this.attachments.get(job.view.docKey);
    if (!attachment) return this.pump();
    const controller = new AbortController();
    this.running = { job, controller };
    attachment.releaseHold ??= this.registry.hold(job.view.docKey);
    this.update(job, { state: "working", startedAt: this.now() });
    try {
      await job.run(job, attachment, controller.signal);
      if (job.view.state === "working" || job.view.state === "waiting") this.update(job, { state: "done", finishedAt: this.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.view.threadId) {
        const thread = readThreads(attachment.session.ydoc.getMap(COLLAB_THREADS_MAP)).find(item => item.id === job.view.threadId);
        if (thread?.meta.status === "in-progress") this.setThread(attachment, thread.id, {
          assignee: "me", status: thread.meta.changeSet === undefined ? "open" : "proposed",
          statusNote: controller.signal.aborted ? "Cancelled" : `Failed: ${message}`,
        }, `${controller.signal.aborted ? "The task was cancelled." : `The task stopped: ${message}`} ` +
          (thread.meta.documentAction === "resolve-comments"
            ? "No manuscript edits were applied by this coordinated request. Ask AI to retry when ready."
            : "Any earlier suggestions remain available for review. Ask AI to retry when ready."));
      }
      this.update(job, { state: controller.signal.aborted ? "cancelled" : "failed", detail: message, finishedAt: this.now() });
    } finally {
      if (job.view.threadId) {
        const map = attachment.session.ydoc.getMap(COLLAB_THREADS_MAP);
        attachment.session.ydoc.transact(() => {
          for (const thread of readThreads(map)) {
            if (thread.meta.bulkRequestId === job.view.threadId) updateThreadMeta(map, thread.id, {
              bulkRequestId: undefined, assignee: "me", manual: true,
            });
          }
        }, AI_META_ORIGIN);
      }
      attachment.presence.release();
      this.running = null;
      if (!this.queue.some((queued) => queued.view.docKey === job.view.docKey)) {
        attachment.releaseHold?.();
        attachment.releaseHold = null;
      }
      void this.pump();
    }
  }

  private complete(messages: OllamaMessage[], signal: AbortSignal) {
    return completeWithDeadline(this.deps.complete, messages, signal, this.deps.completionTimeoutMs ?? 180_000);
  }

  /** Waits until the author is not in (or just editing) any of the blocks. */
  async waitForAuthor(job: Job, attachment: Attachment, blockIds: string[], signal: AbortSignal) {
    const deadline = this.now() + (this.deps.waitForAuthorMs ?? 60_000);
    const busy = () => blockIds.some((id) => attachment.presence.isBusy(id));
    if (!busy()) return;
    this.update(job, { state: "waiting", detail: "Waiting until you leave this passage" });
    while (busy() && this.now() < deadline) {
      if (signal.aborted) throw new Error("Cancelled");
      await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 1500));
    }
    this.update(job, { state: "working", detail: undefined });
  }

  private setThread(attachment: Attachment, threadId: string, patch: Partial<ThreadMeta>, reply?: string) {
    const threads = attachment.session.ydoc.getMap(COLLAB_THREADS_MAP);
    attachment.session.ydoc.transact(() => {
      if (reply) addThreadComment(threads, threadId, SCHOLARPEN_AI.userId, reply);
      updateThreadMeta(threads, threadId, patch);
    }, AI_META_ORIGIN);
  }

  /** The author's standing rules for one job: how far edits may go, and the project's terms and chapters. */
  async policyFor(session: CollabSession, level: EditLevel) {
    const guide = await this.deps.projectGuide?.(session).catch(() => null);
    return [editLevelGuidance(level), guide ? glossaryGuidance(guide.glossary) : "", guide ? mapGuidance(guide.map, session.filename) : ""]
      .filter(Boolean).join("\n\n");
  }

  modeFor(attachment: Attachment, blockId: string): EditMode {
    return this.deps.editModeFor?.(attachment.session, blockId) ?? "auto";
  }

  /** Remembers blocks the AI changed directly so editors can highlight them. */
  markDirectEdit(attachment: Attachment, blockId: string, source: string) {
    attachment.session.ydoc.transact(() => {
      attachment.session.ydoc.getMap(AI_EDITS_MAP).set(blockId, { at: this.now(), source });
    }, AI_META_ORIGIN);
  }

  private async runCommentJob(job: Job, attachment: Attachment, threadId: string, signal: AbortSignal) {
    const { session } = attachment;
    const thread = readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP)).find((item) => item.id === threadId);
    if (!thread || !threadWantsAI(thread)) return;
    const reply = (patch: Partial<ThreadMeta>, text?: string) => this.setThread(attachment, threadId, patch, text);
    reply({ assignee: "ai", agent: SCHOLARPEN_AI.id, status: "in-progress", statusNote: undefined, decision: undefined });
    job.level = thread.meta.editLevel ?? editLevelOf(session.ydoc.getMap(WRITING_MAP));
    job.policy = await this.policyFor(session, job.level);
    signal.throwIfAborted();
    if (thread.meta.documentAction === "resolve-comments") {
      const all = readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP));
      const requested = new Set(thread.meta.bulkThreadIds ?? []);
      const references = await (this.deps.resolveMentionedFiles ?? resolveMentionedFiles)({
        projectPath: session.projectPath, explicitFilePaths: [],
        message: all.filter(item => requested.has(item.id) || item.id === thread.id)
          .flatMap(item => item.comments.filter(comment => !comment.deleted && !isAIUser(comment.userId)).map(comment => comment.text)).join("\n"),
      });
      return runBulkComments(session, thread, {
        references, complete: (messages, callSignal) => completeWithDeadline(
          this.deps.completeBulk ?? this.deps.complete, messages, callSignal, this.deps.completionTimeoutMs ?? 180_000),
        modeFor: blockId => this.modeFor(attachment, blockId),
        progress: detail => this.update(job, { detail }),
        sources: await (this.deps.bulkSources ?? projectBulkSources)(session),
        level: job.level, policy: job.policy,
      }, signal);
    }
    const latestRequest = [...thread.comments].reverse().find(comment => !comment.deleted && !isAIUser(comment.userId))?.text ?? "";
    if (thread.meta.documentAction === "ai-score" || asksForAIScore(latestRequest)) {
      const doc = readDoc(session);
      const whole = thread.meta.scope === "document" || thread.meta.documentAction === "ai-score";
      const range = whole ? null : threadRange(doc, threadId);
      if (!whole && !range) throw new Error("분석할 선택 영역이 없습니다. 텍스트를 다시 선택해 요청해 주세요.");
      const blocks = (range ? blocksInRange(doc, range.from, range.to) : listBlocks(doc))
        .filter(block => hasInlineContent(block) && blockContent(block).node.type.name !== "codeBlock");
      const text = blocks.map(block => {
        const content = blockContent(block);
        return readableText(doc, Math.max(content.from, range?.from ?? content.from), Math.min(content.to, range?.to ?? content.to));
      }).join("\n\n");
      this.update(job, { detail: "로컬 모델로 AI 작성 가능성 분석 중" });
      const result = await (this.deps.analyzeAIText ?? analyzeAIText)(text, signal);
      signal.throwIfAborted();
      reply({ assignee: "me", status: "open", statusNote: "AI 작성 가능성 분석 완료" },
        formatAIDetectionReport(result, whole ? "현재 문서의 본문" : "댓글의 선택 영역"));
      return;
    }
    if (thread.meta.documentAction === "remove-watermark") {
      if (signal.aborted) throw new Error("Cancelled");
      const result = cleanDocumentWatermarks(session, AI_ORIGIN);
      const { scanned, skipped, removed, replaced } = result;
      const summary = removed || replaced
        ? `숨은 문자 ${removed}개 제거 · 특수 공백 ${replaced}개 정리`
        : skipped ? "검사한 텍스트에서 정리할 문자 없음 · 일부 블록 제외" : "검사 완료 · 정리할 숨은 문자·특수 공백 없음";
      reply({ assignee: "me", status: "resolved", editedBlockIds: result.blockIds,
        watermarkResult: { scanned, skipped, removed, replaced }, resultDismissedAt: undefined, statusNote: summary },
        `현재 문서 전체에서 ${result.scanned}개 텍스트 블록을 확인했습니다. 숨은 문자 ${result.removed}개 제거, 특수 공백 ${result.replaced}개 정리. ` +
        `코드 또는 검토 중인 수정안이 있는 블록 ${result.skipped}개는 보존했습니다. ` +
        "문체 재작성 없이 로컬 유니코드 정리만 수행했습니다. 통계적 워터마크나 첨부 파일의 워터마크 제거를 보장하지 않습니다. " +
        (result.blockIds.length ? "Activity의 Undo last AI edit으로 전체 정리를 되돌릴 수 있습니다." : "변경할 문자가 없어 원문을 유지했습니다."));
      this.update(job, { detail: `${summary} · ${scanned}개 블록 검사${skipped ? ` · ${skipped}개 제외` : ""}` });
      return;
    }
    // Only the author's live comments select resources; AI output must never
    // cause additional files to be read. Keep the same snapshot for all batches.
    job.references = await (this.deps.resolveMentionedFiles ?? resolveMentionedFiles)({
      projectPath: session.projectPath,
      explicitFilePaths: [],
      message: conversationOf(thread).filter(comment => comment.author === "author").map(comment => comment.text).join("\n"),
    });
    signal.throwIfAborted();
    if (thread.meta.scope === "document" || thread.meta.documentAction === "humanize") return this.runDocumentRequest(job, attachment, thread, reply, signal);

    const doc = readDoc(session);
    const range = threadRange(doc, threadId);
    if (!range) {
      reply({ assignee: "me", status: "open" },
        "I can't find the commented passage anymore. Re-select the text and comment again.");
      return;
    }
    const blocks = blocksInRange(doc, range.from, range.to).filter(hasInlineContent);
    if (blocks.length === 0) {
      reply({ assignee: "me", status: "open" },
        "This passage has no editable prose (it is an equation, figure or empty block), so I left it unchanged.");
      return;
    }
    if (blocks.length > MAX_DOCUMENT_BLOCKS) {
      reply({ assignee: "me", status: "open" },
        `This comment spans ${blocks.length} paragraphs. Comment on ${MAX_DOCUMENT_BLOCKS} or fewer at a time so I can edit them safely.`);
      return;
    }
    if (asksForHumanize(conversationOf(thread)) && manuscriptLanguage(doc) !== "korean") {
      return this.runHumanizeRequest(job, attachment, thread, doc, blocks, reply, signal);
    }
    const humanize = asksForHumanize(conversationOf(thread))
      ? await this.diagnoseHumanize(job, attachment, thread, doc, blocks, signal)
      : undefined;
    const result = await this.editBlocks(job, attachment, thread, blocks.map((block) => block.id), {
      quoted: readableText(doc, range.from, range.to),
      allowWiderScope: true,
      ...(humanize !== undefined ? { guidance: humanizeGuidance(humanize), gateChangeRate: true } : {}),
    }, signal);
    if (result === "document") {
      // The thread asks for more than its passage; from now on it is about the whole manuscript.
      reply({ scope: "document" });
      return this.runDocumentRequest(job, attachment, { ...thread, meta: { ...thread.meta, scope: "document" } }, reply, signal);
    }
    this.finishEdit(job, attachment, thread, result, reply);
  }

  /** A request about the whole manuscript: find the paragraphs it touches, then edit them in batches. */
  private async runDocumentRequest(job: Job, attachment: Attachment, thread: ThreadSnapshot,
    reply: (patch: Partial<ThreadMeta>, text?: string) => void, signal: AbortSignal) {
    const doc = readDoc(attachment.session);
    const prose = listBlocks(doc).filter(hasInlineContent);
    if (prose.length === 0) {
      reply({ assignee: "me", status: "open" }, "The manuscript has no editable prose yet, so I left it unchanged.");
      return;
    }
    if (thread.meta.documentAction === "humanize" || asksForHumanize(conversationOf(thread))) return this.runHumanizeRequest(job, attachment, thread, doc, prose, reply, signal);
    const paragraphs = prose.map((block, index) => ({
      number: index + 1,
      kind: blockContent(block).node.type.name,
      text: readableText(doc, blockContent(block).from, blockContent(block).to),
    }));
    // Long manuscripts are read in parts that each fit one model call.
    const parts: Array<typeof paragraphs> = [[]];
    let size = 0;
    for (const paragraph of paragraphs) {
      if (size > 0 && size + paragraph.text.length > PLAN_PART_CHARS) {
        parts.push([]);
        size = 0;
      }
      parts[parts.length - 1].push(paragraph);
      size += paragraph.text.length;
    }

    this.update(job, { detail: "Reading the manuscript" });
    attachment.presence.claim(prose[0].id, "reading");
    const chosen = new Set<number>();
    let summary = "";
    for (let index = 0; index < parts.length; index++) {
      const response = await this.complete(buildDocumentPlanMessages({
        references: job.references,
        policy: job.policy,
        conversation: conversationOf(thread),
        paragraphs: parts[index],
        part: parts.length > 1 ? { index: index + 1, total: parts.length } : undefined,
      }), signal);
      if (signal.aborted) throw new Error("Cancelled");
      const plan = parseDocumentPlan(response, new Set(parts[index].map((paragraph) => paragraph.number)));
      plan.paragraphs.forEach((number) => chosen.add(number));
      summary ||= plan.summary;
    }
    attachment.presence.release();

    const targets = [...chosen].sort((a, b) => a - b).map((number) => prose[number - 1].id);
    if (targets.length === 0) {
      reply({ assignee: "me", status: "open", statusNote: undefined }, summary || "Nothing in the manuscript needs to change for this.");
      return;
    }
    const capped = targets.slice(0, MAX_DOCUMENT_BLOCKS);
    const result = await this.editBlocks(job, attachment, thread, capped, { summary }, signal);
    if (result === "document") return;
    if (targets.length > capped.length) {
      result.notes.push(`${targets.length} paragraphs need this change; I edited the first ${capped.length}. Reply here to continue with the rest.`);
    }
    this.finishEdit(job, attachment, thread, result, reply);
  }

  /**
   * Choose one humanizer from the whole manuscript, then edit prose in that language.
   * Korean retains its diagnosis and change-rate gates; English uses blader/humanizer.
   */
  private async runHumanizeRequest(job: Job, attachment: Attachment, thread: ThreadSnapshot, doc: PMNode, prose: BlockRef[],
    reply: (patch: Partial<ThreadMeta>, text?: string) => void, signal: AbortSignal) {
    const language = manuscriptLanguage(doc);
    if (language === "undetermined") {
      reply({ assignee: "me", status: "open", statusNote: undefined },
        "한국어 또는 영어가 본문 단어의 과반을 차지하지 않아 Humanize 처리 방식을 선택하지 않았습니다. 원문을 유지했습니다.");
      return;
    }
    if (language === "english") return this.runEnglishHumanizeRequest(job, attachment, thread, prose, reply, signal);
    const targets = prose.filter((block) => {
      const content = blockContent(block).node;
      // Headings are section titles (kept by the rulebook); paragraphs with pending suggestions are left for the author.
      return content.type.name !== "heading" && content.type.name !== "codeBlock" && !content.type.spec.code &&
        !hasSuggestionMarks(content) && isKoreanProse(content.textContent);
    });
    if (targets.length === 0) {
      reply({ assignee: "me", status: "open", statusNote: undefined },
        "I found no Korean paragraphs to humanize (paragraphs with pending suggestions are skipped), so I left the manuscript unchanged.");
      return;
    }
    const diagnosis = await this.diagnoseHumanize(job, attachment, thread, doc, targets, signal);
    const result = await this.editBlocks(job, attachment, thread, targets.map((block) => block.id), {
      summary: diagnosis?.summary,
      guidance: humanizeGuidance(diagnosis),
      gateChangeRate: true,
      skipAuthorWait: thread.meta.scope === "document" || !!thread.meta.documentAction,
    }, signal);
    if (result === "document") return;
    this.finishEdit(job, attachment, thread, result, reply);
  }

  private async runEnglishHumanizeRequest(job: Job, attachment: Attachment, thread: ThreadSnapshot, prose: BlockRef[],
    reply: (patch: Partial<ThreadMeta>, text?: string) => void, signal: AbortSignal) {
    const targets = prose.filter(block => {
      const content = blockContent(block).node;
      return content.type.name !== "heading" && content.type.name !== "codeBlock" && !content.type.spec.code
        && !hasSuggestionMarks(content) && manuscriptLanguage(content) === "english";
    });
    if (!targets.length) {
      reply({ assignee: "me", status: "open", statusNote: undefined },
        "English manuscript detected, but no English prose is available to humanize. Headings, code and paragraphs with pending suggestions are skipped.");
      return;
    }
    this.update(job, { detail: "Humanizing English (blader/humanizer)" });
    const result = await this.editBlocks(job, attachment, thread, targets.map(block => block.id), {
      guidance: englishHumanizeGuidance(),
      suggestOnly: true,
      skipAuthorWait: thread.meta.scope === "document" || !!thread.meta.documentAction,
    }, signal);
    if (result !== "document") {
      result.notes.unshift("English manuscript detected; used blader/humanizer for style editing.");
      this.finishEdit(job, attachment, thread, result, reply);
    }
  }

  /** One diagnosis call over the text: which AI tells dominate it. Null when the answer could not be read. */
  private async diagnoseHumanize(job: Job, attachment: Attachment, thread: ThreadSnapshot, doc: PMNode, blocks: BlockRef[],
    signal: AbortSignal) {
    this.update(job, { detail: "Diagnosing AI tells (im-not-ai)" });
    attachment.presence.claim(blocks[0].id, "reading");
    const texts = blocks.map((block) => readableText(doc, blockContent(block).from, blockContent(block).to));
    const response = await this.complete(buildHumanizeDiagnosisMessages({
      conversation: conversationOf(thread),
      paragraphs: sampleParagraphs(texts),
    }), signal);
    attachment.presence.release();
    if (signal.aborted) throw new Error("Cancelled");
    this.update(job, { detail: undefined });
    return parseHumanizeDiagnosis(response);
  }

  /**
   * Rewrites the given blocks for the thread, a few paragraphs per model call,
   * as one change set. Returns "document" when the model says the request
   * needs the whole manuscript (only when `allowWiderScope` is set).
   */
  private async editBlocks(job: Job, attachment: Attachment, thread: ThreadSnapshot, blockIds: string[],
    options: { quoted?: string; summary?: string; allowWiderScope?: boolean; guidance?: string; gateChangeRate?: boolean; suggestOnly?: boolean; skipAuthorWait?: boolean },
    signal: AbortSignal): Promise<EditResult | "document"> {
    const { session } = attachment;
    const batches: string[][] = [];
    // Bound annotated output size as well as paragraph count to reduce truncation.
    const snapshot = readDoc(session);
    let batch: string[] = [], chars = 0;
    for (const id of blockIds) {
      const block = findBlock(snapshot, id);
      const size = block ? captureBlock(block).protection.protectedText.length : 0;
      if (batch.length && (batch.length >= MAX_BLOCKS_PER_CALL || chars + size > 6000)) {
        batches.push(batch); batch = []; chars = 0;
      }
      batch.push(id); chars += size;
    }
    if (batch.length) batches.push(batch);
    const result: EditResult = {
      outcomes: [], replies: [], notes: [], changeRates: [], editedBlockIds: [], summary: options.summary,
      // Everything this request changes is one change set, accepted or rejected together.
      changeSetId: nextSuggestionId(readDoc(session)),
      paragraphs: blockIds.length,
      questions: [],
      paragraphsChanged: [],
    };
    this.update(job, { blockId: blockIds[0] });

    for (let index = 0; index < batches.length; index++) {
      if (!options.skipAuthorWait) await this.waitForAuthor(job, attachment, batches[index], signal);
      this.update(job, { state: "working", detail: `Editing part ${index + 1} of ${batches.length}` });
      // Read the paragraphs now, after waiting: this is the base the stale check compares against.
      const doc = readDoc(session);
      const fresh = batches[index].map((id) => findBlock(doc, id)).filter((block): block is NonNullable<typeof block> => !!block);
      if (fresh.length < batches[index].length) {
        result.notes.push(batches.length > 1
          ? "Some paragraphs were deleted before I reached them, so I skipped them."
          : "Part of the commented passage was deleted before I started, so I left it alone.");
        if (batches.length === 1) break;
      }
      if (fresh.length === 0) continue;
      attachment.presence.claim(fresh[0].id, "editing");
      const bases: BlockBase[] = fresh.map((block) => captureBlock(block));
      const first = blockContent(fresh[0]);
      const last = blockContent(fresh[fresh.length - 1]);
      const messages = buildCommentEditMessages({
        references: job.references,
        conversation: conversationOf(thread),
        passage: joinProtections(bases),
        quoted: options.quoted,
        before: clip(readableText(doc, 0, first.from), 6000, "end"),
        after: clip(readableText(doc, last.to, doc.content.size), 3000, "start"),
        part: options.quoted === undefined ? { index: index + 1, total: batches.length } : undefined,
        allowWiderScope: options.allowWiderScope,
        guidance: options.guidance,
        policy: job.policy,
        segments: editableSegments(bases.map(base => base.protection)).map(({ id, text }) => ({ id, text })),
      });
      let parsed: ReturnType<typeof parseCommentEditResponse> | undefined;
      let parts: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await this.complete(messages, signal);
        if (signal.aborted) throw new Error("Cancelled");
        try {
          const structured = parseTextEdits(response, bases.map(base => base.protection));
          parsed = structured
            ? { reply: structured.reply, passage: structured.parts ? "structured" : null, wantsDocument: structured.wantsDocument }
            : parseCommentEditResponse(response);
          if (structured?.question) result.questions.push(structured.question);
          if (parsed.wantsDocument && options.allowWiderScope && index === 0) return "document";
          if (parsed.passage !== null) {
            parts = structured?.parts ?? splitProtected(bases, parsed.passage);
            // Validate the entire batch before applying any paragraph. Never
            // infer missing markers or strip them to make an unsafe reply fit.
            parts.forEach((part, at) => restoreProtectedSelection(session.schema, bases[at].protection, part));
          }
          break;
        } catch (error) {
          if (attempt === 1) throw error;
          this.update(job, { detail: `Retrying format for part ${index + 1} of ${batches.length} (1/1)` });
          messages.push({ role: "assistant", content: response }, { role: "user", content:
            "Your response could not be applied: " + (error instanceof Error ? error.message : String(error)) +
            " Return one JSON object with reply and edits. Copy every id from editable_segments exactly once; " +
            "return revised text for each id or its exact original text if unchanged. Do not copy the ⟦SP: control markers. " +
            "No Markdown or text outside the JSON object. Preserve the claims, quotations, numbers and technical terms." });
        }
      }
      if (parsed?.reply) result.replies.push(parsed.reply);
      if (parsed?.passage == null) continue;
      for (let at = 0; at < bases.length; at++) {
        let rate: number | undefined;
        const before = protectedRewritePreview(bases[at].protection.protectedText, bases[at].protection);
        const after = protectedRewritePreview(parts[at], bases[at].protection);
        // Humanizer requests carry their own gate; everything else keeps to the author's edit level.
        const level = job.level;
        if (level && !options.gateChangeRate && !options.suggestOnly && before !== after && editLevelExceeded(level, changeRate(before, after))) {
          result.notes.push(`I left one paragraph unchanged ("${clip(before, 40, "start").replace(/\n\[…\]$/, "…")}"): the edit changed more than ` +
            `${percent(EDIT_LEVEL_MAX_CHANGE[level])} of it, which exceeds the ${editLevelLabel(level)} edit level. Raise the level to allow it.`);
          continue;
        }
        if (options.gateChangeRate) {
          rate = changeRate(before, after);
          if (rate >= CHANGE_RATE_ABORT) {
            result.notes.push(`I left one paragraph unchanged ("${clip(before, 40, "start").replace(/\n\[…\]$/, "…")}"): ` +
              `the rewrite changed ${percent(rate)} of it, which im-not-ai treats as over-polishing.`);
            continue;
          }
        }
        const mode = this.modeFor(attachment, bases[at].blockId);
        const outcome = applyBlockRewrite(session, bases[at], parts[at],
          options.suggestOnly && mode !== "observe" ? "suggest" : mode, AI_ORIGIN, result.changeSetId);
        result.outcomes.push(outcome);
        if (outcome.kind === "applied") {
          result.editedBlockIds.push(bases[at].blockId);
          result.paragraphsChanged.push({ blockId: bases[at].blockId, before, after, mode: outcome.mode });
        }
        if (rate !== undefined && outcome.kind === "applied") result.changeRates.push(rate);
        if (outcome.kind === "applied" && outcome.mode === "direct") this.markDirectEdit(attachment, bases[at].blockId, `comment:${thread.id}`);
      }
      this.recordEditProgress(attachment, thread, result);
      attachment.presence.release();
    }
    return result;
  }

  private recordEditProgress(attachment: Attachment, thread: ThreadSnapshot, result: EditResult) {
    const { session } = attachment;
    const suggested = result.outcomes.some((outcome) => outcome.kind === "applied" && outcome.mode === "suggest");
    if (suggested) {
      session.ydoc.transact(() => {
        session.ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP).set(String(result.changeSetId), {
          id: result.changeSetId,
          label: clip(conversationOf(thread).at(-1)?.text.replace(/\s+/g, " ") ?? "AI edit", 80, "start"),
          persona: SCHOLARPEN_AI.id,
          threadId: thread.id,
          createdAt: this.now(),
        });
      }, AI_META_ORIGIN);
    }
    this.setThread(attachment, thread.id, {
      editedBlockIds: [...new Set([...(thread.meta.editedBlockIds ?? []), ...result.editedBlockIds])],
      ...(suggested ? { changeSet: result.changeSetId } : {}),
    });
  }

  /** One revision-log entry per answered thread, for the history panel and the response letter. */
  private logRevision(attachment: Attachment, thread: ThreadSnapshot, result: EditResult, response: string, questions: string[], level?: EditLevel) {
    const { session } = attachment;
    const first = thread.comments.find(comment => !comment.deleted);
    const status = revisionStatus(result.paragraphsChanged);
    session.ydoc.transact(() => {
      recordRevision(session.ydoc.getMap<RevisionEntry>(REVISIONS_MAP), {
        createdAt: this.now(), kind: "comment",
        label: clip(conversationOf(thread).at(-1)?.text.replace(/\s+/g, " ") ?? "AI edit", 80, "start"),
        ...(status === "pending" ? { changeSetId: result.changeSetId } : {}),
        status, summary: response,
        ...(level ? { level } : {}),
        items: [{ threadId: thread.id, comment: first?.text ?? "", commentBy: first && isAIUser(first.userId) ? "ai" : "author",
          response: questions.length ? `${response} ${questions.join(" ")}`.trim() : response,
          outcome: "addressed", blockIds: result.paragraphsChanged.map(paragraph => paragraph.blockId) }],
        paragraphs: result.paragraphsChanged.map(({ blockId, before, after }) => ({ blockId, before, after })),
      });
    }, AI_META_ORIGIN);
  }

  private finishEdit(job: Job, attachment: Attachment, thread: ThreadSnapshot, result: EditResult,
    reply: (patch: Partial<ThreadMeta>, text?: string) => void) {
    this.recordEditProgress(attachment, thread, result);
    const suggested = result.outcomes.some((outcome) => outcome.kind === "applied" && outcome.mode === "suggest");
    const lead = result.summary || result.replies[0] || "";
    const changed = result.outcomes.filter((outcome) => outcome.kind === "applied").length;
    const notes = [...result.notes];
    if (result.paragraphs > MAX_BLOCKS_PER_CALL) notes.unshift(`Changed ${changed} of ${result.paragraphs} paragraphs.`);
    if (result.changeRates.length > 0) {
      const mean = result.changeRates.reduce((sum, rate) => sum + rate, 0) / result.changeRates.length;
      const high = result.changeRates.filter((rate) => rate >= CHANGE_RATE_WARN).length;
      notes.push(`Change rate ${percent(mean)} on average across the paragraphs I changed` +
        (high ? `; ${high} changed by ${percent(CHANGE_RATE_WARN)} or more, so check those first.` : "."));
    }
    const questions = [...new Set(result.questions)];
    if (questions.length) notes.push(`Question for you: ${questions.join(" ")}`);
    const { text, meta } = summarize(lead, result.outcomes, notes);
    reply({ ...meta,
      editedBlockIds: [...new Set([...(thread.meta.editedBlockIds ?? []), ...result.editedBlockIds])],
      ...(suggested ? { changeSet: result.changeSetId } : {}),
      ...(questions.length ? { decision: { question: questions.join(" "), askedAt: this.now() } } : {}),
    }, text);
    if (result.paragraphsChanged.length) this.logRevision(attachment, thread, result, lead || text, questions, job.level);
    this.update(job, { detail: meta.statusNote ?? undefined });
  }
}

function revisionStatus(paragraphs: EditResult["paragraphsChanged"]): RevisionEntry["status"] {
  return paragraphs.some(paragraph => paragraph.mode === "suggest") ? "pending" : "applied";
}

interface EditResult {
  /** Questions the model needs the author to answer before it can continue. */
  questions: string[];
  paragraphsChanged: Array<RevisionParagraph & { mode: "suggest" | "direct" }>;
  outcomes: EditOutcome[];
  editedBlockIds: string[];
  replies: string[];
  notes: string[];
  /** Change rate of each applied paragraph, when the request gates it (the humanizer). */
  changeRates: number[];
  summary?: string;
  changeSetId: number;
  paragraphs: number;
}

function percent(rate: number) {
  return `${Math.round(rate * 100)}%`;
}

function conversationOf(thread: ThreadSnapshot) {
  return thread.comments
    .filter((comment) => !comment.deleted)
    .map((comment) => ({ author: isAIUser(comment.userId) ? "ai" as const : "author" as const, text: comment.text }));
}

/** Several blocks are sent as one passage separated by a protected block marker. */
const BLOCK_SEPARATOR = (index: number) => `⟦SP:BLOCK:${index}⟧`;

function joinProtections(bases: BlockBase[]) {
  if (bases.length === 1) return bases[0].protection;
  return {
    ...bases[0].protection,
    protectedText: bases.map((base, index) => `${index > 0 ? `${BLOCK_SEPARATOR(index)}\n` : ""}${base.protection.protectedText}`).join("\n"),
  };
}

function splitProtected(bases: BlockBase[], passage: string) {
  if (bases.length === 1) return [passage];
  const parts: string[] = [];
  let rest = passage;
  for (let index = 1; index < bases.length; index++) {
    const marker = BLOCK_SEPARATOR(index);
    const at = rest.indexOf(marker);
    if (at < 0) throw new Error("The AI merged or dropped a paragraph boundary; nothing was changed.");
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at + marker.length);
  }
  parts.push(rest.trim());
  return parts;
}

const MAX_CONFLICT_PREVIEWS = 3;

function summarize(reply: string, outcomes: EditOutcome[], notes: string[] = []): { text: string; meta: Partial<ThreadMeta> } {
  const applied = outcomes.filter((outcome): outcome is Extract<EditOutcome, { kind: "applied" }> => outcome.kind === "applied");
  const conflicts = outcomes.filter((outcome): outcome is Extract<EditOutcome, { kind: "conflict" }> => outcome.kind === "conflict");
  const lines = [reply || (applied.length ? "Done." : "I didn't change the text.")];

  if (applied.some((outcome) => outcome.mode === "suggest")) {
    lines.push("My edits are marked as suggestions in the text. Accept or reject them together from this thread or the Activity panel.");
  }
  if (applied.some((outcome) => outcome.mode === "direct")) {
    lines.push("Small corrections were applied directly; you can undo them from the Activity panel.");
  }
  if (applied.some((outcome) => outcome.rebased)) {
    lines.push("You edited this passage while I worked; I merged my changes around yours.");
  }
  for (const conflict of conflicts.slice(0, MAX_CONFLICT_PREVIEWS)) {
    lines.push(`${conflict.reason} I didn't change the text. Here is what I would write:\n\n${conflict.preview}`);
  }
  if (conflicts.length > MAX_CONFLICT_PREVIEWS) {
    lines.push(`${conflicts.length - MAX_CONFLICT_PREVIEWS} more paragraphs were left as proposals for the same reason.`);
  }
  lines.push(...notes);

  if (conflicts.length > 0) {
    const observed = conflicts.every((conflict) => conflict.reason.includes("Observe"));
    return { text: lines.join("\n\n"), meta: { assignee: "me", status: "proposed",
      statusNote: observed ? "Proposal only — this section is set to Observe." : "Proposal only — the passage changed while the AI worked." } };
  }
  if (applied.length > 0) {
    return { text: lines.join("\n\n"), meta: { assignee: "me", status: "proposed", statusNote: undefined } };
  }
  return { text: lines.join("\n\n"), meta: { assignee: "me", status: "open", statusNote: undefined } };
}
