/**
 * The Assistant tab cannot edit documents itself. When the author asks it to
 * change a manuscript, the model writes one `<scholarpen_edit>` block; the
 * renderer hands that instruction to ScholarPen AI as a whole-manuscript
 * request, which applies the project's edit level and lands as tracked
 * changes like any comment request.
 */

export interface DocumentEditRequest {
  /** Path as the model wrote it: project-relative (`documents/x.scholarpen.json`), absolute, or empty for the open document. */
  document: string;
  instruction: string;
}

const COMPLETE_BLOCK = /<scholarpen_edit\b([^>]*)>([\s\S]*?)<\/scholarpen_edit>/g;
const OPEN_TAG = "<scholarpen_edit";

const MAX_REQUESTS = 3;
const MAX_INSTRUCTION = 6_000;

function attribute(attributes: string, name: string): string {
  const match = attributes.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

/** Complete edit requests in a finished answer, at most three, empty instructions dropped. */
export function extractDocumentEditRequests(text: string): DocumentEditRequest[] {
  const requests: DocumentEditRequest[] = [];
  for (const match of text.matchAll(COMPLETE_BLOCK)) {
    const instruction = match[2].trim().slice(0, MAX_INSTRUCTION);
    if (!instruction) continue;
    requests.push({ document: attribute(match[1], "document"), instruction });
    if (requests.length >= MAX_REQUESTS) break;
  }
  return requests;
}

/** Short name of a manuscript path for messages: the file name without `.scholarpen.json`. */
export function documentEditLabel(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return name.replace(/\.scholarpen\.json$/i, "") || path;
}

/** Text from the start of a request whose closing tag has not arrived (or of its tag name), or -1. */
function unfinishedRequestStart(text: string): number {
  const open = text.lastIndexOf(OPEN_TAG);
  if (open >= 0 && !text.includes("</scholarpen_edit>", open)) return open;
  const last = text.lastIndexOf("<");
  return last >= 0 && last > text.length - OPEN_TAG.length && OPEN_TAG.startsWith(text.slice(last)) ? last : -1;
}

/** True when the answer opened a request it never closed (so nothing was sent). */
export function hasUnfinishedDocumentEditRequest(text: string): boolean {
  const open = text.lastIndexOf(OPEN_TAG);
  return open >= 0 && !text.includes("</scholarpen_edit>", open);
}

/**
 * What the chat shows: each request as a quote the author can read. While
 * streaming, a request still being written is hidden until it is complete.
 */
export function formatDocumentEditRequests(text: string, lang: "ko" | "en", streaming = true): string {
  const label = lang === "ko" ? "ScholarPen AI 수정 요청" : "Edit request for ScholarPen AI";
  const shown = text.replace(COMPLETE_BLOCK, (_whole, attributes: string, body: string) => {
    const instruction = body.trim();
    if (!instruction) return "";
    const target = attribute(attributes, "document");
    const quoted = instruction.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    return `> **${label}**${target ? ` · ${documentEditLabel(target)}` : ""}\n>\n${quoted}`;
  });
  if (!streaming) return shown;
  const cut = unfinishedRequestStart(shown);
  return cut < 0 ? shown : shown.slice(0, cut).trimEnd();
}

/**
 * The absolute manuscript path a request targets, or null when it names
 * something other than a document of this project. An empty name means the
 * open document.
 */
export function resolveDocumentEditTarget(
  document: string,
  projectPath: string,
  activeDocumentPath?: string | null,
): string | null {
  const root = projectPath.replace(/[\\/]+$/, "");
  const requested = document.trim().replace(/^@\[(.*)\]$/, "$1").replace(/^@/, "");
  const raw = requested || activeDocumentPath || "";
  if (!raw) return null;
  const absolute = raw.startsWith("/") ? raw : `${root}/${raw.replace(/^\.\//, "")}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  const normalized = `/${parts.join("/")}`;
  if (!normalized.startsWith(`${root}/documents/`) || !/\.scholarpen\.json$/i.test(normalized)) return null;
  return normalized;
}

/** Instructions for the Assistant's system message (general chat only). */
export const DOCUMENT_EDIT_PROTOCOL = [
  "You cannot change files yourself, but you can ask ScholarPen AI, the app's editing agent, to change a manuscript in the editor.",
  "Do this only when the user's latest message asks you to change, rewrite, delete from, shorten or otherwise edit a manuscript document (including a request to retry such an edit). Never do it for questions, explanations or proposals the user has not asked to apply.",
  "To ask, write a brief reply that says you are sending the request (never claim the change is already made), then exactly one block per document:",
  '<scholarpen_edit document="documents/<file>.scholarpen.json">',
  "Self-contained instruction for ScholarPen AI",
  "</scholarpen_edit>",
  "Use the project-relative path of the active document or of a document the user mentioned; leave the attribute empty for the active document.",
  "ScholarPen AI does not see this conversation. The instruction must stand on its own: name the section, quote the exact sentences or phrases to remove or change, say how the paragraph should read afterwards (for example, rewritten so it no longer contains the removed content and still flows), and what must stay. Write it in the user's language.",
  "Writing the block is not a tool call and touches no file: ScholarPen hands it to ScholarPen AI, which applies the document's AI edit level and shows the result as tracked changes the user can keep or revert.",
].join("\n");
