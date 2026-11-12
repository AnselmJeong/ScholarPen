import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Text } from "@astryxdesign/core/Text";
import { cn } from "../../lib/utils";

/**
 * Building blocks for the right-hand side panels (Activity, History,
 * Project). Every panel composes these with Astryx controls so section
 * headers, spacing, helper text and errors look the same in each tab.
 *
 * Density: side panels use Astryx `size="sm"` controls, 12px supporting
 * text and hairline dividers between sections.
 */

type IconComponent = React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/** Fixed header row of a panel: icon, title, optional meta and actions at the end. */
export function PanelHeader({ icon: Icon, title, meta, actions, children }: {
  icon?: IconComponent;
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** Extra rows under the title (filters, notes). */
  children?: React.ReactNode;
}) {
  return (
    <div className="panel-header space-y-2 border-b border-sidebar-border px-3 py-2">
      <div className="flex min-h-7 items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <Text type="label" weight="semibold" maxLines={1}>{title}</Text>
        {meta && <Text type="supporting" maxLines={1}>{meta}</Text>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * A collapsible block of a panel. The whole header row toggles it; actions
 * placed in `actions` stay clickable without toggling.
 */
export function PanelSection({ title, icon: Icon, summary, defaultOpen = false, actions, children, label }: {
  title: string;
  icon?: IconComponent;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Accessible name of the section landmark; defaults to the title. */
  label?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={label ?? title} className="border-b border-sidebar-border">
      <div className="flex items-center gap-1 pr-2">
        <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left hover:bg-sidebar-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
          {open ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
          {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          <Text type="label" weight="semibold">{title}</Text>
          {summary && <Text type="supporting" maxLines={1}>{summary}</Text>}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {open && <div className="space-y-2 px-3 pb-3">{children}</div>}
    </section>
  );
}

/** A static (non-collapsible) block with padding and a bottom divider. */
export function PanelBlock({ children, label, tone }: { children: React.ReactNode; label?: string; tone?: "attention" }) {
  return (
    <section aria-label={label} className={cn("space-y-2 border-b border-sidebar-border px-3 py-2", tone === "attention" && "bg-amber-500/5")}>
      {children}
    </section>
  );
}

/** Helper text inside a panel. */
export function PanelNote({ children, role, className }: { children: React.ReactNode; role?: "status" | "alert"; className?: string }) {
  return <p role={role} className={cn("text-xs leading-5 text-muted-foreground", className)}>{children}</p>;
}

/** Error text inside a panel. */
export function PanelError({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="break-words text-xs leading-5 text-destructive">{children}</p>;
}

/** Centered message for a panel with nothing to show yet. */
export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center">
      <Text type="supporting">{children}</Text>
    </div>
  );
}

/** A quoted passage from the manuscript (the text a comment or decision refers to). */
export function PanelQuote({ children, muted, onClick }: { children: React.ReactNode; muted?: boolean; onClick?: () => void }) {
  const className = cn("block w-full truncate border-l-2 pl-2 text-left text-xs",
    muted ? "border-border italic text-muted-foreground" : "border-amber-400/70 text-muted-foreground", onClick && "hover:text-foreground");
  return onClick
    ? <button type="button" onClick={onClick} className={className}>{children}</button>
    : <p className={className}>{children}</p>;
}

/** Row of compact actions that wraps when the panel is narrow. */
export function PanelActions({ children, label }: { children: React.ReactNode; label?: string }) {
  return <div role={label ? "group" : undefined} aria-label={label} className="flex flex-wrap items-center gap-1">{children}</div>;
}
