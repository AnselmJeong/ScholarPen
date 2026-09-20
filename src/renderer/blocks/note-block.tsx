import React from "react";
import { createReactBlockSpec } from "@blocknote/react";

export const noteBlock = createReactBlockSpec(
  { type: "note", propSchema: { title: { default: "읽는 법" } }, content: "inline" },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="scholar-note w-full">
        <div contentEditable={false} className="mb-1">
          <input aria-label="Note title" value={block.props.title}
            onChange={(event) => editor.updateBlock(block, { props: { title: event.target.value } })}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="읽는 법"
            className="w-full bg-transparent font-sans text-sm font-semibold text-primary outline-none" />
        </div>
        <div ref={contentRef} className="leading-relaxed" />
      </div>
    ),
    toExternalHTML: ({ block, contentRef }) => (
      <aside data-scholar-note="true" data-note-title={block.props.title}>
        <strong>{block.props.title}</strong><div ref={contentRef} />
      </aside>
    ),
  },
);
