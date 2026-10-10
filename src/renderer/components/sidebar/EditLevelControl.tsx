import React, { useEffect, useState } from "react";
import type * as Y from "yjs";
import { cn } from "../../lib/utils";
import { EDIT_LEVELS, editLevelOf, setEditLevel, WRITING_MAP, type EditLevel } from "../../../shared/collab/writing";

export function useEditLevel(ydoc: Y.Doc | null) {
  const [level, setLevel] = useState<EditLevel>(() => ydoc ? editLevelOf(ydoc.getMap(WRITING_MAP)) : "sentence");
  useEffect(() => {
    if (!ydoc) return;
    const map = ydoc.getMap(WRITING_MAP);
    const refresh = () => setLevel(editLevelOf(map));
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [ydoc]);
  const update = (next: EditLevel) => {
    if (ydoc) ydoc.transact(() => setEditLevel(ydoc.getMap(WRITING_MAP), next));
  };
  return [level, update] as const;
}

/** How far ScholarPen AI may change this document's text, for every comment and coordinated revision. */
export function EditLevelControl({ ydoc }: { ydoc: Y.Doc }) {
  const [level, setLevel] = useEditLevel(ydoc);
  const current = EDIT_LEVELS.find(item => item.id === level)!;
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="AI edit level">
        <span className="text-[11px] text-muted-foreground">AI edit level</span>
        {EDIT_LEVELS.map(item => (
          <button key={item.id} type="button" role="radio" aria-checked={item.id === level} title={item.description}
            onClick={() => setLevel(item.id)}
            className={cn("rounded px-1.5 py-0.5 text-[11px]",
              item.id === level ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted")}>
            {item.label}
          </button>
        ))}
      </div>
      <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{current.description}</p>
    </div>
  );
}
