import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { BUN_PEER_ID, COLLAB_FRAGMENT } from "../../../shared/collab/protocol";
import { DEFAULT_PERSONA_ID, PERSONAS, type Persona } from "../../../shared/collab/personas";
import type { CollabSession } from "../registry";
import { blockCursor, yBlockIdOf } from "./doc-model";

/** Blocks a person touched within this window are left alone by the AI. */
export const RECENT_EDIT_MS = 8_000;


/** Adding or resolving a comment re-marks text; that is not someone writing there. */
function isCommentMarkOnly(event: Y.YEvent<any>) {
  if (!(event instanceof Y.YTextEvent)) return false;
  return event.delta.every((op) =>
    op.retain !== undefined && !!op.attributes &&
    Object.keys(op.attributes).every((key) => /^comment(--|$)/.test(key)));
}

/**
 * Tracks where people are working in one shared document (cursor block and
 * recently edited blocks) and publishes the AI's own claim as a collaboration
 * cursor, which BlockNote renders like any other collaborator.
 */
export class PresenceTracker {
  private readonly touched = new Map<string, number>();
  /** Extra awareness clients so each non-default persona shows its own cursor. */
  private readonly personaAwareness = new Map<string, Awareness>();
  private readonly observer: (events: Array<Y.YEvent<any>>, transaction: Y.Transaction) => void;

  constructor(private readonly session: CollabSession, private readonly now: () => number = Date.now) {
    this.observer = (events, transaction) => {
      const origin = transaction.origin;
      // Only editor peers count as people; Bun-originated changes are the AI's.
      if (typeof origin !== "string" || origin === BUN_PEER_ID || !session.peers.has(origin)) return;
      const at = this.now();
      for (const event of events) {
        if (isCommentMarkOnly(event)) continue;
        const id = yBlockIdOf(event.target);
        if (id) this.touched.set(id, at);
      }
    };
    session.ydoc.getXmlFragment(COLLAB_FRAGMENT).observeDeep(this.observer);
  }

  destroy() {
    this.session.ydoc.getXmlFragment(COLLAB_FRAGMENT).unobserveDeep(this.observer);
    this.release();
    for (const awareness of this.personaAwareness.values()) {
      removeAwarenessStates(this.session.awareness, [awareness.clientID], "persona");
      awareness.destroy();
    }
    this.personaAwareness.clear();
  }

  /** Awareness client ids that belong to AI personas rather than people. */
  private aiClients() {
    return new Set([this.session.ydoc.clientID, ...[...this.personaAwareness.values()].map((a) => a.clientID)]);
  }

  /** Block ids that hold a person's cursor. */
  cursorBlocks() {
    const ids = new Set<string>();
    const ai = this.aiClients();
    for (const [clientId, state] of this.session.awareness.getStates()) {
      if (ai.has(clientId)) continue;
      const cursor = (state as { cursor?: { anchor?: unknown; head?: unknown } }).cursor;
      for (const position of [cursor?.anchor, cursor?.head]) {
        if (!position) continue;
        try {
          const absolute = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(position),
            this.session.ydoc,
          );
          const id = absolute ? yBlockIdOf(absolute.type) : null;
          if (id) ids.add(id);
        } catch {
          // A cursor in deleted content resolves to nothing.
        }
      }
    }
    return ids;
  }

  /** True while a person is in or has just edited the block. */
  isBusy(blockId: string) {
    const touchedAt = this.touched.get(blockId);
    if (touchedAt !== undefined && this.now() - touchedAt < RECENT_EDIT_MS) return true;
    return this.cursorBlocks().has(blockId);
  }

  lastTouched(blockId: string) {
    return this.touched.get(blockId) ?? 0;
  }

  private awarenessFor(persona: Persona) {
    if (persona.id === DEFAULT_PERSONA_ID) return this.session.awareness;
    let awareness = this.personaAwareness.get(persona.id);
    if (!awareness) {
      awareness = new Awareness(new Y.Doc());
      awareness.setLocalState(null);
      const own = awareness;
      // Relay this persona's presence through the session so editors render it.
      own.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length) applyAwarenessUpdate(this.session.awareness, encodeAwarenessUpdate(own, changed), `persona:${persona.id}`);
      });
      this.personaAwareness.set(persona.id, own);
    }
    return awareness;
  }

  /** Shows the persona selecting the block it is working on. */
  claim(blockId: string, label?: string, persona: Persona = PERSONAS[0]) {
    const cursor = blockCursor(this.session, blockId);
    this.awarenessFor(persona).setLocalState({
      user: { name: label ? `${persona.name} · ${label}` : persona.name, color: persona.color },
      cursor,
    });
  }

  release(persona?: Persona) {
    const targets = persona ? [this.awarenessFor(persona)] : [this.session.awareness, ...this.personaAwareness.values()];
    for (const awareness of targets) {
      if (awareness.getLocalState() !== null) awareness.setLocalState(null);
    }
  }
}
