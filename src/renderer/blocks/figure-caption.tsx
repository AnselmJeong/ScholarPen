import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import { prepareMarkdownMath, remarkRestoreScholarMath } from "./markdown-math";
import { normalizeFigureCaption } from "./caption-markdown";

export function FigureCaption({ caption }: { caption: string }) {
  const prepared = useMemo(() => prepareMarkdownMath(normalizeFigureCaption(caption)), [caption]);
  return <span className="scholar-figure-caption">
    <ReactMarkdown remarkPlugins={[remarkGfm, [remarkRestoreScholarMath, prepared]]}
      rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]}
      components={{ p: ({ children }) => <span>{children}</span>,
        img: ({ alt }) => <span>{alt}</span> }}>
      {prepared.markdown}
    </ReactMarkdown>
  </span>;
}
