import React from "react";
import { useEditorSelectionChange } from "@blocknote/react";
import type { ScholarEditor } from "./schema";

export function toggleSelectedNotes(editor: ScholarEditor) {
  const selected = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
  const eligible = selected.filter((block) => ["paragraph", "quote", "note"].includes(block.type));
  const remove = eligible.length > 0 && eligible.every((block) => block.type === "note");
  editor.transact(() => {
    for (const block of eligible) editor.updateBlock(block, remove
      ? { type: "paragraph" } : { type: "note", props: { title: block.type === "note" ? block.props.title : "읽는 법" } });
  });
}

export function NoteToolbarButton({ editor }: { editor: ScholarEditor }) {
  const [, refresh] = React.useReducer((n: number) => n + 1, 0);
  useEditorSelectionChange(refresh, editor);
  const selected = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
  const eligible = selected.filter((block) => ["paragraph", "quote", "note"].includes(block.type));
  const active = eligible.length > 0 && eligible.every((block) => block.type === "note");
  return <button type="button" disabled={!eligible.length} aria-pressed={active}
    title={active ? "Note 박스를 일반 문단으로" : "선택한 문단을 Note 박스로"}
    onMouseDown={(event) => event.preventDefault()}
    onClick={() => toggleSelectedNotes(editor)}
    className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-accent disabled:opacity-40">
    Note
  </button>;
}
