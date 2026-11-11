import React from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

export function PaneToggle({ side, open, label, controls, onToggle }: {
  side: "left" | "right";
  open: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
}) {
  const Icon = side === "left"
    ? (open ? PanelLeftClose : PanelLeftOpen)
    : (open ? PanelRightClose : PanelRightOpen);
  return (
    <button type="button" className="editor-pane-toggle"
      aria-label={label} title={label} aria-expanded={open} aria-controls={controls}
      onClick={onToggle}>
      <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
    </button>
  );
}
