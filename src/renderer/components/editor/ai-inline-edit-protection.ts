import { Slice, type Node as ProseMirrorNode, type Schema } from "prosemirror-model";

type SourceLanguage = "Korean" | "English" | "the original language";

type SerializedNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: SerializedNode[];
  [key: string]: unknown;
};

export type SerializedSlice = {
  content?: SerializedNode[];
  openStart?: number;
  openEnd?: number;
};

type ProtectionMarker =
  | { kind: "text-open"; token: string; textIndex: number }
  | { kind: "text-close"; token: string; textIndex: number }
  | { kind: "literal"; token: string; value: string }
  | { kind: "node"; token: string; nodeType: string; preview: string };

export interface ProtectedSelection {
  namespace: string;
  slice: SerializedSlice;
  protectedText: string;
  sourceLanguage: SourceLanguage;
  markers: ProtectionMarker[];
  textNodeCount: number;
}

const PROTECTED_LITERAL_PATTERN =
  /(`{1,3}[^`\n]*`{1,3}|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+\$|!\[[^\]\n]*\]\([^\n)]+\)|\[[^\]\n]+\]\([^\n)]+\)|\[@[^\]\n]+\]|\[\^[^\]\n]+\]|\\(?:cite|citep|citet|autocite|parencite|textcite|ref|eqref|label)\*?(?:\[[^\]\n]*\])?\{[^}\n]+\}|(?<![\w@])@[A-Za-z][\w:.-]*|[*_~]{2,}|[*_]|^(?:#{1,6}|>|(?:[-+] |\d+\. ))(?=\s?))/gm;

function createNamespace() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return (uuid ?? `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9]/g, "");
}

function token(namespace: string, label: string) {
  return `⟦SP:${namespace}:${label}⟧`;
}

function detectSourceLanguage(text: string): SourceLanguage {
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text)) return "Korean";
  if (/[A-Za-z]/.test(text)) return "English";
  return "the original language";
}

function nodePreview(node: ProseMirrorNode) {
  const attrs = node.attrs as Record<string, unknown>;
  if (node.type.name === "citation") {
    const citekey = typeof attrs.citekey === "string" ? attrs.citekey : "citation";
    const locator = typeof attrs.locator === "string" && attrs.locator ? `, ${attrs.locator}` : "";
    return `[@${citekey}${locator}]`;
  }
  if (node.type.name === "footnote") {
    const index = typeof attrs.index === "number" ? attrs.index : "";
    return `[^${index}]`;
  }
  if (node.type.name === "hardBreak" || node.type.name === "hard_break") return "\n";
  return `⟦${node.type.name}⟧`;
}

/**
 * Converts a ProseMirror selection Slice into an annotated prompt passage.
 * Each text node gets its own editable envelope, while marks, custom inline
 * nodes, block structure, citations, math, and literal Markdown controls stay
 * in the serialized Slice and are represented by immutable markers.
 */
export function protectSelectionSlice(
  slice: Slice,
  selectedText: string,
  namespace = createNamespace()
): ProtectedSelection {
  const markers: ProtectionMarker[] = [];
  let textNodeCount = 0;
  let nodeCount = 0;
  let literalCount = 0;

  const protectText = (text: string, textIndex: number) => {
    const open = token(namespace, `T${textIndex}:OPEN`);
    const close = token(namespace, `T${textIndex}:CLOSE`);
    markers.push({ kind: "text-open", token: open, textIndex });

    let output = open;
    let cursor = 0;
    PROTECTED_LITERAL_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(PROTECTED_LITERAL_PATTERN)) {
      const index = match.index ?? 0;
      output += text.slice(cursor, index);
      const literalToken = token(namespace, `L${literalCount++}`);
      markers.push({ kind: "literal", token: literalToken, value: match[0] });
      output += literalToken;
      cursor = index + match[0].length;
    }
    output += text.slice(cursor);
    output += close;
    markers.push({ kind: "text-close", token: close, textIndex });
    return output;
  };

  const walkNode = (node: ProseMirrorNode): string => {
    if (node.isText) return protectText(node.text ?? "", textNodeCount++);

    if (node.isLeaf) {
      const nodeToken = token(namespace, `N${nodeCount++}:${node.type.name}`);
      markers.push({
        kind: "node",
        token: nodeToken,
        nodeType: node.type.name,
        preview: nodePreview(node),
      });
      return nodeToken;
    }

    let output = "";
    node.forEach((child) => {
      output += walkNode(child);
      if (child.isBlock) output += "\n";
    });
    return output;
  };

  let protectedText = "";
  slice.content.forEach((node) => {
    protectedText += walkNode(node);
    if (node.isBlock) protectedText += "\n";
  });

  if (textNodeCount === 0) {
    throw new Error("The selection does not contain editable text.");
  }

  return {
    namespace,
    slice: slice.toJSON() as SerializedSlice,
    protectedText,
    sourceLanguage: detectSourceLanguage(selectedText),
    markers,
    textNodeCount,
  };
}

export function buildInlineEditMessages(instruction: string, selection: ProtectedSelection) {
  const languageRule =
    selection.sourceLanguage === "the original language"
      ? "Keep the replacement in the same language as the source passage"
      : `The source passage is ${selection.sourceLanguage}. Write the replacement in ${selection.sourceLanguage}`;

  const system =
    "You are an academic writing assistant editing a selection from a BlockNote JSON document. " +
    `${languageRule}, unless the user explicitly asks to translate it into another language. ` +
    "The passage contains ScholarPen control markers beginning with ⟦SP:. They encode text-node boundaries, " +
    "rich-text marks, Markdown or Quarto typesetting, citations, footnotes, inline math, links, and other custom inline nodes. " +
    "Copy every control marker exactly once and in exactly the same order. Never add, delete, edit, translate, reorder, or move a marker. " +
    "Rewrite only the natural-language text inside each T:OPEN and matching T:CLOSE marker. " +
    "Return ONLY the annotated rewritten passage, with no explanation, preamble, code fence, or surrounding quotation marks.";

  const user = `${instruction}\n\nAnnotated source passage:\n${selection.protectedText}`;
  return { system, user };
}

function parseProtectedRewrite(response: string, selection: ProtectedSelection) {
  const rewrittenText = Array.from({ length: selection.textNodeCount }, () => "");
  let activeTextIndex: number | null = null;
  let cursor = 0;

  for (const marker of selection.markers) {
    const markerIndex = response.indexOf(marker.token, cursor);
    if (markerIndex < 0) {
      throw new Error(
        "The AI changed or omitted a protected BlockNote marker. Retry the rewrite; the document was not modified."
      );
    }
    if (response.indexOf(marker.token, markerIndex + marker.token.length) >= 0) {
      throw new Error(
        "The AI duplicated a protected BlockNote marker. Retry the rewrite; the document was not modified."
      );
    }

    const between = response.slice(cursor, markerIndex);
    if (activeTextIndex === null) {
      if (between.trim()) {
        throw new Error(
          "The AI added text outside the protected BlockNote text boundaries. Retry the rewrite; the document was not modified."
        );
      }
    } else {
      rewrittenText[activeTextIndex] += between;
    }

    if (marker.kind === "text-open") {
      if (activeTextIndex !== null) throw new Error("Invalid nested BlockNote text markers in the AI response.");
      activeTextIndex = marker.textIndex;
    } else if (marker.kind === "text-close") {
      if (activeTextIndex !== marker.textIndex) {
        throw new Error("The AI reordered protected BlockNote text boundaries. The document was not modified.");
      }
      activeTextIndex = null;
    } else if (marker.kind === "literal") {
      if (activeTextIndex === null) {
        throw new Error("The AI moved a protected Markdown or citation token. The document was not modified.");
      }
      rewrittenText[activeTextIndex] += marker.value;
    } else if (activeTextIndex !== null) {
      throw new Error("The AI moved a protected inline node into a text node. The document was not modified.");
    }

    cursor = markerIndex + marker.token.length;
  }

  if (activeTextIndex !== null) throw new Error("The AI response has an unclosed BlockNote text boundary.");
  if (response.slice(cursor).trim()) {
    throw new Error("The AI added trailing text outside the protected BlockNote selection. The document was not modified.");
  }
  if (rewrittenText.some((text) => text.length === 0)) {
    throw new Error(
      "The AI removed an entire formatted text segment. Retry the rewrite; the document was not modified."
    );
  }
  if (rewrittenText.some((text) => text.includes(`⟦SP:${selection.namespace}:`))) {
    throw new Error("The AI introduced an unknown BlockNote control marker. The document was not modified.");
  }

  return rewrittenText;
}

function replaceSerializedText(nodes: SerializedNode[] | undefined, rewrittenText: string[]) {
  let textIndex = 0;
  const visit = (node: SerializedNode): SerializedNode => {
    if (node.type === "text") {
      return { ...node, text: rewrittenText[textIndex++] };
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(visit) };
  };

  const content = nodes?.map(visit);
  if (textIndex !== rewrittenText.length) {
    throw new Error("The saved BlockNote selection no longer matches the protected text structure.");
  }
  return content;
}

export function restoreProtectedSelection(
  schema: Schema,
  selection: ProtectedSelection,
  response: string
) {
  const rewrittenText = parseProtectedRewrite(response, selection);
  const rewrittenSlice: SerializedSlice = {
    ...selection.slice,
    content: replaceSerializedText(selection.slice.content, rewrittenText),
  };
  return Slice.fromJSON(schema, rewrittenSlice);
}

export function protectedRewritePreview(response: string, selection: ProtectedSelection) {
  let preview = response;
  for (const marker of selection.markers) {
    const replacement =
      marker.kind === "literal" ? marker.value : marker.kind === "node" ? marker.preview : "";
    preview = preview.split(marker.token).join(replacement);
  }
  return preview.trim();
}

export function isSameProtectedSlice(slice: Slice, selection: ProtectedSelection) {
  return JSON.stringify(slice.toJSON()) === JSON.stringify(selection.slice);
}
