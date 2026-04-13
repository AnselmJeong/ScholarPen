import React from "react";

interface FrontmatterCardProps {
  frontmatter: Record<string, unknown>;
}

/**
 * Render YAML frontmatter as a styled metadata card.
 * Shows `type` as a badge and other keys as a key-value table.
 */
export function FrontmatterCard({ frontmatter }: FrontmatterCardProps) {
  const entries = Object.entries(frontmatter).filter(([key]) => key !== "type");
  const type = frontmatter.type as string | undefined;

  return (
    <div className="mb-6 bg-muted/50 border border-border rounded-lg overflow-hidden text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-muted border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Metadata</span>
        {type && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
            {type}
          </span>
        )}
      </div>

      {/* Key-value pairs */}
      {entries.length > 0 && (
        <div className="px-4 py-2">
          <dl className="grid gap-x-4 gap-y-1" style={{ gridTemplateColumns: "auto 1fr" }}>
            {entries.map(([key, value]) => (
              <React.Fragment key={key}>
                <dt className="text-muted-foreground font-medium text-xs py-0.5">{key}</dt>
                <dd className="text-foreground text-xs py-0.5">{renderValue(value)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * Render a frontmatter value with appropriate styling.
 */
function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">—</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground italic">empty</span>;
    }
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item, i) => (
          <span
            key={i}
            className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-secondary text-secondary-foreground"
          >
            {String(item)}
          </span>
        ))}
      </span>
    );
  }

  if (typeof value === "boolean") {
    return (
      <span className={`text-xs font-medium ${value ? "text-green-600" : "text-red-500"}`}>
        {String(value)}
      </span>
    );
  }

  if (typeof value === "number") {
    return <span className="font-mono text-xs">{value}</span>;
  }

  // String value
  const str = String(value);
  if (str.length > 80) {
    return <span className="text-xs">{str}</span>;
  }
  return <span className="font-mono text-xs">{str}</span>;
}