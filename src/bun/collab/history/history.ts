import * as Y from "yjs";
import { fromBase64, toBase64 } from "lib0/buffer";
import { COLLAB_FRAGMENT } from "../../../shared/collab/protocol";
import {
  blockTexts,
  historyStats,
  type HistoryBlock,
  type HistoryEntry,
  type HistoryEntryKind,
  type HistoryVersion,
} from "../../../shared/collab/history";
import type { CollabRegistry, CollabSession } from "../registry";
import { bytesEqual, covers, encodeCheckpoint, readFragment, readVersion, type DeleteSet } from "./encode";
import { mergeEntries, planThinning, type StoredEntry } from "./thinning";
import type { HistoryIndex, HistoryStorage } from "./store";

/** Transaction origin of the AI agent's document edits (see agent.ts). */
const AI_ORIGIN = "ai-agent";
const THIN_INTERVAL_MS = 60 * 60_000;

type Actor = "author" | "ai" | "system";

export interface HistoryDeps {
  now?: () => number;
  /** What the AI is doing in the document right now, for the entry's label. */
  aiLabel?: (docKey: string) => string | undefined;
  /** Whether an AI job is still editing the document; its edits stay one entry until it ends. */
  aiBusy?: (docKey: string) => boolean;
  /** A visible entry was added or changed. */
  onChanged?: (docKey: string) => void;
  /** Pause in the author's typing that ends a checkpoint. */
  idleMs?: number;
  /** Pause after AI or other edits that ends a checkpoint. */
  aiIdleMs?: number;
  /** Longest stretch of continuous typing in one checkpoint. */
  maxEntryMs?: number;
}

interface OpenEntry {
  actor: Actor;
  kind: HistoryEntryKind;
  /** Label that comes with the origin itself (undo, opening from file); a different one starts a new entry. */
  special?: string;
  label?: string;
  startedAt: number;
  lastAt: number;
}

export interface CheckpointOptions {
  kind?: HistoryEntryKind;
  label?: string;
  /** Write even when the accepted manuscript did not change, so nothing is left unrecorded. */
  force?: boolean;
}

function view(entry: StoredEntry): HistoryEntry {
  const { seq: _seq, hidden: _hidden, ...rest } = entry;
  return rest;
}

/**
 * Records one open document's history. Every change to the shared Y.Doc is
 * kept; changes are grouped into checkpoints at natural boundaries (the author
 * pauses, an AI job starts or ends, a suggestion is accepted, a version is
 * restored) and each checkpoint is written as the Yjs update it added. Any
 * checkpoint's document is rebuilt by replaying the checkpoints up to it.
 */
export class DocumentHistory {
  private readonly fragment: Y.XmlFragment;
  private readonly now: () => number;
  private open: OpenEntry | null = null;
  /** State vector at the last written checkpoint. */
  private since: Uint8Array;
  private deletions: DeleteSet[] = [];
  /** The accepted manuscript at the last written checkpoint. */
  private blocks: HistoryBlock[];
  private index: HistoryIndex | null = null;
  private io: Promise<unknown>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly chunks = new Map<number, Uint8Array>();
  private lastThinAt = 0;
  private closed = false;

  constructor(readonly session: CollabSession, private readonly storage: HistoryStorage, private readonly deps: HistoryDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.fragment = session.ydoc.getXmlFragment(COLLAB_FRAGMENT);
    const state = Y.encodeStateAsUpdate(session.ydoc);
    this.since = Y.encodeStateVector(session.ydoc);
    this.blocks = this.readBlocks();
    session.ydoc.on("beforeTransaction", this.before);
    session.ydoc.on("afterTransaction", this.after);
    this.io = this.load(state, this.since, this.blocks)
      .catch((error) => console.error("[history] Could not load", session.docKey, error));
  }

  private get idleMs() { return this.deps.idleMs ?? 10_000; }
  private get aiIdleMs() { return this.deps.aiIdleMs ?? 4_000; }
  private get maxEntryMs() { return this.deps.maxEntryMs ?? 5 * 60_000; }

  private readBlocks() {
    return blockTexts(readFragment(this.session.ydoc, this.session.schema));
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.io.then(op);
    this.io = run.catch((error) => console.error("[history]", this.session.docKey, error));
    return run;
  }

  private async load(state: Uint8Array, sv: Uint8Array, blocks: HistoryBlock[]) {
    const { projectPath, filename } = this.session;
    let index: HistoryIndex | null = null;
    try {
      index = await this.storage.readIndex(projectPath, filename);
    } catch (error) {
      console.warn("[history] Unreadable history, starting a new one", this.session.docKey, error);
      await this.storage.archive(projectPath, filename);
    }
    const live = Y.decodeStateVector(sv);
    if (index && !covers(live, Y.decodeStateVector(fromBase64(index.baseSv)))) {
      // The Y.Doc was recreated (its state was lost or replaced), so this history belongs to another document.
      await this.storage.archive(projectPath, filename);
      index = null;
    }
    const now = this.now();
    if (!index) {
      index = { version: 1, nextSeq: 1, baseSv: toBase64(sv), headSv: toBase64(sv), entries: [] };
      await this.storage.writeChunk(projectPath, filename, 0, state);
      this.chunks.set(0, state);
      index.entries.push({
        id: "0", seq: 0, kind: "start", startedAt: now, endedAt: now,
        stats: historyStats([], blocks), hidden: blocks.length === 0 || undefined,
      });
    } else if (!covers(Y.decodeStateVector(fromBase64(index.headSv)), live)) {
      // Changes the history never saw: an older app version, or a quit before the last checkpoint was written.
      const chunk = Y.diffUpdate(state, fromBase64(index.headSv));
      const before = blockTexts(await this.rebuild(index.entries, index.entries.length - 1));
      const stats = historyStats(before, blocks);
      const seq = index.nextSeq++;
      await this.storage.writeChunk(projectPath, filename, seq, chunk);
      this.chunks.set(seq, chunk);
      index.entries.push({ id: String(seq), seq, kind: "outside", startedAt: now, endedAt: now, stats, hidden: stats.blocks === 0 || undefined });
    }
    index.headSv = toBase64(sv);
    this.index = index;
    await this.writeIndex();
    await this.thin();
  }

  private classify(origin: unknown): { actor: Actor; kind: HistoryEntryKind; label?: string } {
    if (origin === AI_ORIGIN) return { actor: "ai", kind: "ai" };
    if (origin instanceof Y.UndoManager) return { actor: "ai", kind: "ai", label: "Undid an AI edit" };
    if (typeof origin === "string" && this.session.peers.has(origin)) {
      return this.session.seeding?.peerId === origin
        ? { actor: "author", kind: "start", label: "Opened from file" }
        : { actor: "author", kind: "author" };
    }
    return { actor: "system", kind: "system" };
  }

  /** Ends the open checkpoint before a change from someone else, or after a pause, is applied. */
  private readonly before = (tr: Y.Transaction) => {
    const open = this.open;
    if (!open) return;
    const next = this.classify(tr.origin);
    if (next.actor === "system") return;
    const now = this.now();
    if (next.actor !== open.actor || next.kind !== open.kind || next.label !== open.special
      || (open.actor === "author" && (now - open.lastAt > this.idleMs || now - open.startedAt > this.maxEntryMs))) {
      void this.checkpoint();
    }
  };

  private readonly after = (tr: Y.Transaction) => {
    if (tr.deleteSet.clients.size > 0) this.deletions.push(tr.deleteSet);
    if (!tr.changedParentTypes.has(this.fragment as Y.AbstractType<any>)) return;
    const next = this.classify(tr.origin);
    const now = this.now();
    if (!this.open) {
      this.open = {
        actor: next.actor, kind: next.kind, special: next.label, startedAt: now, lastAt: now,
        label: next.label ?? (next.actor === "ai" ? this.deps.aiLabel?.(this.session.docKey) : undefined),
      };
    } else if (next.actor === this.open.actor) {
      this.open.lastAt = now;
      if (!this.open.label && this.open.actor === "ai") this.open.label = this.deps.aiLabel?.(this.session.docKey);
    }
    this.arm();
  };

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    const delay = this.open?.actor === "author" ? this.idleMs : this.aiIdleMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.open) return;
      if (this.open.actor === "ai" && this.deps.aiBusy?.(this.session.docKey)) {
        this.arm();
        return;
      }
      void this.checkpoint();
    }, delay);
  }

  /**
   * Closes the open checkpoint and writes it. Changes that leave the accepted
   * manuscript as it was (comment anchors, pending suggestions) are carried
   * into the next checkpoint instead of becoming an entry of their own.
   */
  checkpoint(options: CheckpointOptions = {}): Promise<StoredEntry | null> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const open = this.open;
    this.open = null;
    const doc = this.session.ydoc;
    const sv = Y.encodeStateVector(doc);
    const deletions = Y.mergeDeleteSets(this.deletions);
    this.deletions = deletions.clients.size > 0 ? [deletions] : [];
    if (bytesEqual(sv, this.since) && deletions.clients.size === 0) return this.enqueue(async () => null);
    const blocks = this.readBlocks();
    const stats = historyStats(this.blocks, blocks);
    const hidden = stats.blocks === 0;
    if (hidden && !options.force) return this.enqueue(async () => null);

    const chunk = encodeCheckpoint(doc, this.since, deletions);
    this.since = sv;
    this.deletions = [];
    this.blocks = blocks;
    const now = this.now();
    const label = options.label ?? open?.label;
    const meta = {
      kind: options.kind ?? (hidden ? "system" : open?.kind ?? "system"),
      startedAt: open?.startedAt ?? now,
      endedAt: now,
      ...(label ? { label } : {}),
      stats,
      ...(hidden ? { hidden } : {}),
    } satisfies Omit<StoredEntry, "id" | "seq">;
    const { projectPath, filename, docKey } = this.session;
    return this.enqueue(async () => {
      const index = this.index;
      if (!index) return null;
      const seq = index.nextSeq++;
      await this.storage.writeChunk(projectPath, filename, seq, chunk);
      this.chunks.set(seq, chunk);
      const entry: StoredEntry = { id: String(seq), seq, ...meta };
      index.entries.push(entry);
      index.headSv = toBase64(sv);
      await this.writeIndex();
      if (!hidden) this.deps.onChanged?.(docKey);
      if (now - this.lastThinAt > THIN_INTERVAL_MS) await this.thin();
      return entry;
    });
  }

  /** Visible checkpoints, oldest first. */
  list(): Promise<HistoryEntry[]> {
    return this.enqueue(async () => (this.index?.entries ?? []).filter((entry) => !entry.hidden).map(view));
  }

  /** The accepted document as it was right after a checkpoint. */
  version(entryId: string): Promise<HistoryVersion | null> {
    return this.enqueue(async () => {
      const entries = this.index?.entries ?? [];
      const at = entries.findIndex((entry) => entry.id === entryId);
      if (at < 0) return null;
      return { entryId, doc: (await this.rebuild(entries, at)).toJSON() };
    });
  }

  /** Names a checkpoint; without an id, the current state (closing the open checkpoint first). */
  async name(entryId: string | undefined, name: string): Promise<HistoryEntry | null> {
    if (!entryId) await this.checkpoint();
    return this.enqueue(async () => {
      const index = this.index;
      if (!index) return null;
      const entry = entryId
        ? index.entries.find((item) => item.id === entryId)
        : index.entries.findLast((item) => !item.hidden);
      if (!entry) return null;
      const trimmed = name.trim().slice(0, 120);
      if (trimmed) entry.name = trimmed;
      else delete entry.name;
      await this.writeIndex();
      this.deps.onChanged?.(this.session.docKey);
      return view(entry);
    });
  }

  /** Writes whatever is still open. */
  flush() {
    return this.checkpoint({ force: true }).then(() => this.io);
  }

  /** Stops recording; the document's Y.Doc is about to be destroyed. */
  close() {
    if (this.closed) return this.io;
    this.closed = true;
    this.session.ydoc.off("beforeTransaction", this.before);
    this.session.ydoc.off("afterTransaction", this.after);
    return this.flush();
  }

  private async chunk(seq: number) {
    const cached = this.chunks.get(seq);
    if (cached) return cached;
    const data = await this.storage.readChunk(this.session.projectPath, this.session.filename, seq);
    if (!data) throw new Error("A history file of this document is missing.");
    this.chunks.set(seq, data);
    return data;
  }

  private async rebuild(entries: StoredEntry[], at: number) {
    const updates = await Promise.all(entries.slice(0, at + 1).map((entry) => this.chunk(entry.seq)));
    return readVersion(updates, this.session.schema);
  }

  private writeIndex() {
    return this.storage.writeIndex(this.session.projectPath, this.session.filename, this.index!);
  }

  private async thin() {
    const index = this.index;
    if (!index) return;
    this.lastThinAt = this.now();
    const runs = planThinning(index.entries, this.lastThinAt);
    if (runs.length === 0) return;
    const { projectPath, filename } = this.session;
    const merged = new Map<number, StoredEntry>();
    const removed: number[] = [];
    for (const run of runs) {
      const members = index.entries.slice(run.from, run.to + 1);
      const chunk = Y.mergeUpdates(await Promise.all(members.map((entry) => this.chunk(entry.seq))));
      const seq = index.nextSeq++;
      await this.storage.writeChunk(projectPath, filename, seq, chunk);
      this.chunks.set(seq, chunk);
      merged.set(run.from, mergeEntries(members, seq));
      removed.push(...members.map((entry) => entry.seq));
    }
    const entries: StoredEntry[] = [];
    for (let i = 0; i < index.entries.length; i++) {
      const run = runs.find((item) => item.from === i);
      if (!run) {
        entries.push(index.entries[i]);
        continue;
      }
      entries.push(merged.get(i)!);
      i = run.to;
    }
    index.entries = entries;
    await this.writeIndex();
    for (const seq of removed) {
      this.chunks.delete(seq);
      await this.storage.deleteChunk(projectPath, filename, seq).catch(() => undefined);
    }
  }
}

/** Keeps a DocumentHistory for every document open in the collaboration registry. */
export class CollabHistory {
  private readonly docs = new Map<string, DocumentHistory>();
  private readonly unsubscribe: Array<() => unknown>;

  constructor(registry: CollabRegistry, private readonly storage: HistoryStorage, private readonly deps: HistoryDeps = {}) {
    for (const session of registry.list()) this.attach(session);
    this.unsubscribe = [
      registry.onSessionOpened((session) => this.attach(session)),
      registry.onSessionClosed((session) => {
        const history = this.docs.get(session.docKey);
        this.docs.delete(session.docKey);
        void history?.close();
      }),
    ];
  }

  private attach(session: CollabSession) {
    if (!this.docs.has(session.docKey)) this.docs.set(session.docKey, new DocumentHistory(session, this.storage, this.deps));
  }

  private get(docKey: string) {
    const history = this.docs.get(docKey);
    if (!history) throw new Error("This document is not open.");
    return history;
  }

  list(docKey: string) { return this.get(docKey).list(); }
  version(docKey: string, entryId: string) { return this.get(docKey).version(entryId); }
  async checkpoint(docKey: string, options: Pick<CheckpointOptions, "kind" | "label"> = {}) {
    const entry = await this.get(docKey).checkpoint(options);
    return entry ? view(entry) : null;
  }
  name(docKey: string, entryId: string | undefined, name: string) { return this.get(docKey).name(entryId, name); }

  async flush() {
    await Promise.all([...this.docs.values()].map((history) => history.flush()));
  }

  async dispose() {
    for (const off of this.unsubscribe) off();
    await Promise.all([...this.docs.values()].map((history) => history.close()));
    this.docs.clear();
  }
}
