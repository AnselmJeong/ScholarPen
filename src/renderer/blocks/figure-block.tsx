import React, { useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { QuartoPropertiesButton } from "./quarto-properties-button";
import { FigureImage } from "./figure-image";
import { blockLabel } from "../../shared/quarto-references";

// ── Figure Block ────────────────────────────────────────────────────────────
// Image + caption + auto figure numbering.
// figureNumber prop is set by the editor when the block is created.

export const figureBlock = createReactBlockSpec(
  {
    type: "figure" as const,
    propSchema: {
      url: { default: "" },
      sourcePath: { default: "" },
      caption: { default: "" },
      figureNumber: { default: 0 },
      altText: { default: "" },
      label: { default: "" },
      width: { default: "" },
      height: { default: "" },
      alignment: { default: "center", values: ["left", "center", "right"] as const },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const { url, caption, figureNumber, altText } = block.props;
      const [editingCaption, setEditingCaption] = useState(false);
      const [captionValue, setCaptionValue] = useState(caption);

      const commitCaption = () => {
        editor.updateBlock(block, { props: { caption: captionValue } });
        setEditingCaption(false);
      };

      const figLabel = figureNumber > 0 ? `Figure ${figureNumber}` : "Figure";

      return (
        <div className="my-2 w-full overflow-hidden rounded-md border border-border bg-card text-card-foreground">
          <FigureImage sourcePath={block.props.sourcePath} url={url} alt={altText || caption || figLabel}
            onSourceChange={(source) => {
              if (editor.getBlock(block.id)) editor.updateBlock(block, { props: source });
            }}
            style={{ width: /^\d+(\.\d+)?$/.test(block.props.width) ? Number(block.props.width) : block.props.width || "100%",
              height: /^\d+(\.\d+)?$/.test(block.props.height) ? Number(block.props.height) : block.props.height || "auto",
              marginLeft: block.props.alignment === "left" ? 0 : "auto",
              marginRight: block.props.alignment === "right" ? 0 : "auto" }}>
            <QuartoPropertiesButton editor={editor} blockId={block.id} label={blockLabel(block)} />
          </FigureImage>

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
