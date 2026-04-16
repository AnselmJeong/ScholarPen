import React from "react";
import { Files, BookOpen, Settings, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type RailTab = "files" | "knowledge";

interface IconRailProps {
  activeTab: RailTab;
  onTabChange: (tab: RailTab) => void;
  onOpenSettings: () => void;
}

interface RailIconProps {
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  title: string;
}

function RailIcon({ icon, active, onClick, title }: RailIconProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-150",
        active
          ? "text-white"
          : "text-[#6d6d8e] hover:text-[#1e1b4b] hover:bg-white/50"
      )}
      style={active ? {
        background: "linear-gradient(135deg, #5b21b6 0%, #4c1d95 100%)",
        boxShadow: "0 4px 12px rgba(91,33,182,0.35)",
      } : undefined}
    >
      {icon}
    </button>
  );
}

export function IconRail({ activeTab, onTabChange, onOpenSettings }: IconRailProps) {
  return (
    <div
      className="flex-shrink-0 flex flex-col items-center py-4 gap-2"
      style={{
        width: 56,
        background: "hsl(var(--sidebar))",
      }}
    >
      {/* Top nav icons */}
      <RailIcon
        icon={<Files className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} />}
        active={activeTab === "files"}
        onClick={() => onTabChange("files")}
        title="Files"
      />
      <RailIcon
        icon={<BookOpen className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} />}
        active={activeTab === "knowledge"}
        onClick={() => onTabChange("knowledge")}
        title="Knowledge Base"
      />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom util icons */}
      <RailIcon
        icon={<Settings style={{ width: 18, height: 18 }} />}
        active={false}
        onClick={onOpenSettings}
        title="Settings"
      />
      <RailIcon
        icon={<HelpCircle style={{ width: 18, height: 18 }} />}
        active={false}
        onClick={() => {}}
        title="Help"
      />
    </div>
  );
}
