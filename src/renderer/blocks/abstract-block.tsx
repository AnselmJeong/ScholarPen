import React from "react";
import { createReactBlockSpec } from "@blocknote/react";

// ── Abstract Block ──────────────────────────────────────────────────────────
// A styled structured-section block for paper abstracts.
// Uses "inline" content so the user can type directly inside it.

export const abstractBlock = createReactBlockSpec(
  {
    type: "abstract" as const,
    propSchema: {},
    content: "inline",
  },
  {
    render: ({ contentRef }) => (
      <div className="my-2 w-full rounded-md border border-primary/25 bg-primary/10 px-5 py-3 text-foreground">
        <div className="mb-2 select-none text-xs font-bold uppercase tracking-widest text-primary">
          Abstract
        </div>
        <div
          ref={contentRef}
          className="text-sm leading-relaxed text-foreground focus:outline-none"
        />
      </div>
    ),
  }
);
