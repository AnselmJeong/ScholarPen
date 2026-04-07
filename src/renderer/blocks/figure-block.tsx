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
        <div className="w-full border border-gray-200 rounded-md my-2 overflow-hidden bg-white">
          {/* Image area */}
          {url ? (
            <div className="relative group">
              <img
                src={url}
                alt={altText || caption || figLabel}
                className="w-full max-h-96 object-contain bg-gray-50"
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
              className="flex flex-col items-center justify-center h-40 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors gap-2"
            >
              <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-sm text-gray-500">Click to add image</span>
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
                  className="mt-1 text-sm border border-gray-300 rounded px-2 py-1 w-64 focus:outline-none focus:ring-1 focus:ring-blue-400"
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
          <div className="px-4 py-2 bg-gray-50 border-t border-gray-100">
            <span className="text-xs font-semibold text-gray-500 mr-1">{figLabel}.</span>
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
                className="text-sm text-gray-700 bg-transparent border-b border-blue-400 focus:outline-none w-full"
              />
            ) : (
              <span
                onClick={() => setEditingCaption(true)}
                className="text-sm text-gray-700 cursor-pointer hover:text-blue-600"
              >
                {caption || <span className="text-gray-400 italic">Add caption...</span>}
              </span>
            )}
          </div>
        </div>
      );
    },
  }
);
