import * as Y from "yjs";
import { BUN_PEER_ID, COLLAB_FRAGMENT } from "../../../shared/collab/protocol";
import { SCHOLARPEN_AI } from "../../../shared/collab/personas";
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
  }

  /** Block ids that hold a person's cursor. */
  cursorBlocks() {
    const ids = new Set<string>();
    for (const [clientId, state] of this.session.awareness.getStates()) {
      if (clientId === this.session.ydoc.clientID) continue;
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

  /** Shows the AI selecting the block it is working on. */
  claim(blockId: string, label?: string) {
    const cursor = blockCursor(this.session, blockId);
    this.session.awareness.setLocalState({
      user: { name: label ? `${SCHOLARPEN_AI.name} · ${label}` : SCHOLARPEN_AI.name, color: SCHOLARPEN_AI.color },
      cursor,
    });
  }

  release() {
    if (this.session.awareness.getLocalState() !== null) this.session.awareness.setLocalState(null);
  }
}
