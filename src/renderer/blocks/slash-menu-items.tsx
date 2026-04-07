import React from "react";
import { insertOrUpdateBlockForSlashMenu, BlockNoteEditor } from "@blocknote/core";
import { DefaultReactSuggestionItem } from "@blocknote/react";
import { getAIDictionary } from "@blocknote/xl-ai";
import { RiSparkling2Fill } from "react-icons/ri";
import type { ScholarEditor } from "./schema";

// ── Scholar custom slash-menu items ────────────────────────────────────────

export function getScholarSlashMenuItems(
  editor: ScholarEditor
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
