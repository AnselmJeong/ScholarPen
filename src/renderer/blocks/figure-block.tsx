import React, { useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";

// ── Figure Block ────────────────────────────────────────────────────────────
// Image + caption + auto figure numbering.
// figureNumber prop is set by the editor when the block is created.

export const figureBlock = createReactBlockSpec(
  {
    type: "figure" as const,
    propSchema: {
      url: { default: "" },
      caption: { default: "" },
      figureNumber: { default: 0 },
      altText: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const { url, caption, figureNumber, altText } = block.props;
      const [editingCaption, setEditingCaption] = useState(false);
      const [captionValue, setCaptionValue] = useState(caption);
      const [editingUrl, setEditingUrl] = useState(!url);
      const [urlValue, setUrlValue] = useState(url);
      const fileInputRef = useRef<HTMLInputElement>(null);

      const commitCaption = () => {
        editor.updateBlock(block, { props: { caption: captionValue } });
        setEditingCaption(false);
      };

      const commitUrl = (val: string) => {
        editor.updateBlock(block, { props: { url: val, altText: val } });
        setEditingUrl(false);
      };

      const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string;
          commitUrl(dataUrl);
          setUrlValue(dataUrl);
        };
        reader.readAsDataURL(file);
      };

      const figLabel = figureNumber > 0 ? `Figure ${figureNumber}` : "Figure";

      return (
        <div className="my-2 w-full overflow-hidden rounded-md border border-border bg-card text-card-foreground">
          {/* Image area */}
          {url ? (
            <div className="relative group">
              <img
                src={url}
                alt={altText || caption || figLabel}
                className="max-h-96 w-full bg-muted/30 object-contain"
              />
              <button
                onClick={() => {
                  setUrlValue(url);
                  setEditingUrl(true);
                }}
                className="absolute top-2 right-2 px-2 py-0.5 text-xs bg-black/40 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity"
              >
                Change
              </button>
            </div>
          ) : (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="flex h-40 cursor-pointer flex-col items-center justify-center gap-2 bg-muted/40 transition-colors hover:bg-muted/60"
            >
              <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-sm text-muted-foreground">Click to add image</span>
              {editingUrl && (
                <input
                  type="text"
                  placeholder="or paste URL..."
                  value={urlValue}
                  onChange={(e) => setUrlValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitUrl(urlValue);
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-1 w-64 rounded border border-input bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Caption */}
          <div className="border-t border-border bg-muted/30 px-4 py-2">
            <span className="mr-1 text-xs font-semibold text-muted-foreground">{figLabel}.</span>
            {editingCaption ? (
              <input
                autoFocus
                type="text"
                value={captionValue}
                onChange={(e) => setCaptionValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape") commitCaption();
                  e.stopPropagation();
                }}
                onBlur={commitCaption}
                placeholder="Caption..."
                className="w-full border-b border-primary bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            ) : (
              <span
                onClick={() => setEditingCaption(true)}
                className="cursor-pointer text-sm text-foreground hover:text-primary"
              >
                {caption || <span className="italic text-muted-foreground">Add caption...</span>}
              </span>
            )}
          </div>
        </div>
      );
    },
  }
);
