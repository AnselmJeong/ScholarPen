import { Schema, type AttributeSpec, type MarkSpec, type NodeSpec } from "prosemirror-model";

// The webview owns BlockNote (React block specs, DOM rendering). The Bun AI peer
// only needs the content model to read and write the shared Y.Doc, so the
// webview ships a JSON-safe copy of `editor.pmSchema.spec` and Bun rebuilds a
// render-less Schema from it.

type JsonAttr = { default?: unknown; hasDefault: boolean; validate?: string };
type JsonNodeSpec = Omit<NodeSpec, "attrs" | "toDOM" | "parseDOM" | "leafText" | "toDebugString"> & {
  attrs?: Record<string, JsonAttr>;
};
type JsonMarkSpec = Omit<MarkSpec, "attrs" | "toDOM" | "parseDOM"> & { attrs?: Record<string, JsonAttr> };

export interface SchemaSpecJSON {
  topNode?: string;
  nodes: Array<[string, JsonNodeSpec]>;
  marks: Array<[string, JsonMarkSpec]>;
}

const NODE_KEYS = [
  "content", "marks", "group", "inline", "atom", "selectable", "draggable", "code", "whitespace",
  "definingAsContext", "definingForContent", "defining", "isolating",
] as const;
const MARK_KEYS = ["inclusive", "excludes", "group", "spanning"] as const;

function attrsToJSON(attrs: Record<string, AttributeSpec> | undefined) {
  if (!attrs) return undefined;
  const out: Record<string, JsonAttr> = {};
  for (const [name, spec] of Object.entries(attrs)) {
    const hasDefault = Object.prototype.hasOwnProperty.call(spec, "default");
    out[name] = { hasDefault, ...(hasDefault ? { default: spec.default } : {}) };
    if (typeof spec.validate === "string") out[name].validate = spec.validate;
  }
  return out;
}

function attrsFromJSON(attrs: Record<string, JsonAttr> | undefined) {
  if (!attrs) return undefined;
  const out: Record<string, AttributeSpec> = {};
  for (const [name, spec] of Object.entries(attrs)) {
    out[name] = spec.hasDefault ? { default: spec.default } : {};
  }
  return out;
}

function pick<T extends object>(spec: T, keys: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (spec as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "function") out[key] = value;
  }
  return out;
}

export function schemaToSpecJSON(schema: Schema): SchemaSpecJSON {
  const nodes: SchemaSpecJSON["nodes"] = [];
  schema.spec.nodes.forEach((name, spec) => {
    nodes.push([name, { ...pick(spec, NODE_KEYS), attrs: attrsToJSON(spec.attrs) } as JsonNodeSpec]);
  });
  const marks: SchemaSpecJSON["marks"] = [];
  schema.spec.marks.forEach((name, spec) => {
    marks.push([name, { ...pick(spec, MARK_KEYS), attrs: attrsToJSON(spec.attrs) } as JsonMarkSpec]);
  });
  return { topNode: schema.spec.topNode, nodes, marks };
}

/** Leaf text for atoms so textContent/textBetween stay readable in prompts. */
function leafText(node: { type: { name: string }; attrs: Record<string, unknown> }) {
  const attrs = node.attrs;
  switch (node.type.name) {
    case "citation": return `[@${attrs.citekey ?? ""}${attrs.locator ? `, ${attrs.locator}` : ""}]`;
    case "crossReference": return `@${attrs.label ?? ""}`;
    case "inlineMath": return `$${attrs.formula ?? ""}$`;
    case "footnote": return `[^${attrs.index ?? ""}]`;
    case "hardBreak": return "\n";
    default: return "";
  }
}

export function schemaFromSpecJSON(json: SchemaSpecJSON): Schema {
  const nodes: Record<string, NodeSpec> = {};
  for (const [name, spec] of json.nodes) {
    nodes[name] = { ...spec, attrs: attrsFromJSON(spec.attrs) } as NodeSpec;
    if (spec.inline && spec.atom) nodes[name].leafText = leafText as NodeSpec["leafText"];
  }
  const marks: Record<string, MarkSpec> = {};
  for (const [name, spec] of json.marks) marks[name] = { ...spec, attrs: attrsFromJSON(spec.attrs) } as MarkSpec;
  return new Schema({ topNode: json.topNode, nodes, marks });
}
