/**
 * Readable text of a saved or live BlockNote manuscript, for model prompts.
 * The JSON form spends most of its length on block structure (a document with
 * a dozen tables is >90% markup), so prompts get Markdown-like text instead:
 * headings as `#`, tables as `|` rows, dividers as `---`, citations as
 * `[@key]`, math as `$…$`. Edits never use this text: ScholarPen AI reads the
 * live document itself.
 */

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Text of inline content; citations keep their `[@key]` form. */
export function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(item => {
    if (!record(item)) return "";
    const props = record(item.props) ? item.props : {};
    switch (item.type) {
      case "text": return typeof item.text === "string" ? item.text : "";
      case "citation": return `[@${props.citekey ?? ""}${props.locator ? `, ${props.locator}` : ""}]`;
      case "crossReference": return `@${props.label ?? ""}`;
      case "inlineMath": return `$${props.formula ?? ""}$`;
      case "footnote": return `[^${props.index ?? ""}]`;
      default: return inlineText(item.content);
    }
  }).join("");
}

function cellText(cell: unknown): string {
  return inlineText(record(cell) ? cell.content : cell).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function tableText(content: unknown): string {
  if (!record(content) || !Array.isArray(content.rows)) return "";
  const rows = content.rows.map(row => record(row) && Array.isArray(row.cells) ? row.cells.map(cellText) : []);
  const width = Math.max(0, ...rows.map(row => row.length));
  if (width === 0) return "";
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  const header = Math.min(rows.length, Math.max(1, Number(content.headerRows) || 1));
  return [
    ...rows.slice(0, header).map(line),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...rows.slice(header).map(line),
  ].join("\n");
}

function label(props: Record<string, unknown>): string {
  return typeof props.label === "string" && props.label.trim() ? ` {#${props.label.trim()}}` : "";
}

function blockText(block: Record<string, unknown>): string {
  const props = record(block.props) ? block.props : {};
  const text = inlineText(block.content);
  const caption = typeof props.caption === "string" ? props.caption.trim() : "";
  switch (block.type) {
    case "heading": return text.trim() ? `${"#".repeat(Math.min(6, Number(props.level) || 1))} ${text}${label(props)}` : "";
    case "bulletListItem":
    case "toggleListItem": return text.trim() ? `- ${text}` : "";
    case "numberedListItem": return text.trim() ? `1. ${text}` : "";
    case "checkListItem": return text.trim() ? `- [${props.checked ? "x" : " "}] ${text}` : "";
    case "quote": return text.trim() ? text.split("\n").map(line => `> ${line}`).join("\n") : "";
    case "codeBlock": return text.trim() ? `\`\`\`${typeof props.language === "string" ? props.language : ""}\n${text}\n\`\`\`` : "";
    case "divider": return "---";
    case "math": return typeof props.formula === "string" && props.formula.trim() ? `$$${props.formula}$$${label(props)}` : "";
    case "figure":
    case "image": return caption ? `Figure: ${caption}${label(props)}` : "";
    case "table": {
      const table = tableText(block.content);
      return table && caption ? `Table: ${caption}${label(props)}\n\n${table}` : table;
    }
    // Drafting placeholders are the AI's own bookkeeping, not manuscript text.
    case "aiPlaceholder": return "";
    default: return text;
  }
}

/** The whole manuscript as Markdown-like text; nested blocks are indented under their parent. */
export function manuscriptText(blocks: unknown, depth = 0): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  const indent = "  ".repeat(depth);
  for (const block of blocks) {
    if (!record(block)) continue;
    const text = blockText(block);
    if (text.trim()) parts.push(depth ? text.split("\n").map(line => indent + line).join("\n") : text);
    const children = manuscriptText(block.children, depth + 1);
    if (children) parts.push(children);
  }
  return parts.join("\n\n");
}
