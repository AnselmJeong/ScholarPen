/**
 * Readable text of a saved or live BlockNote manuscript, for model prompts.
 * The JSON form spends most of its length on block structure (a document with
 * a dozen tables is >90% markup), so prompts get Markdown-like text instead:
 * headings as `#`, tables as `|` rows, dividers as `---`, citations as
 * `[@key]`, math as `$…$`. Edits never write this text back: the Assistant
 * quotes it to say what to replace, and Bun finds that passage in the live
 * document (see bun/collab/agent/assistant-edit.ts).
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

/** Blocks whose text is inline content the Assistant can edit (not code, tables, equations or figures). */
function editableText(block: Record<string, unknown>) {
  return Array.isArray(block.content) && block.type !== "codeBlock";
}

function blockIds(blocks: unknown, into: string[] = []) {
  if (!Array.isArray(blocks)) return into;
  for (const block of blocks) {
    if (!record(block)) continue;
    if (typeof block.id === "string") into.push(block.id);
    blockIds(block.children, into);
  }
  return into;
}

/**
 * Short paragraph ids for the Assistant: the first eight letters and digits
 * of each block id, or the whole id where two blocks share those.
 */
export function shortParagraphIds(blocks: unknown): Map<string, string> {
  const ids = blockIds(blocks);
  const short = (id: string) => id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  const count = new Map<string, number>();
  for (const id of ids) count.set(short(id), (count.get(short(id)) ?? 0) + 1);
  return new Map(ids.map(id => [id, (count.get(short(id)) ?? 0) > 1 ? id.replace(/[^A-Za-z0-9]/g, "") : short(id)]));
}

export interface ManuscriptTextOptions {
  /** Start each editable paragraph and heading with `[¶id] ` (the Assistant's edit protocol). */
  paragraphIds?: boolean;
}

/** The whole manuscript as Markdown-like text; nested blocks are indented under their parent. */
export function manuscriptText(blocks: unknown, options: ManuscriptTextOptions = {}): string {
  const tags = options.paragraphIds ? shortParagraphIds(blocks) : null;
  const write = (list: unknown, depth: number): string => {
    if (!Array.isArray(list)) return "";
    const parts: string[] = [];
    const indent = "  ".repeat(depth);
    for (const block of list) {
      if (!record(block)) continue;
      let text = blockText(block);
      const tag = tags && typeof block.id === "string" && editableText(block) ? tags.get(block.id) : undefined;
      if (tag && text.trim()) text = `[¶${tag}] ${text}`;
      if (text.trim()) parts.push(depth ? text.split("\n").map(line => indent + line).join("\n") : text);
      const children = write(block.children, depth + 1);
      if (children) parts.push(children);
    }
    return parts.join("\n\n");
  };
  return write(blocks, 0);
}
