import { useState, useEffect, useCallback, useRef } from "react";

function getTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  return nodes;
}

/** Inject <mark data-find> elements around every match; returns the mark elements. */
function injectMarks(container: HTMLElement, query: string): HTMLElement[] {
  const q = query.toLowerCase().normalize("NFC");
  const marks: HTMLElement[] = [];
  // Snapshot text nodes before any mutation
  const textNodes = getTextNodes(container);

  for (const node of textNodes) {
    const raw = node.textContent ?? "";
    const lower = raw.toLowerCase().normalize("NFC");

    const positions: { s: number; e: number }[] = [];
    let start = 0;
    while ((start = lower.indexOf(q, start)) !== -1) {
      positions.push({ s: start, e: start + q.length });
      start += q.length;
    }
    if (positions.length === 0) continue;

    const parent = node.parentNode;
    if (!parent) continue;

    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const { s, e } of positions) {
      if (pos < s) frag.appendChild(document.createTextNode(raw.slice(pos, s)));
      const mark = document.createElement("mark");
      mark.setAttribute("data-find", "");
      mark.textContent = raw.slice(s, e);
      frag.appendChild(mark);
      marks.push(mark);
      pos = e;
    }
    if (pos < raw.length) frag.appendChild(document.createTextNode(raw.slice(pos)));
    parent.replaceChild(frag, node);
  }
  return marks;
}

/** Remove all injected marks and merge adjacent text nodes. */
function removeMarks(marks: HTMLElement[]) {
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }
}

/**
 * Find-in-page via DOM <mark> injection — works reliably across all content types.
 * @param containerRef  Ref to the scrollable content container.
 * @param refreshKey    Change this when the container content changes (e.g. PDF page turn)
 *                      to re-run the search.
 */
export function useTextFind(
  containerRef: React.RefObject<HTMLElement | null>,
  refreshKey?: unknown,
) {
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const marksRef = useRef<HTMLElement[]>([]);

  // Inject marks whenever query or content refreshes
  useEffect(() => {
    const container = containerRef.current;

    removeMarks(marksRef.current);
    marksRef.current = [];
    setMatchCount(0);
    setCurrentIdx(-1);

    if (!container || !query.trim()) return;

    const marks = injectMarks(container, query);
    marksRef.current = marks;
    setMatchCount(marks.length);
    setCurrentIdx(marks.length > 0 ? 0 : -1);

    return () => {
      removeMarks(marksRef.current);
      marksRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, refreshKey]);

  // Sync current-match styling and scroll
  useEffect(() => {
    const marks = marksRef.current;
    marks.forEach((m) => m.removeAttribute("data-current"));
    if (currentIdx >= 0 && currentIdx < marks.length) {
      marks[currentIdx].setAttribute("data-current", "");
      marks[currentIdx].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [currentIdx]);

  const goNext = useCallback(() => {
    setCurrentIdx((i) =>
      marksRef.current.length === 0 ? i : (i + 1) % marksRef.current.length,
    );
  }, []);

  const goPrev = useCallback(() => {
    setCurrentIdx((i) =>
      marksRef.current.length === 0
        ? i
        : (i - 1 + marksRef.current.length) % marksRef.current.length,
    );
  }, []);

  const clear = useCallback(() => {
    removeMarks(marksRef.current);
    marksRef.current = [];
    setQuery("");
    setMatchCount(0);
    setCurrentIdx(-1);
  }, []);

  return { query, setQuery, matchCount, currentIdx, goNext, goPrev, clear };
}
