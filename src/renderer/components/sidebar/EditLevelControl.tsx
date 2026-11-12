import React, { useEffect, useState } from "react";
import type * as Y from "yjs";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
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
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Text type="supporting">AI edit level</Text>
        <SegmentedControl label="AI edit level" size="sm" value={level} onChange={(value) => setLevel(value as EditLevel)}>
          {EDIT_LEVELS.map(item => <SegmentedControlItem key={item.id} value={item.id} label={item.label} />)}
        </SegmentedControl>
      </div>
      <Text type="supporting" display="block">{current.description}</Text>
    </div>
  );
}
