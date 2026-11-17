import { createStyleSpec } from "@blocknote/core";
import { AI_AUTHORED_MARK } from "../../shared/collab/ai-authorship";

/** Text ScholarPen AI wrote (see shared/collab/ai-authorship.ts); shown only in the "AI-written text" view. */
export const aiAuthoredStyle = createStyleSpec(
  { type: AI_AUTHORED_MARK, propSchema: "boolean" },
  {
    render: () => {
      const span = document.createElement("span");
      span.setAttribute("data-ai-authored", "");
      return { dom: span, contentDOM: span };
    },
    // Exported text carries no trace of it.
    toExternalHTML: () => {
      const span = document.createElement("span");
      return { dom: span, contentDOM: span };
    },
    parse: (element) => element.hasAttribute("data-ai-authored") ? true : undefined,
  },
);
