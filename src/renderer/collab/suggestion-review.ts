import { createExtension, type ExtensionOptions } from "@blocknote/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { hunkSignature, listHunks, type SuggestionHunk } from "./suggestion-hunks";

/**
 * How pending AI suggestions read in the editor.
 *
 * "clean": the manuscript reads as the AI left it — removed text is hidden,
 * added text carries a thin underline, and a bar in the gutter marks each
 * changed paragraph. The original of one change is shown on request (click
 * or step through with the review bar).
 * "markup": classic redline, removed text struck through next to the new text.
 */
export type ReviewMode = "clean" | "markup";

/** UI state shared by the plugin (decorations) and the review bar (React). */
export interface ReviewStore {
  mode: ReviewMode;
  /** Index into the current hunk list of the change being looked at, or null. */
  active: number | null;
  /** True while the popover for the active change is open. */
  open: boolean;
  /** Reported by the plugin: pending changes and how many are still arriving. */
  hunks: SuggestionHunk[];
  arriving: number;
  /** Bumped on every change, for useSyncExternalStore. */
  version: number;
  /** Changes what the author is looking at; the plugin redraws. */
  set(patch: Partial<Pick<ReviewStore, "mode" | "active" | "open">>): void;
  /** The plugin reports what it sees; only the UI listens. */
  report(patch: Partial<Pick<ReviewStore, "hunks" | "arriving">>): void;
  subscribe(listener: () => void): () => void;
  subscribePlugin(listener: () => void): () => void;
}

const MODE_KEY = "scholarpen.review-mode";

function readMode(): ReviewMode {
  try { return localStorage.getItem(MODE_KEY) === "markup" ? "markup" : "clean"; } catch { return "clean"; }
}

export function createReviewStore(): ReviewStore {
  const ui = new Set<() => void>();
  const plugin = new Set<() => void>();
  const store: ReviewStore = {
    mode: readMode(),
    active: null,
    open: false,
    hunks: [],
    arriving: 0,
    version: 0,
    set(patch) {
      Object.assign(store, patch);
      store.version++;
      if (patch.mode) try { localStorage.setItem(MODE_KEY, patch.mode); } catch { /* per-viewer convenience only */ }
      for (const listener of [...plugin, ...ui]) listener();
    },
    report(patch) {
      Object.assign(store, patch);
      store.version++;
      for (const listener of ui) listener();
    },
    subscribe(listener) {
      ui.add(listener);
      return () => { ui.delete(listener); };
    },
    subscribePlugin(listener) {
      plugin.add(listener);
      return () => { plugin.delete(listener); };
    },
  };
  return store;
}

/** Timing of the arrival animation: first strike, then write. */
export const STRIKE_MS = 750;
const WRITE_STEP_MS = 35;
const WRITE_MAX_MS = 1400;

type Phase = "strike" | "write";
interface Arrival { from: number; to: number; phase: Phase; hunk: SuggestionHunk }
interface ReviewState {
  hunks: SuggestionHunk[];
  signatures: Set<string>;
  seenIds: Set<string>;
  arrivals: Arrival[];
  decorations: DecorationSet;
}

export const suggestionReviewKey = new PluginKey<ReviewState>("scholarpen-suggestion-review");
type ReviewMeta = { refresh?: true; advance?: Phase | "done"; batch?: number };

function reducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** y-prosemirror marks transactions that come from the shared Y.Doc (the Bun AI peer). */
function isRemote(tr: Transaction) {
  return !!(tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin;
}

/** The document arrives from the Y.Doc right after mounting; that is not the AI writing. */
const SETTLE_MS = 2_000;

function blockPositions(doc: PMNode, hunks: SuggestionHunk[]) {
  const wanted = new Set(hunks.map((hunk) => hunk.blockId).filter(Boolean));
  const found: Array<{ pos: number; size: number }> = [];
  if (!wanted.size) return found;
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockContainer") return true;
    if (wanted.has(node.attrs.id)) found.push({ pos, size: node.nodeSize });
    return true;
  });
  return found;
}

/** Splits [from, to) of the document text into word-sized ranges for the typing reveal. */
function wordRanges(doc: PMNode, from: number, to: number) {
  const ranges: Array<{ from: number; to: number }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (!node.isText) { ranges.push({ from: start, to: end }); return false; }
    const text = (node.text ?? "").slice(start - pos, end - pos);
    const pattern = /\S+\s*|\s+/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) ranges.push({ from: start + match.index, to: start + match.index + match[0].length });
    return false;
  });
  return ranges;
}

function buildDecorations(doc: PMNode, state: Omit<ReviewState, "decorations">, store: ReviewStore) {
  const decorations: Decoration[] = [];
  const animating = new Set(state.arrivals.map((arrival) => arrival.from));
  for (const { pos, size } of blockPositions(doc, state.hunks)) {
    const live = state.arrivals.some((arrival) => arrival.from >= pos && arrival.to <= pos + size);
    decorations.push(Decoration.node(pos, pos + size, { class: live ? "sp-sugg-block sp-sugg-block-live" : "sp-sugg-block" }));
  }
  state.hunks.forEach((hunk, index) => {
    const active = store.active === index;
    for (const range of hunk.deletions) {
      decorations.push(Decoration.inline(range.from, range.to, { class: active ? "sp-hunk sp-hunk-active" : "sp-hunk", "data-hunk": String(index) }));
    }
    for (const range of hunk.insertions) {
      decorations.push(Decoration.inline(range.from, range.to, { class: active ? "sp-hunk sp-hunk-active" : "sp-hunk", "data-hunk": String(index) }));
    }
    // A change that only removes text leaves a small mark where the text was.
    if (!hunk.insertions.length && !animating.has(hunk.from)) {
      decorations.push(Decoration.widget(hunk.to, () => {
        const marker = document.createElement("span");
        marker.className = active ? "sp-del-marker sp-hunk-active" : "sp-del-marker";
        marker.dataset.hunk = String(index);
        marker.title = "Removed text — click to see it";
        return marker;
      }, { side: -1, key: `del-marker-${index}-${active ? 1 : 0}`, ignoreSelection: true }));
    }
  });
  for (const arrival of state.arrivals) {
    const { hunk } = arrival;
    for (const range of hunk.deletions) {
      decorations.push(Decoration.inline(range.from, range.to, { class: `sp-arrive-del sp-arrive-${arrival.phase}` }));
    }
    let word = 0;
    const total = hunk.insertions.reduce((count, range) => count + wordRanges(doc, range.from, range.to).length, 0);
    const step = total ? Math.min(WRITE_STEP_MS, WRITE_MAX_MS / total) : WRITE_STEP_MS;
    for (const range of hunk.insertions) {
      for (const piece of wordRanges(doc, range.from, range.to)) {
        decorations.push(Decoration.inline(piece.from, piece.to, {
          class: `sp-arrive-ins sp-arrive-${arrival.phase}`,
          style: arrival.phase === "write" ? `animation-delay:${Math.round(word * step)}ms` : "",
        }));
        word++;
      }
    }
  }
  return DecorationSet.create(doc, decorations);
}

/**
 * Renders pending AI suggestions as reviewable changes and plays the
 * "strike, then write" arrival when the AI adds new ones.
 */
export const SuggestionReviewExtension = createExtension(({ options }: ExtensionOptions<{ store: ReviewStore }>) => {
  const { store } = options;
  let batch = 0;
  let quietUntil = Date.now() + SETTLE_MS;
  return {
    key: "suggestionReview",
    prosemirrorPlugins: [new Plugin<ReviewState>({
      key: suggestionReviewKey,
      state: {
        init: (_, state: EditorState) => {
          const hunks = listHunks(state.doc);
          const base = {
            hunks,
            signatures: new Set(hunks.map(hunkSignature)),
            seenIds: new Set(hunks.map((hunk) => String(hunk.id))),
            arrivals: [] as Arrival[],
          };
          return { ...base, decorations: buildDecorations(state.doc, base, store) };
        },
        apply: (tr, previous, _old, newState) => {
          const meta = tr.getMeta(suggestionReviewKey) as ReviewMeta | undefined;
          if (!tr.docChanged && !meta) return previous;
          let { arrivals, signatures, seenIds, hunks } = previous;
          if (tr.docChanged) {
            hunks = listHunks(newState.doc);
            const remote = isRemote(tr);
            const fresh = reducedMotion() || Date.now() < quietUntil ? [] : hunks.filter((hunk) =>
              !signatures.has(hunkSignature(hunk)) && (remote || !seenIds.has(String(hunk.id))));
            arrivals = arrivals.flatMap((arrival) => {
              const from = tr.mapping.map(arrival.from, 1);
              const to = tr.mapping.map(arrival.to, -1);
              const hunk = hunks.find((item) => item.from === from && item.id === arrival.hunk.id);
              return hunk && to > from ? [{ ...arrival, from, to: hunk.to, hunk }] : [];
            });
            for (const hunk of fresh) {
              if (arrivals.some((arrival) => arrival.from === hunk.from)) continue;
              arrivals.push({ from: hunk.from, to: hunk.to, phase: "strike", hunk });
            }
            signatures = new Set(hunks.map(hunkSignature));
            seenIds = new Set([...seenIds, ...hunks.map((hunk) => String(hunk.id))]);
          }
          if (meta?.advance === "write") arrivals = arrivals.map((arrival) => ({ ...arrival, phase: "write" as const }));
          if (meta?.advance === "done") arrivals = [];
          const base = { hunks, signatures, seenIds, arrivals };
          return { ...base, decorations: buildDecorations(newState.doc, base, store) };
        },
      },
      props: {
        decorations: (state) => suggestionReviewKey.getState(state)?.decorations,
        handleClick: (_view, _pos, event) => {
          const target = (event.target as HTMLElement | null)?.closest?.("[data-hunk]") as HTMLElement | null;
          if (!target) return false;
          const index = Number(target.dataset.hunk);
          if (!Number.isFinite(index)) return false;
          // Let the click place the caret first; the redraw follows.
          queueMicrotask(() => store.set({ active: index, open: true }));
          return false;
        },
      },
      view: (view: EditorView) => {
        quietUntil = Date.now() + SETTLE_MS;
        let timers: Array<ReturnType<typeof setTimeout>> = [];
        let lastArrivals = 0;
        const dispatch = (meta: ReviewMeta) => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(suggestionReviewKey, meta).setMeta("addToHistory", false));
        };
        const unsubscribe = store.subscribePlugin(() => dispatch({ refresh: true }));
        const schedule = (state: ReviewState | undefined) => {
          const strikes = state?.arrivals.filter((arrival) => arrival.phase === "strike").length ?? 0;
          if (strikes && strikes !== lastArrivals) {
            // Restart the sequence whenever another batch of changes lands.
            for (const timer of timers) clearTimeout(timer);
            const current = ++batch;
            const writeFor = Math.max(...(state?.arrivals ?? []).map((arrival) =>
              Math.min(WRITE_MAX_MS, arrival.hunk.inserted.split(/\s+/).length * WRITE_STEP_MS))) + 450;
            timers = [
              setTimeout(() => { if (current === batch) dispatch({ advance: "write" }); }, STRIKE_MS),
              setTimeout(() => { if (current === batch) dispatch({ advance: "done" }); }, STRIKE_MS + writeFor),
            ];
          }
          lastArrivals = strikes;
          const hunks = state?.hunks ?? [];
          const arriving = state?.arrivals.length ?? 0;
          if (hunks !== store.hunks || arriving !== store.arriving) store.report({ hunks, arriving });
        };
        schedule(suggestionReviewKey.getState(view.state));
        return {
          update: (current) => schedule(suggestionReviewKey.getState(current.state)),
          destroy: () => {
            unsubscribe();
            for (const timer of timers) clearTimeout(timer);
          },
        };
      },
    })],
  } as const;
});

