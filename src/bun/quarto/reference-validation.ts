import { readFile } from "fs/promises";
import { isAbsolute, relative, resolve } from "path";
import { parseDocument } from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import { isQuartoReference } from "../../shared/quarto-references";

/** Inspect static Quarto targets only; do not mistake code examples, links, or
 * arbitrary prose mentioning an attribute for an actual target definition. */
export function staticQuartoLabels(source: string): string[] {
  source = source.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  const labels: string[] = [];
  function visit(node: Root | RootContent) {
    const raw = source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
    let attributes = "";
    if (node.type === "heading") attributes = raw.match(/\{([^{}]*)\}\s*$/)?.[1] ?? "";
    if (node.type === "paragraph") {
      if (node.children[0]?.type === "image" || /^:\s/.test(raw) || /^\$\$[\s\S]*\$\$\s*\{/.test(raw)) {
        attributes = raw.match(/\{([^{}]*)\}\s*$/)?.[1] ?? "";
      } else if (/^:::+\s*\{/.test(raw)) attributes = raw.match(/^:::+\s*\{([^{}]*)\}/)?.[1] ?? "";
    }
    const label = attributes.match(/(?:^|\s)#([\w:.-]+)/)?.[1];
    if (label && isQuartoReference(label)) labels.push(label);
    if ("children" in node) node.children.forEach((child) => visit(child as RootContent));
  }
  visit(tree);
  return labels;
}

export function quartoBookChapterFiles(config: string): string[] {
  const document = parseDocument(config);
  const root = document.toJS({ maxAliasCount: 100 });
  const files: string[] = [];
  function chapters(value: unknown): void {
    if (typeof value === "string" && /\.qmd$/i.test(value)) files.push(value);
    else if (Array.isArray(value)) value.forEach(chapters);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      chapters(record.chapters);
      chapters(record.part);
      chapters(record.href);
    }
  }
  chapters(root?.book?.chapters);
  chapters(root?.book?.appendices);
  return [...new Set(files)];
}

export async function duplicateBookReferenceDiagnostic(directory: string, config: string): Promise<string | null> {
  const definitions = new Map<string, string[]>();
  for (const filename of quartoBookChapterFiles(config)) {
    const path = resolve(directory, filename);
    const relativePath = relative(directory, path);
    if (isAbsolute(relativePath) || relativePath.startsWith("..")) continue;
    let source: string;
    try { source = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Quarto explains missing chapters.
      throw error;
    }
    for (const label of staticQuartoLabels(source)) definitions.set(label, [...(definitions.get(label) ?? []), filename]);
  }
  const duplicates = [...definitions].filter(([, filenames]) => filenames.length > 1);
  return duplicates.length ? `Duplicate document identifiers: ${duplicates.map(([label, filenames]) => `${label} (${filenames.join(", ")})`).join("; ")}. Give every target a unique identifier across all book chapters.` : null;
}
