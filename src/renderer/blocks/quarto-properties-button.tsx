import React, { useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { QuartoPropertiesDialog } from "../components/editor/QuartoPropertiesDialog";

export function QuartoPropertiesButton({ editor, blockId, label }: {
  editor: BlockNoteEditor<any, any, any>; blockId: string; label: string;
}) {
  const [open, setOpen] = useState(false);
  return <span contentEditable={false}>
    <button type="button" className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={() => setOpen(true)} title="Edit identifier and Quarto layout">{label ? `#${label} · Properties` : "Properties"}</button>
    {open && <QuartoPropertiesDialog editor={editor} blockId={blockId} onClose={() => setOpen(false)} />}
  </span>;
}
