// ── YAML Frontmatter Parser ─────────────────────────────────────────────
// Lightweight parser for YAML frontmatter in Markdown/Quarto files.
// Handles key-value pairs, inline arrays, quoted strings, and empty arrays.

export interface FrontmatterResult {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

/**
 * Parse YAML frontmatter from the beginning of a Markdown/Quarto file.
 * Returns the parsed key-value pairs and the remaining body content.
 * If no frontmatter is found, returns { frontmatter: null, body: content }.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split("\n");

  // Check if content starts with ---
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: null, body: content };
  }

  // Find the closing --- delimiter
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return { frontmatter: null, body: content };
  }

  const yamlLines = lines.slice(1, closingIndex);
  const yamlText = yamlLines.join("\n");
  const bodyLines = lines.slice(closingIndex + 1);
  const body = bodyLines.join("\n");

  return {
    frontmatter: parseYamlLines(yamlText),
    body,
  };
}

/**
 * Strip YAML frontmatter from content, returning only the body.
 */
export function stripFrontmatter(content: string): string {
  const { body } = parseFrontmatter(content);
  return body;
}

/**
 * Parse simple YAML key-value pairs from frontmatter text.
 * Handles:
 * - Simple string values: `title: My Document`
 * - Quoted string values: `title: "My Document"`
 * - Inline arrays: `tags: [a, b, c]`
 * - Empty arrays: `tags: []`
 * - Number values: `year: 2024`
 * - Boolean values: `published: true`
 */
function parseYamlLines(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Match key: value
    const match = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (value === "") {
      result[key] = null;
    } else if (value === "[]") {
      result[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      // Inline array: [item1, item2, ...]
      result[key] = parseInlineArray(value);
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      // Quoted string
      result[key] = value.slice(1, -1);
    } else if (value === "true" || value === "True") {
      result[key] = true;
    } else if (value === "false" || value === "False") {
      result[key] = false;
    } else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    } else if (/^-?\d+\.\d+$/.test(value)) {
      result[key] = parseFloat(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Parse a YAML inline array like [item1, item2, "quoted item"].
 */
function parseInlineArray(value: string): unknown[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];

  const items: unknown[] = [];
  let current = "";
  let inQuotes: string | null = null;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (inQuotes) {
      if (ch === inQuotes) {
        inQuotes = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = ch;
    } else if (ch === ",") {
      items.push(parseYamlScalar(current.trim()));
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    items.push(parseYamlScalar(current.trim()));
  }

  return items;
}

/**
 * Parse a single YAML scalar value.
 */
function parseYamlScalar(value: string): unknown {
  if (!value) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true" || value === "True") return true;
  if (value === "false" || value === "False") return false;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}