import React, { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import type { scholarSchema } from "../../blocks/schema";
import { LABEL_PREFIXES } from "../../../shared/quarto-references";

type Anchor = { blockId: string; top: number; left: number };

/** Keep the control outside ProseMirror's editable DOM, beside its selected block. */
export function QuartoBlockControls({ editor, enabled, onOpen, children }: {
  editor: typeof scholarSchema.BlockNoteEditor;
  enabled: boolean;
  onOpen: (blockId: string) => void;
  children: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) { setAnchor(null); return; }
    let frame = 0;
    const update = () => {
      frame = 0;
      const root = editor.domElement;
      if (!root || (!editor.isFocused() && !buttonRef.current?.contains(document.activeElement))) {
        setAnchor(null);
        return;
      }
      const selection = editor.getSelection();
      const block = editor.getTextCursorPosition().block;
      if (!LABEL_PREFIXES[block.type] || (selection && selection.blocks.length > 1)) {
        setAnchor(null);
        return;
      }
      const blockElement = root.querySelector<HTMLElement>(`[data-id="${CSS.escape(block.id)}"]`);
      const content = blockElement?.querySelector<HTMLElement>(".bn-block-content");
      if (!content) { setAnchor(null); return; }
      const rect = content.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      const next = {
        blockId: block.id,
        top: rect.top - bounds.top + Math.max(0, (Math.min(rect.height, 40) - 28) / 2),
        left: Math.min(rect.right - bounds.left + 8, host.clientWidth - 28),
      };
      setAnchor((previous) => previous?.blockId === next.blockId && previous.top === next.top && previous.left === next.left ? previous : next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const offSelection = editor.onSelectionChange(schedule);
    const offChange = editor.onChange(schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    // Images, wrapped headings, and table edits can move the target after selection.
    const mutations = new MutationObserver(schedule);
    if (editor.domElement) mutations.observe(editor.domElement, { childList: true, subtree: true, characterData: true });
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      offSelection(); offChange();
      resize.disconnect(); mutations.disconnect();
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [editor, enabled]);

  return <div ref={hostRef} className="quarto-block-controls-host">
    {children}
    {anchor && <button ref={buttonRef} type="button" className="quarto-block-properties"
      style={{ top: anchor.top, left: anchor.left }}
      aria-label="Quarto properties" aria-haspopup="dialog" title="Quarto properties"
      data-block-id={anchor.blockId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpen(anchor.blockId)}>
      <Settings2 size={16} aria-hidden="true" />
    </button>}
  </div>;
}
