import React, { useEffect, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { AI_PLACEHOLDER_TYPE } from "../../shared/collab/ai-placeholder";

/**
 * Where ScholarPen AI is about to write a paragraph while it drafts a section:
 * the plan for that paragraph, shown in place before the text arrives. The
 * author can reword the plan or drop the paragraph while the AI works; the AI
 * replaces each placeholder with its paragraph in turn. Never exported.
 */
export const aiPlaceholderBlock = createReactBlockSpec(
  {
    type: AI_PLACEHOLDER_TYPE,
    propSchema: {
      intent: { default: "" },
      /** "pending" until the AI starts on it, then "writing". */
      state: { default: "pending" },
      /** The drafting job that owns it. */
      draft: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => <PlaceholderView block={block as any} editor={editor} />,
    // A plan is not text: it never reaches HTML, Markdown or the clipboard.
    toExternalHTML: () => <span />,
  },
);

function PlaceholderView({ block, editor }: { block: { props: { intent: string; state: string; draft: string } }; editor: any }) {
  const writing = block.props.state === "writing";
  const [intent, setIntent] = useState(block.props.intent);
  useEffect(() => setIntent(block.props.intent), [block.props.intent]);
  const commit = () => { if (intent.trim() && intent !== block.props.intent) editor.updateBlock(block, { props: { intent: intent.trim() } }); };
  return (
    <div contentEditable={false} data-ai-placeholder={block.props.state}
      className={`my-1 flex w-full items-start gap-2 rounded-md border border-dashed px-3 py-2 font-sans text-sm ${writing ? "border-primary/60 bg-primary/5" : "border-border bg-muted/30"}`}>
      <span aria-hidden className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${writing ? "animate-pulse bg-primary" : "bg-muted-foreground/40"}`} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs font-medium text-muted-foreground">{writing ? "ScholarPen AI가 이 단락을 쓰는 중" : "ScholarPen AI가 쓸 단락"}</span>
        {writing
          ? <span className="text-foreground/80">{block.props.intent}</span>
          : <input aria-label="이 단락에 쓸 내용" value={intent}
              onChange={(event) => setIntent(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); commit(); (event.target as HTMLInputElement).blur(); } }}
              className="w-full bg-transparent text-foreground/80 outline-none focus:text-foreground" />}
      </span>
      {!writing && <button type="button" onClick={() => editor.removeBlocks([block])}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        title="이 단락은 쓰지 않습니다">빼기</button>}
    </div>
  );
}
