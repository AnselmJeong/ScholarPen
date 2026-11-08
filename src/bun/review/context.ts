import { readFile } from "node:fs/promises";
import type { ReviewContext, TextSlot, ReviewFigure, CoverageItem } from "../../shared/review-session/types";
import type { AgentImage } from "../../shared/rpc-types";
import { hash, scopedPath, manifest, exists } from "./workspace";
import { object } from "../../shared/review-session/schema";
export function atPath(root: unknown, path: (string | number)[]): unknown {
  let value = root;
  for (const key of path) { if (value == null || typeof value !== "object" || ["__proto__", "constructor", "prototype"].includes(String(key))) throw new Error("Invalid content path"); value = (value as Record<string | number, unknown>)[key]; }
  return value;
}
export function setPath(root: unknown, path: (string | number)[], value: unknown) {
  if (!path.length) throw new Error("Cannot replace document root");
  const parent = atPath(root, path.slice(0, -1));
  if (!parent || typeof parent !== "object") throw new Error("Invalid content parent");
  (parent as Record<string | number, unknown>)[path.at(-1)!] = value;
}
export function describeDocument(document: string, blocks: unknown[]) {
  const slots: TextSlot[] = []; const figures: ReviewFigure[] = []; const ids = new Set<string>();
  const add = (path: (string | number)[], text: string, blockId: string, kind: TextSlot["kind"]) => slots.push({ id: `${document}#${blockId}:${path.join("/")}`, document, blockId, path, text, kind });
  const inline = (value: unknown, path: (string | number)[], blockId: string, kind: TextSlot["kind"]) => {
    if (typeof value === "string") { add(path, value, blockId, kind); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => inline(v, [...path, i], blockId, kind)); return; }
    if (!value || typeof value !== "object") return;
    const v = object(value);
    if (v.type === "text" && typeof v.text === "string") add([...path, "text"], v.text, blockId, kind);
    else if (v.type === "link" || v.type === "tableCell") inline(v.content, [...path, "content"], blockId, kind);
  };
  const walk = (list: unknown[], base: (string | number)[]) => list.forEach((value, index) => {
    const block = object(value); const path = [...base, index];
    if (typeof block.id !== "string" || !block.id || ids.has(block.id)) throw new Error(`Missing or duplicate block ID in ${document}`);
    ids.add(block.id); const props = block.props && typeof block.props === "object" ? object(block.props) : {};
    if (block.type === "table") {
      const content = object(block.content); const rows = content.rows;
      if (!Array.isArray(rows) || !rows.length) throw new Error("Table has no rows");
      let width = -1;
      rows.forEach((row, r) => { const cells = object(row).cells; if (!Array.isArray(cells) || !cells.length) throw new Error("Invalid table cells");
        const rowWidth = cells.reduce((n: number, c: unknown) => n + (c && typeof c === "object" && !Array.isArray(c) ? Number(object(object(c).props ?? {}).colspan ?? 1) : 1), 0);
        if (width === -1) width = rowWidth; else if (width !== rowWidth) throw new Error("Table column counts differ");
        cells.forEach((cell, c) => inline(cell, [...path, "content", "rows", r, "cells", c], block.id as string, "table")); });
    } else inline(block.content, [...path, "content"], block.id, "text");
    if (typeof props.caption === "string") add([...path, "props", "caption"], props.caption, block.id, "caption");
    if (["figure", "image"].includes(String(block.type))) {
      const key = typeof props.sourcePath === "string" && props.sourcePath ? "sourcePath" : "url";
      figures.push({ id: `${document}#${block.id}`, document, blockId: block.id, path: [...path, "props", key], source: String(props[key] ?? ""), caption: String(props.caption ?? ""), hash: "", available: false });
    }
    if (Array.isArray(block.children)) walk(block.children, [...path, "children"]);
  });
  walk(blocks, []); return { slots, figures };
}
export async function figureImage(root: string, figure: ReviewFigure): Promise<AgentImage> {
  let dataUrl: string;
  if (figure.source.startsWith("data:image/")) dataUrl = figure.source;
  else {
    const ext = figure.source.split(".").at(-1)?.toLowerCase(); const mime = ({ png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp", gif: "gif" } as Record<string, string>)[ext ?? ""];
    if (!mime) throw new Error("검토용 PNG/JPEG/WebP/GIF가 필요합니다. SVG/PDF 및 다른 형식은 미검토로 기록합니다.");
    const bytes = await readFile(await scopedPath(root, figure.source));
    dataUrl = `data:image/${mime};base64,${bytes.toString("base64")}`;
  }
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) || dataUrl.length > 5 * 1024 * 1024 * 4 / 3 + 64) throw new Error("이미지 형식 또는 5 MB 검토 한도를 확인해 주세요.");
  const bytes = Buffer.from(dataUrl.split(",")[1]!, "base64");
  const valid = dataUrl.startsWith("data:image/png;") ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : dataUrl.startsWith("data:image/jpeg;") ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : dataUrl.startsWith("data:image/gif;") ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new Error("Image bytes do not match their declared format");
  return { name: figure.id, dataUrl };
}
export async function context(root: string, names: string[]): Promise<ReviewContext> {
  const documents: Record<string, unknown[]> = {}; const slots: TextSlot[] = []; const figures: ReviewFigure[] = []; const coverage: CoverageItem[] = [];
  for (const name of names) {
    const raw = await readFile(await scopedPath(root, `documents/${name}`), "utf8"); const blocks: unknown = JSON.parse(raw);
    if (!Array.isArray(blocks)) throw new Error("Invalid manuscript JSON"); documents[name] = blocks;
    try {
      const described = describeDocument(name, blocks); slots.push(...described.slots); figures.push(...described.figures);
      coverage.push({ target: name, hash: hash(raw), status: "read", detail: "Complete structured document; no excerpting" });
    } catch (error) {
      coverage.push({ target: name, hash: hash(raw), status: "unavailable", detail: `Document retained as read-only reference: structure cannot be safely edited. ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  for (const figure of figures) {
    try { const image = await figureImage(root, figure); figure.hash = hash(image.dataUrl); figure.available = true; }
    catch (e) { figure.reason = e instanceof Error ? e.message : String(e); coverage.push({ target: figure.id, hash: "", status: "unavailable", detail: figure.reason }); }
  }
  const bibliography = await exists(root, "exports/references.bib") ? await readFile(await scopedPath(root, "exports/references.bib"), "utf8") : "";
  const m = await manifest(root);
  return { documents, slots, figures, bibliography, coverage, packageHash: m.packageHash };
}
export function contextText(c: ReviewContext) {
  const tables: { document: string; blockId: string; rowsHash: string }[] = [];
  for (const [document, blocks] of Object.entries(c.documents)) {
    const walk = (items: unknown[]) => { for (const item of items) { if (!item || typeof item !== "object" || Array.isArray(item)) continue; const b = item as Record<string, unknown>; if (b.type === "table" && b.content && typeof b.content === "object" && Array.isArray((b.content as Record<string, unknown>).rows)) tables.push({ document, blockId: String(b.id), rowsHash: hash(JSON.stringify((b.content as Record<string, unknown>).rows)) }); if (Array.isArray(b.children)) walk(b.children); } };
    walk(blocks);
  }
  const text = JSON.stringify({ tableHashes: tables, documents: c.documents, editableSlots: c.slots, figures: c.figures, bibliography: c.bibliography });
  return text;
}
