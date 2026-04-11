import React from "react";
import { X } from "lucide-react";
import type { EditorTab } from "./EditorPaneGroup";

interface TabBarProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  isFocused: boolean;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  /** Called when the user starts a mouse-drag on a tab (left button, after threshold). */
  onTabMouseDown: (tabId: string, e: React.MouseEvent) => void;
  onPaneFocus: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  isFocused,
  onTabClick,
  onTabClose,
  onTabMouseDown,
  onPaneFocus,
}: TabBarProps) {
  return (
    <div
      className={`
        flex items-end h-9 bg-gray-50 overflow-x-auto flex-shrink-0
        border-b transition-colors
        ${isFocused ? "border-blue-300" : "border-gray-200"}
      `}
      onClick={onPaneFocus}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = tab.file.name.replace(/\.scholarpen\.json$/, "");

        return (
          <div
            key={tab.id}
            onClick={(e) => { e.stopPropagation(); onTabClick(tab.id); }}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              // Don't start drag if clicking the close button
              const target = e.target as HTMLElement;
              if (target.closest("button")) return;
              onTabMouseDown(tab.id, e);
            }}
            title={tab.file.path}
            className={`
              group relative flex items-center gap-1.5 px-3 h-8 text-xs
              whitespace-nowrap select-none flex-shrink-0 cursor-pointer
              border-r border-gray-200 transition-colors
              ${isActive
                ? "bg-white text-gray-800 font-medium shadow-[inset_0_-2px_0_0] shadow-blue-500"
                : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              }
            `}
          >
            <span className="max-w-[140px] truncate">{label}</span>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onTabClose(tab.id); }}
              className={`
                flex-shrink-0 flex items-center justify-center w-4 h-4 rounded
                transition-opacity
                ${isActive
                  ? "opacity-40 hover:opacity-100 hover:bg-gray-200"
                  : "opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:bg-gray-200"
                }
              `}
            >
              <X size={10} />
            </button>
          </div>
        );
      })}

      {/* Remaining space also triggers pane focus */}
      <div className="flex-1 h-full" />
    </div>
  );
}
