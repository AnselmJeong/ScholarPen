import React from "react";
import { Files, HelpCircle, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

interface IconRailProps {
  onOpenSettings: () => void;
}

function RailIcon({
  icon,
  active = false,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-150",
        active ? "text-white" : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
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

export function IconRail({ onOpenSettings }: IconRailProps) {
  return (
    <div
      className="flex-shrink-0 flex flex-col items-center gap-2"
      style={{ width: 56, background: "hsl(var(--sidebar))", paddingTop: "92px" }}
    >
      <RailIcon
        icon={<Files style={{ width: 18, height: 18 }} />}
        active
        onClick={() => {}}
        title="Files"
      />
      <div className="flex-1" />
      <RailIcon
        icon={<Settings style={{ width: 18, height: 18 }} />}
        onClick={onOpenSettings}
        title="Settings"
      />
      <RailIcon
        icon={<HelpCircle style={{ width: 18, height: 18 }} />}
        onClick={() => {}}
        title="Help"
      />
    </div>
  );
}
