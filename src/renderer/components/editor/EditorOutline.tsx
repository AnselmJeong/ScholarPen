import React, { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronRight, ListTree, PanelRightClose } from "lucide-react";
import type { scholarSchema } from "../../blocks/schema";
import {
  buildDocumentOutline, visibleActiveHeading, visibleOutlineHeadings,
  type DocumentOutline, type OutlineHeading,
} from "../../utils/document-outline";

interface EditorOutlineProps {
  editor: typeof scholarSchema.BlockNoteEditor;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  id: string;
  ready: boolean;
  visible: boolean;
  onClose: () => void;
}

function sameHeadings(left: OutlineHeading[], right: OutlineHeading[]) {
  return left.length === right.length && left.every((item, index) => {
    const next = right[index];
    return item.id === next.id && item.title === next.title && item.level === next.level
      && item.parentId === next.parentId && item.depth === next.depth && item.hasChildren === next.hasChildren;
  });
}

export function EditorOutline({ editor, scrollContainerRef, id, ready, visible, onClose }: EditorOutlineProps) {
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const outlineRef = useRef<DocumentOutline>({ headings: [], sectionByBlock: new Map() });
  const navigationRef = useRef<{ id: string; scrollTop: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const root = editor.domElement;
    if (!ready || !visible || !container || !root) return;
    let frame = 0;
    let rebuild = true;
    let mode: "scroll" | "selection" = "scroll";
    const update = () => {
      frame = 0;
      // Inactive document tabs stay mounted; wait until their pane is visible.
      if (!container.clientHeight) return;
      if (rebuild) {
        rebuild = false;
        outlineRef.current = buildDocumentOutline(editor.document);
        const next = outlineRef.current.headings;
        setHeadings((previous) => sameHeadings(previous, next) ? previous : next);
        const ids = new Set(next.map((heading) => heading.id));
        setCollapsed((previous) => [...previous].every((item) => ids.has(item))
          ? previous : new Set([...previous].filter((item) => ids.has(item))));
      }
      const outline = outlineRef.current;
      if (mode === "selection" && editor.isFocused()) {
        setActiveId(outline.sectionByBlock.get(editor.getTextCursorPosition().block.id) ?? null);
        return;
      }
      const navigation = navigationRef.current;
      if (navigation && Math.abs(navigation.scrollTop - container.scrollTop) < 1
        && outline.sectionByBlock.has(navigation.id)) {
        setActiveId(navigation.id);
        return;
      }
      navigationRef.current = null;
      const top = container.getBoundingClientRect().top + 32;
      let current = outline.headings[0]?.id ?? null;
      for (const heading of outline.headings) {
        const element = root.querySelector<HTMLElement>(`[data-id="${CSS.escape(heading.id)}"]`);
        if (!element || !element.getClientRects().length) continue;
        if (element.getBoundingClientRect().top > top) break;
        current = heading.id;
      }
      setActiveId(current);
    };
    const schedule = (nextMode: typeof mode = "scroll", changed = false) => {
      mode = nextMode;
      rebuild ||= changed;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const offChange = editor.onChange(() => schedule(editor.isFocused() ? "selection" : "scroll", true));
    const offSelection = editor.onSelectionChange(() => schedule("selection"));
    const onScroll = () => schedule();
    const resize = new ResizeObserver(() => schedule());
    resize.observe(container);
    resize.observe(root);
    container.addEventListener("scroll", onScroll, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      offChange(); offSelection();
      resize.disconnect();
      container.removeEventListener("scroll", onScroll);
    };
  }, [editor, ready, visible, scrollContainerRef]);

  const items = useMemo(() => visibleOutlineHeadings(headings, collapsed), [headings, collapsed]);
  const highlightedId = useMemo(() => visibleActiveHeading(headings, items, activeId), [headings, items, activeId]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !highlightedId || !visible) return;
    const row = list.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(highlightedId)}"]`);
    if (!row) return;
    const bounds = list.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    // Scroll only the outline; scrollIntoView could also move the manuscript pane.
    if (rect.top < bounds.top) list.scrollTop += rect.top - bounds.top - 8;
    else if (rect.bottom > bounds.bottom) list.scrollTop += rect.bottom - bounds.bottom + 8;
  }, [highlightedId, items, visible]);

  const navigate = (blockId: string) => {
    const container = scrollContainerRef.current;
    if (!container || !editor.getBlock(blockId)) return;
    editor.setTextCursorPosition(blockId, "start");
    editor.focus();
    const element = editor.domElement?.querySelector<HTMLElement>(`[data-id="${CSS.escape(blockId)}"]`);
    if (!element) return;
    container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
    navigationRef.current = { id: blockId, scrollTop: container.scrollTop };
    setActiveId(blockId);
  };

  if (!visible) return null;
  return <aside id={id} className="editor-mini-outline" aria-label="Document outline">
    <div className="editor-outline-header">
      <ListTree size={13} aria-hidden="true" />
      <span>Outline</span>
      <button type="button" className="editor-outline-icon-button" onClick={onClose}
        title="Hide outline" aria-label="Hide outline"><PanelRightClose size={13} aria-hidden="true" /></button>
    </div>
    <div ref={listRef} className="editor-outline-scroll">
      {!ready ? <p className="editor-outline-empty">Loading outline…</p>
        : items.length === 0 ? <p className="editor-outline-empty">No headings yet.<br />Add a heading to navigate your document.</p>
        : <nav aria-label="Sections"><ul className="editor-outline-list">
          {items.map((heading) => {
            const expanded = !collapsed.has(heading.id);
            const selected = heading.id === highlightedId;
            return <li key={heading.id} className="editor-outline-row" data-outline-id={heading.id}
              data-active={selected || undefined} style={{ paddingInlineStart: 4 + heading.depth * 8 }}>
              {heading.hasChildren ? <button type="button" className="editor-outline-disclosure"
                aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${heading.title}`}
                onClick={() => setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(heading.id)) next.delete(heading.id); else next.add(heading.id);
                  return next;
                })}>{expanded ? <ChevronDown size={10} aria-hidden="true" /> : <ChevronRight size={10} aria-hidden="true" />}</button>
                : <span className="editor-outline-spacer" aria-hidden="true" />}
              <button type="button" className="editor-outline-title" aria-current={selected ? "location" : undefined}
                title={heading.title} onClick={() => navigate(heading.id)}>{heading.title}</button>
            </li>;
          })}
        </ul></nav>}
    </div>
  </aside>;
}
