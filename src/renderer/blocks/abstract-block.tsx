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
      <div className="w-full border-l-4 border-blue-400 bg-blue-50 rounded-r-md my-2 px-5 py-3">
        <div className="text-xs font-bold uppercase tracking-widest text-blue-500 mb-2 select-none">
          Abstract
        </div>
        <div
          ref={contentRef}
          className="text-sm text-gray-800 leading-relaxed focus:outline-none"
        />
      </div>
    ),
  }
);
