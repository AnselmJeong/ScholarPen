import React from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { collectReferenceTargets } from "../../shared/quarto-references";

/** Preserve an explicitly escaped reference as literal text through JSON/QMD. */
export const quartoLiteralInline = createReactInlineContentSpec(
  { type: "quartoLiteral", propSchema: { source: { default: "" } }, content: "none" },
  { render: ({ inlineContent }) => <span>{inlineContent.props.source.replace(/^\\(?=[@\[])/, "")}</span> },
);

export const crossReferenceInline = createReactInlineContentSpec(
  {
    type: "crossReference",
    propSchema: {
      label: { default: "" }, locator: { default: "" }, bracketed: { default: false },
    },
    content: "none",
  },
  {
    render: ({ inlineContent, editor }) => {
      const { label, locator } = inlineContent.props;
      return <span className="rounded bg-blue-500/10 px-1 text-blue-700 dark:text-blue-300"
        role="link" tabIndex={0} contentEditable={false}
        title={`Document reference: ${label}. Click to go to its target in this document.`}
        onClick={() => {
          const target = collectReferenceTargets(editor.document).find((item) => item.label === label);
          if (target) {
            editor.setTextCursorPosition(target.blockId, "start");
            editor.focus();
            editor.domElement?.querySelector(`[data-id="${CSS.escape(target.blockId)}"]`)?.scrollIntoView({ block: "center" });
          }
        }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.click(); } }}
        style={{ cursor: "pointer" }}
      >@{label}{locator ? `, ${locator}` : ""}</span>;
    },
  },
);
