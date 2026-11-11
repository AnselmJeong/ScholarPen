import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BlockNoteEditor } from "@blocknote/core";
import type { ThreadData } from "@blocknote/core/comments";
import { X } from "lucide-react";
import { ScholarFloatingThread } from "../../collab/comment-composer";

/** One reply editor survives margin, compact and hidden-margin presentation changes. */
export function MarginThread({ editor, thread, slotRef, scrollRef, embedded, layoutKey, range, onHeight, onClose }: {
  editor: BlockNoteEditor<any, any, any>;
  thread: ThreadData;
  slotRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  embedded: boolean;
  layoutKey: unknown;
  range?: { from: number; to: number };
  onHeight: (height: number) => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const panel = host.current;
    const scroll = scrollRef.current;
    if (!panel || !scroll) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const bounds = scroll.getBoundingClientRect();
      const slot = embedded ? slotRef.current?.getBoundingClientRect() : null;
      const width = slot?.width ?? Math.max(120, Math.min(300, bounds.width - 24));
      const height = panel.offsetHeight;
      let top = slot?.top ?? bounds.top + 12;
      let left = slot?.left ?? bounds.right - width - 12;
      if (!embedded && range) {
        try {
          const point = editor.prosemirrorView.coordsAtPos(range.to, -1);
          top = Math.max(bounds.top + 8, Math.min(point.bottom + 8, bounds.bottom - height - 8));
          left = Math.max(bounds.left + 8, Math.min(point.left, bounds.right - width - 8));
        } catch { /* A detached thread opens in the viewport corner. */ }
      }
      const next: React.CSSProperties = { top, left, width,
        visibility: embedded && !slot ? "hidden" : "visible",
        clipPath: embedded ? `inset(${Math.max(0, bounds.top - top)}px 0 ${Math.max(0, top + height - bounds.bottom)}px 0)` : undefined,
      };
      setStyle(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      if (embedded) onHeight(height);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(panel); observer.observe(scroll);
    if (slotRef.current) observer.observe(slotRef.current);
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); scroll.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [editor, thread.id, slotRef, scrollRef, embedded, layoutKey, range, onHeight]);

  return createPortal(<div ref={host} className="bn-container sp-persistent-thread" data-floating={!embedded} style={style}
    role={embedded ? "region" : "dialog"} aria-label="Comment thread">
    <div className="sp-thread-floating-header" hidden={embedded}>
      <span>Comment</span><button type="button" className="sp-margin-action" onClick={onClose} aria-label="Close comment thread"><X size={14} /></button>
    </div>
    <div className="sp-margin-thread"><ScholarFloatingThread key={thread.id} thread={thread} selected maxCommentsBeforeCollapse={2} /></div>
  </div>, document.body);
}
