import React from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { rpc } from "../rpc";

export interface CitationHoverMetadata {
  firstAuthor: string;
  year: string;
  title: string;
  doiUrl: string | null;
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
  const doiUrl = details?.doiUrl ?? null;

  const openDoi = () => {
    if (!doiUrl) return;
    rpc.openExternal(doiUrl).catch((error) => {
      console.error("[Citation] Could not open DOI in the default browser:", error);
    });
  };

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-900/25 dark:text-amber-300 dark:border-amber-700/50 select-none mx-0.5 ${
        doiUrl
          ? "cursor-pointer hover:bg-amber-200/80 dark:hover:bg-amber-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
          : "cursor-default"
      }`}
      title={doiUrl ? `${title}\nClick to open DOI in your browser` : title}
      data-citekey={citekey}
      data-doi-url={doiUrl ?? undefined}
      role={doiUrl ? "link" : undefined}
      tabIndex={doiUrl ? 0 : undefined}
      onMouseDown={(event) => {
        if (!doiUrl) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (!doiUrl) return;
        event.preventDefault();
        event.stopPropagation();
        openDoi();
      }}
      onKeyDown={(event) => {
        if (!doiUrl || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        openDoi();
      }}
      aria-label={doiUrl ? `Open ${title} by DOI in the default browser` : undefined}
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
          className="group relative mx-0.5 inline-flex h-4 w-4 cursor-default select-none items-center justify-center rounded-full border border-border bg-muted text-[10px] font-bold text-muted-foreground"
          title={text}
          data-footnote={index}
        >
          {index}
          {text && (
            <span className="invisible absolute bottom-5 left-0 z-10 w-48 rounded border border-border bg-popover p-2 text-xs font-normal leading-snug text-popover-foreground shadow-lg group-hover:visible">
              {text}
            </span>
          )}
        </span>
      );
    },
  }
);
