import { useState, useEffect, useCallback, useRef } from "react";

// CSS highlights paint Ranges without replacing text nodes owned by React.
// Keep each mounted viewer's ranges separate so closing one cannot clear another.
const viewers = new Map<symbol, { matches: Range[]; current?: Range }>();
function paintHighlights() {
  const api = globalThis as unknown as {
    CSS?: { highlights?: Map<string, unknown> };
    Highlight?: new (...ranges: Range[]) => { priority: number; add(range: Range): void };
  };
  if (!api.CSS?.highlights || !api.Highlight) return;
  const matches = new api.Highlight();
  const current = new api.Highlight();
  for (const viewer of viewers.values()) {
    for (const range of viewer.matches) matches.add(range);
    if (viewer.current) current.add(viewer.current);
  }
  current.priority = 1;
  if (viewers.size) {
    api.CSS.highlights.set("scholar-find", matches);
    api.CSS.highlights.set("scholar-find-current", current);
  } else {
    api.CSS.highlights.delete("scholar-find");
    api.CSS.highlights.delete("scholar-find-current");
  }
}

/** Map normalized graphemes back to original UTF-16 offsets (including Korean NFD). */
export function findTextRanges(root: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];
  const q = query.normalize("NFC").toLowerCase();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script, style, textarea, [aria-hidden="true"]')) continue;
    const raw = node.textContent ?? "";
    const starts: number[] = [];
    const ends: number[] = [];
    let normalized = "";
    for (const { segment, index } of segmenter.segment(raw)) {
      const part = segment.normalize("NFC").toLowerCase();
      normalized += part;
      for (let i = 0; i < part.length; i++) { starts.push(index); ends.push(index + segment.length); }
    }
    let offset = 0;
    while ((offset = normalized.indexOf(q, offset)) !== -1) {
      const range = root.ownerDocument.createRange();
      range.setStart(node, starts[offset]);
      range.setEnd(node, ends[offset + q.length - 1]);
      ranges.push(range);
      offset += q.length;
    }
  }
  return ranges;
}

export function useTextFind(
  containerRef: React.RefObject<HTMLElement | null>,
  refreshKey?: unknown,
  enabled = true,
) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const owner = useRef(Symbol("text-find"));
  const matchesRef = useRef<Range[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    const update = () => {
      const next = container && enabled ? findTextRanges(container, query) : [];
      const previous = matchesRef.current;
      if (previous.length === next.length && previous.every((range, index) => {
        const other = next[index];
        return range.startContainer === other.startContainer && range.startOffset === other.startOffset
          && range.endContainer === other.endContainer && range.endOffset === other.endOffset;
      })) return;
      matchesRef.current = next;
      setMatches(next);
      setCurrentIdx(next.length ? 0 : -1);
    };
    update();
    if (!container || !enabled || !query.trim()) return;
    const observer = new MutationObserver(update);
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef, query, refreshKey, enabled]);

  useEffect(() => {
    const id = owner.current;
    const current = matches[currentIdx];
    if (enabled && matches.length) viewers.set(id, { matches, current });
    else viewers.delete(id);
    paintHighlights();
    if (enabled && current) {
      // Scroll without stealing keyboard focus from the search field.
      const container = containerRef.current;
      const rect = current.getBoundingClientRect?.();
      const bounds = container?.getBoundingClientRect();
      if (container && rect && bounds && (rect.top < bounds.top || rect.bottom > bounds.bottom)) {
        container.scrollTop += rect.top - bounds.top - bounds.height / 2;
      }
    }
    return () => { viewers.delete(id); paintHighlights(); };
  }, [matches, currentIdx, enabled, containerRef]);

  const goNext = useCallback(() => {
    setCurrentIdx(i => matches.length ? (i + 1) % matches.length : -1);
  }, [matches.length]);
  const goPrev = useCallback(() => {
    setCurrentIdx(i => matches.length ? (i - 1 + matches.length) % matches.length : -1);
  }, [matches.length]);
  const clear = useCallback(() => {
    matchesRef.current = [];
    setQuery(""); setMatches([]); setCurrentIdx(-1);
  }, []);
  return { query, setQuery, matchCount: matches.length, currentIdx, goNext, goPrev, clear };
}
