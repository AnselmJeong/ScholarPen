import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { fromBase64, toBase64 } from "lib0/buffer";
import type { Schema } from "prosemirror-model";
import {
  BUN_PEER_ID,
  COLLAB_FRAGMENT,
  collabDocKey,
  type CollabOpenParams,
  type CollabOpenResult,
  type CollabUpdateMessage,
} from "../../shared/collab/protocol";
import { schemaFromSpecJSON, type SchemaSpecJSON } from "../../shared/collab/schema-spec";

export interface CollabMeta {
  /** Hash of the JSON file the last time an editor peer saved it. */
  jsonHash: string | null;
  updatedAt: number;
}

export interface CollabStorage {
  read(projectPath: string, filename: string): Promise<{ state: Uint8Array | null; meta: CollabMeta | null }>;
  write(projectPath: string, filename: string, state: Uint8Array, meta: CollabMeta): Promise<void>;
  /** Hash of the current JSON file, or null when it does not exist. */
  jsonHash(projectPath: string, filename: string): Promise<string | null>;
}

export interface CollabTransport {
  update(message: CollabUpdateMessage): void;
  awareness(message: CollabUpdateMessage): void;
}

const PERSIST_DELAY_MS = 1000;
const SEED_TIMEOUT_MS = 15_000;

export class CollabSession {
  readonly ydoc = new Y.Doc();
  readonly awareness: Awareness;
  readonly peers = new Set<string>();
  /** Awareness client ids announced by each editor peer, removed when it closes. */
  readonly peerClients = new Map<string, Set<number>>();
  schema: Schema;
  schemaSpec: SchemaSpecJSON;
  meta: CollabMeta = { jsonHash: null, updatedAt: 0 };
  /** The peer importing the JSON document, and the hash of the JSON it imports. */
  seeding: { peerId: string; jsonHash: string | null; done: Promise<void>; resolve: () => void } | null = null;
  holds = 0;
  persistTimer: ReturnType<typeof setTimeout> | null = null;
  persisting: Promise<void> = Promise.resolve();

  constructor(
    readonly docKey: string,
    readonly projectPath: string,
    readonly filename: string,
    schemaSpec: SchemaSpecJSON,
  ) {
    this.schemaSpec = schemaSpec;
    this.schema = schemaFromSpecJSON(schemaSpec);
    this.awareness = new Awareness(this.ydoc);
    // The Bun peer has no presence until an agent claims something.
    this.awareness.setLocalState(null);
  }
}

type SessionListener = (session: CollabSession) => void;

export class CollabRegistry {
  private readonly sessions = new Map<string, CollabSession>();
  private readonly loading = new Map<string, Promise<CollabSession>>();
  private readonly openedListeners = new Set<SessionListener>();
  private readonly closedListeners = new Set<SessionListener>();

  constructor(private readonly storage: CollabStorage, private readonly transport: CollabTransport) {}

  get(docKey: string) {
    return this.sessions.get(docKey);
  }

  list() {
    return [...this.sessions.values()];
  }

  onSessionOpened(listener: SessionListener) {
    this.openedListeners.add(listener);
    return () => this.openedListeners.delete(listener);
  }

  onSessionClosed(listener: SessionListener) {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  async open(params: CollabOpenParams): Promise<CollabOpenResult> {
    const docKey = collabDocKey(params.projectPath, params.filename);
    const session = await this.load(docKey, params);
    // Keep the newest schema: the webview may have been rebuilt with new block types.
    if (JSON.stringify(session.schemaSpec) !== JSON.stringify(params.schema)) {
      session.schemaSpec = params.schema;
      session.schema = schemaFromSpecJSON(params.schema);
    }

    let bootstrap: CollabOpenResult["bootstrap"] = "none";
    if (session.seeding && session.seeding.peerId !== params.peerId) {
      await Promise.race([session.seeding.done, new Promise((r) => setTimeout(r, SEED_TIMEOUT_MS))]);
    }
    if (session.ydoc.getXmlFragment(COLLAB_FRAGMENT).length === 0 && !session.seeding) {
      bootstrap = "seed";
      let resolve!: () => void;
      const done = new Promise<void>((r) => { resolve = r; });
      session.seeding = { peerId: params.peerId, jsonHash: null, done, resolve };
      session.seeding.jsonHash = await this.storage.jsonHash(session.projectPath, session.filename);
    } else if (!session.seeding) {
      const currentHash = await this.storage.jsonHash(session.projectPath, session.filename);
      if (currentHash !== null && currentHash !== session.meta.jsonHash) bootstrap = "reconcile";
    }

    session.peers.add(params.peerId);
    const otherClients = [...session.awareness.getStates().keys()];
    return {
      docKey,
      state: toBase64(Y.encodeStateAsUpdate(session.ydoc)),
      awareness: otherClients.length > 0
        ? toBase64(encodeAwarenessUpdate(session.awareness, otherClients))
        : null,
      bootstrap,
    };
  }

  push(docKey: string, peerId: string, update: string) {
    const session = this.sessions.get(docKey);
    if (!session) throw new Error("This document is not open for collaboration.");
    Y.applyUpdate(session.ydoc, fromBase64(update), peerId);
    if (session.seeding?.peerId === peerId) {
      // The seeded Y.Doc now mirrors that JSON file.
      session.meta.jsonHash = session.seeding.jsonHash;
      session.seeding.resolve();
      session.seeding = null;
    }
  }

  pushAwareness(docKey: string, peerId: string, update: string) {
    const session = this.sessions.get(docKey);
    if (!session) return;
    applyAwarenessUpdate(session.awareness, fromBase64(update), peerId);
  }

  async close(docKey: string, peerId: string) {
    const session = this.sessions.get(docKey);
    if (!session) return;
    session.peers.delete(peerId);
    const clients = session.peerClients.get(peerId);
    if (clients?.size) removeAwarenessStates(session.awareness, [...clients], peerId);
    session.peerClients.delete(peerId);
    if (session.seeding?.peerId === peerId) {
      session.seeding.resolve();
      session.seeding = null;
    }
    await this.maybeUnload(session);
  }

  /** Called after an editor peer wrote the JSON snapshot of this document. */
  async noteJsonSaved(projectPath: string, filename: string, jsonHash: string) {
    const session = this.sessions.get(collabDocKey(projectPath, filename));
    if (session) {
      session.meta.jsonHash = jsonHash;
      this.schedulePersist(session);
      return;
    }
    const stored = await this.storage.read(projectPath, filename);
    if (!stored.state) return;
    await this.storage.write(projectPath, filename, stored.state, {
      updatedAt: stored.meta?.updatedAt ?? Date.now(),
      jsonHash,
    });
  }

  /** Keeps a session loaded while background work (an AI job) uses it. */
  hold(docKey: string) {
    const session = this.sessions.get(docKey);
    if (!session) return () => {};
    session.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.holds -= 1;
      void this.maybeUnload(session);
    };
  }

  async flush(docKey?: string) {
    const targets = docKey ? [this.sessions.get(docKey)].filter(Boolean) as CollabSession[] : this.list();
    await Promise.all(targets.map((session) => this.persistNow(session)));
  }

  async dispose() {
    await this.flush();
    for (const session of this.sessions.values()) {
      session.awareness.destroy();
      session.ydoc.destroy();
    }
    this.sessions.clear();
  }

  private async load(docKey: string, params: CollabOpenParams) {
    const existing = this.sessions.get(docKey);
    if (existing) return existing;
    const pending = this.loading.get(docKey);
    if (pending) return pending;
    const loading = (async () => {
      const session = new CollabSession(docKey, params.projectPath, params.filename, params.schema);
      const stored = await this.storage.read(params.projectPath, params.filename);
      if (stored.state) Y.applyUpdate(session.ydoc, stored.state, BUN_PEER_ID);
      if (stored.meta) session.meta = stored.meta;
      this.wire(session);
      this.sessions.set(docKey, session);
      for (const listener of this.openedListeners) listener(session);
      return session;
    })();
    this.loading.set(docKey, loading);
    try {
      return await loading;
    } finally {
      this.loading.delete(docKey);
    }
  }

  private wire(session: CollabSession) {
    session.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      session.meta.updatedAt = Date.now();
      this.schedulePersist(session);
      this.transport.update({
        docKey: session.docKey,
        origin: typeof origin === "string" ? origin : BUN_PEER_ID,
        update: toBase64(update),
      });
    });
    session.awareness.on("update", (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const peerId = typeof origin === "string" ? origin : BUN_PEER_ID;
      if (session.peers.has(peerId)) {
        const clients = session.peerClients.get(peerId) ?? new Set<number>();
        for (const id of added) clients.add(id);
        for (const id of removed) clients.delete(id);
        session.peerClients.set(peerId, clients);
      }
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      this.transport.awareness({
        docKey: session.docKey,
        origin: peerId,
        update: toBase64(encodeAwarenessUpdate(session.awareness, changed)),
      });
    });
  }

  private schedulePersist(session: CollabSession) {
    if (session.persistTimer) clearTimeout(session.persistTimer);
    session.persistTimer = setTimeout(() => {
      session.persistTimer = null;
      void this.persistNow(session);
    }, PERSIST_DELAY_MS);
  }

  private persistNow(session: CollabSession) {
    if (session.persistTimer) {
      clearTimeout(session.persistTimer);
      session.persistTimer = null;
    }
    if (session.ydoc.getXmlFragment(COLLAB_FRAGMENT).length === 0) return session.persisting;
    session.persisting = session.persisting
      .catch(() => undefined)
      .then(() => this.storage.write(
        session.projectPath,
        session.filename,
        Y.encodeStateAsUpdate(session.ydoc),
        { ...session.meta },
      ))
      .catch((error) => console.error("[collab] Could not persist", session.docKey, error));
    return session.persisting;
  }

  private async maybeUnload(session: CollabSession) {
    if (session.peers.size > 0 || session.holds > 0) return;
    await this.persistNow(session);
    if (session.peers.size > 0 || session.holds > 0) return;
    this.sessions.delete(session.docKey);
    for (const listener of this.closedListeners) listener(session);
    session.awareness.destroy();
    session.ydoc.destroy();
  }
}
