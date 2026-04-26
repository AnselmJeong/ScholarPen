import React from "react";
import { createReactInlineContentSpec } from "@blocknote/react";

export interface CitationHoverMetadata {
  firstAuthor: string;
  year: string;
  title: string;
}

let citationHoverMetadata = new Map<string, CitationHoverMetadata>();
const citationHoverListeners = new Set<() => void>();

export function setCitationHoverMetadata(metadata: Map<string, CitationHoverMetadata>) {
  citationHoverMetadata = new Map(metadata);
  citationHoverListeners.forEach((listener) => listener());
}

function subscribeCitationHoverMetadata(listener: () => void) {
  citationHoverListeners.add(listener);
  return () => {
    citationHoverListeners.delete(listener);
  };
}

function getCitationHoverSnapshot() {
  return citationHoverMetadata;
}

function CitationBadge({ citekey, locator }: { citekey: string; locator?: string }) {
  const metadata = React.useSyncExternalStore(
    subscribeCitationHoverMetadata,
    getCitationHoverSnapshot,
    getCitationHoverSnapshot
  );
  const label = locator ? `${citekey}, ${locator}` : citekey;
  const details = metadata.get(citekey);
  const title = details
    ? `${details.firstAuthor}, ${details.year}. ${details.title}`
    : citekey;

  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-900/25 dark:text-amber-300 dark:border-amber-700/50 cursor-default select-none mx-0.5"
      title={title}
      data-citekey={citekey}
    >
      [{label}]
    </span>
  );
}

// ── Citation Inline ─────────────────────────────────────────────────────────
// Renders an inline citation badge like [@Smith2020].
// The citekey prop is set when the citation is inserted.

export const citationInline = createReactInlineContentSpec(
  {
    type: "citation" as const,
    propSchema: {
      citekey: { default: "" },
      // Page range or note, e.g. "p. 42"
      locator: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const { citekey, locator } = inlineContent.props;
      return <CitationBadge citekey={citekey} locator={locator} />;
    },
  }
);

// ── Footnote Inline ─────────────────────────────────────────────────────────
// Renders a footnote marker like [^1] with tooltip text.

export const footnoteInline = createReactInlineContentSpec(
  {
    type: "footnote" as const,
    propSchema: {
      index: { default: 1 },
      text: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const { index, text } = inlineContent.props;
      return (
        <span
          className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold bg-gray-200 text-gray-600 cursor-default select-none mx-0.5 relative group"
          title={text}
          data-footnote={index}
        >
          {index}
          {text && (
            <span className="absolute bottom-5 left-0 w-48 text-xs text-gray-700 bg-white border border-gray-200 rounded shadow-lg p-2 invisible group-hover:visible z-10 leading-snug font-normal">
              {text}
            </span>
          )}
        </span>
      );
    },
  }
);
