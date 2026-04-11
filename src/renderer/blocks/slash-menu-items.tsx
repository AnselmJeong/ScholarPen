import React from "react";
import { insertOrUpdateBlockForSlashMenu, BlockNoteEditor } from "@blocknote/core";
import { DefaultReactSuggestionItem } from "@blocknote/react";
import { getAIDictionary } from "@blocknote/xl-ai";
import { RiSparkling2Fill, RiH1, RiH2, RiH3, RiH4, RiH5 } from "react-icons/ri";
import type { ScholarEditor } from "./schema";

// ── Scholar custom slash-menu items ────────────────────────────────────────

export function getScholarSlashMenuItems(
  editor: ScholarEditor,
  onOpenDOIDialog: () => void,
): DefaultReactSuggestionItem[] {
  return [
    // Math equation block
    {
      title: "Math Equation",
      aliases: ["math", "latex", "equation", "formula"],
      group: "Scholar",
      icon: <span className="text-base font-serif">∑</span>,
      subtext: "Insert a KaTeX equation block",
      onItemClick: () =>
        insertOrUpdateBlockForSlashMenu(editor, { type: "math" }),
    },
    // Insert DOI — opens dialog to resolve DOI and insert as inline citation
    {
      title: "Insert DOI",
      aliases: ["doi", "cite", "citation", "reference", "bib", "bibliography"],
      group: "Scholar",
      icon: <span className="text-xs font-mono font-bold leading-none">DOI</span>,
      subtext: "Resolve a DOI and insert as inline citation",
      onItemClick: onOpenDOIDialog,
    },
    // Figure block
    {
      title: "Figure",
      aliases: ["figure", "image", "img", "picture"],
      group: "Scholar",
      icon: <span className="text-base">🖼</span>,
      subtext: "Insert an image with caption",
      onItemClick: () =>
        insertOrUpdateBlockForSlashMenu(editor, { type: "figure" }),
    },
    // Abstract block
    {
      title: "Abstract",
      aliases: ["abstract", "summary"],
      group: "Scholar",
      icon: <span className="text-base">📝</span>,
      subtext: "Insert structured abstract section",
      onItemClick: () =>
        insertOrUpdateBlockForSlashMenu(editor, { type: "abstract" }),
    },
  ];
}

// ── Custom heading items H1–H5 ─────────────────────────────────────────────

const headingIcons = [RiH1, RiH2, RiH3, RiH4, RiH5] as const;

export function getCustomHeadingSlashMenuItems(
  editor: ScholarEditor
): DefaultReactSuggestionItem[] {
  return ([1, 2, 3, 4, 5] as const).map((level) => {
    const Icon = headingIcons[level - 1];
    return {
      title: `Heading ${level}`,
      aliases: [`h${level}`, `heading${level}`],
      group: "Headings",
      icon: <Icon size={18} />,
      subtext: `Heading level ${level}`,
      onItemClick: () =>
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "heading",
          props: { level },
        }),
    };
  });
}

// ── Keys to exclude from the default slash menu ────────────────────────────
// We remove: all default heading variants (replaced by custom H1–H5 above),
// toggle headings, video, audio, file, and emoji.
const EXCLUDED_KEYS = new Set([
  "heading",
  "heading_2",
  "heading_3",
  "heading_4",
  "heading_5",
  "heading_6",
  "toggle_heading",
  "toggle_heading_2",
  "toggle_heading_3",
  "video",
  "audio",
  "file",
  "emoji",
]);

export function filterDefaultSlashMenuItems(
  items: DefaultReactSuggestionItem[]
): DefaultReactSuggestionItem[] {
  return items.filter(
    (item) => !EXCLUDED_KEYS.has((item as any).key ?? "")
  );
}

/**
 * Custom AI slash menu items that uses string key lookup instead of factory lookup.
 * This works around a BlockNote issue where editor.getExtension(AIExtension) fails
 * when the extension is instantiated with options.
 */
export function getAISlashMenuItemsFixed(
  editor: BlockNoteEditor<any, any, any>
): DefaultReactSuggestionItem[] {
  // Use string key lookup instead of factory function lookup
  const ai = editor.getExtension("ai");
  if (!ai) {
    console.log("[getAISlashMenuItemsFixed] AI extension not found by key 'ai'");
    return [];
  }
  console.log("[getAISlashMenuItemsFixed] AI extension found, creating slash menu item");

  const items = [
    {
      key: "ai",
      onItemClick: () => {
        const cursor = editor.getTextCursorPosition();
        if (
          cursor.block.content &&
          Array.isArray(cursor.block.content) &&
          cursor.block.content.length === 0 &&
          cursor.prevBlock
        ) {
          ai.openAIMenuAtBlock(cursor.prevBlock.id);
        } else {
          ai.openAIMenuAtBlock(cursor.block.id);
        }
      },
      ...getAIDictionary(editor).slash_menu.ai,
      icon: <RiSparkling2Fill size={18} />,
    },
  ];

  return items;
}
