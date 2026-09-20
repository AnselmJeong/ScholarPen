import React, { useCallback } from "react";
import {
  BlockColorsItem, DragHandleMenu, RemoveBlockItem, SideMenu, SideMenuController,
  useBlockNoteEditor, useComponentsContext,
} from "@blocknote/react";
import { LABEL_PREFIXES } from "../../../shared/quarto-references";

/** Block type submenu for the drag handle popup */
const BLOCK_TYPE_ITEMS = [
  { type: "paragraph",       label: "Paragraph",       props: {} },
  { type: "heading",         label: "Heading 1",        props: { level: 1 } },
  { type: "heading",         label: "Heading 2",        props: { level: 2 } },
  { type: "heading",         label: "Heading 3",        props: { level: 3 } },
  { type: "heading",         label: "Heading 4",        props: { level: 4 } },
  { type: "bulletListItem",  label: "Bullet List",      props: {} },
  { type: "numberedListItem",label: "Numbered List",    props: {} },
  { type: "checkListItem",   label: "Check List",       props: {} },
  { type: "quote",           label: "Quote",            props: {} },
] as const;

function BlockTypeDragItem() {
  const editor = useBlockNoteEditor();
  const components = useComponentsContext();
  if (!components) return null;
  return (
    <components.Generic.Menu.Root position="right" sub={true}>
      <components.Generic.Menu.Trigger sub={true}>
        <components.Generic.Menu.Item className="bn-menu-item" subTrigger={true}>
          Turn Into
        </components.Generic.Menu.Item>
      </components.Generic.Menu.Trigger>
      <components.Generic.Menu.Dropdown sub={true} className="bn-menu-dropdown">
        {BLOCK_TYPE_ITEMS.map(({ type, label, props: blockProps }) => (
          <components.Generic.Menu.Item
            key={label}
            className="bn-menu-item"
            onClick={() => {
              // Read the hovered block from the side menu store at click time
              const sideMenuExt = (editor as any).getExtension("sideMenu");
              const block = sideMenuExt?.store?.state?.block
                ?? editor.getTextCursorPosition().block;
              editor.updateBlock(block, { type: type as any, props: blockProps as any });
              editor.setTextCursorPosition(block.id, "end");
              editor.focus();
            }}
          >
            {label}
          </components.Generic.Menu.Item>
        ))}
      </components.Generic.Menu.Dropdown>
    </components.Generic.Menu.Root>
  );
}

function QuartoPropertiesDragItem({ onOpen }: { onOpen: (id: string) => void }) {
  const editor = useBlockNoteEditor();
  const components = useComponentsContext();
  const block = (editor.getExtension("sideMenu") as any)?.store?.state?.block ?? editor.getTextCursorPosition().block;
  if (!components || !LABEL_PREFIXES[block.type]) return null;
  return <components.Generic.Menu.Item className="bn-menu-item" onClick={() => onOpen(block.id)}>Quarto properties…</components.Generic.Menu.Item>;
}

/** Use with BlockNoteView's default sideMenu disabled to avoid overlapping handles. */
export function EditorSideMenu({ onOpenProperties }: { onOpenProperties: (id: string) => void }) {
  // Controllers treat these callbacks as component types. Keep them stable when
  // autosave, selection, or properties state causes the editor pane to render.
  const dragHandleMenu = useCallback(() => (
    <DragHandleMenu>
      <BlockTypeDragItem />
      <QuartoPropertiesDragItem onOpen={onOpenProperties} />
      <BlockColorsItem>Colors</BlockColorsItem>
      <RemoveBlockItem>Delete</RemoveBlockItem>
    </DragHandleMenu>
  ), [onOpenProperties]);
  const sideMenu = useCallback(() => <SideMenu dragHandleMenu={dragHandleMenu} />, [dragHandleMenu]);
  return <SideMenuController sideMenu={sideMenu} />;
}
