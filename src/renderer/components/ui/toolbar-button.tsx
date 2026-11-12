import React from "react";
import { Button } from "@astryxdesign/core/Button";

/**
 * Icon-only button for the title-bar toolbar (core and plugin slots alike):
 * Astryx ghost Button with its label as tooltip and accessible name, and an
 * accent tint while the thing it opens is showing.
 */
export function ToolbarButton({ label, icon: Icon, onClick, isDisabled, isActive, ...aria }: {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;
  onClick: () => void;
  isDisabled?: boolean;
  isActive?: boolean;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
}) {
  return (
    <Button
      label={label}
      tooltip={label}
      variant="ghost"
      size="sm"
      isIconOnly
      isDisabled={isDisabled}
      className="workbench-toggle"
      data-active={isActive || undefined}
      icon={<Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />}
      onClick={onClick}
      {...aria}
    />
  );
}
