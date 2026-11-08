import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "../../shared/collab/protocol";
import { manuscriptHash } from "../collab/registry";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, statfs } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import type { ReviewManifest, ManifestFile } from "../../shared/review-session/types";
export const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export function safeRelative(path: string): string {
  if (!path || isAbsolute(path) || /[\\\0]/.test(path) || path.split("/").some(p => !p || p === "." || p === "..") || /^[a-z]+:/i.test(path)) throw new Error(`Unsafe review path: ${path}`);
  return path;
}
/** Every component is checked, including existing destination symlinks. */
export async function scopedPath(root: string, path: string): Promise<string> {
  safeRelative(path); const base = await realpath(root); let current = base;
  for (const part of path.split("/")) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink is not allowed in a review workspace: ${path}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const rel = relative(base, current); if (!rel || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Review path escaped its workspace.");
  return current;
}
export async function atomicWrite(root: string, path: string, content: string | Uint8Array) {
  const target = await scopedPath(root, path); await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`; await writeFile(temp, content); await rename(temp, target);
}
export const writeJSON = (root: string, path: string, value: unknown) => atomicWrite(root, path, JSON.stringify(value, null, 2) + "\n");
export async function readJSON<T>(root: string, path: string): Promise<T> { return JSON.parse(await readFile(await scopedPath(root, path), "utf8")) as T; }
export async function exists(root: string, path: string) { try { await lstat(await scopedPath(root, path)); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
export async function filesIn(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(prefix ? await scopedPath(root, prefix) : root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in package: ${path}`);
    if (entry.isDirectory()) result.push(...await filesIn(root, path)); else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
export async function manifest(root: string, warnings: string[] = []): Promise<ReviewManifest> {
  const files: ManifestFile[] = [];
  for (const path of await filesIn(root)) { const data = await readFile(await scopedPath(root, path)); files.push({ path, hash: hash(data), bytes: data.byteLength }); }
  return { schemaVersion: 1, files, packageHash: hash(JSON.stringify(files)), warnings };
}
export async function copyPackage(from: string, to: string) {
  await mkdir(to, { recursive: true });
  for (const path of await filesIn(from)) await atomicWrite(to, path, await readFile(await scopedPath(from, path)));
}
export async function snapshot(source: string, target: string, documents: string[]): Promise<ReviewManifest> {
  const paths = new Set<string>(documents.map(name => {
    if (!name.endsWith(".scholarpen.json")) throw new Error("Only ScholarPen manuscripts are supported");
    return `documents/${safeRelative(name)}`;
  }));
  const collaboration = new Map<string, string>();
  for (const name of documents) {
    const statePath = `.scholarpen/collab/${name}.ydoc`;
    if (!await exists(source, statePath)) continue;
    const bytes = await readFile(await scopedPath(source, statePath));
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, bytes);
      if (/<(?:insertion|deletion|modification)(?:\s|>)/.test(doc.getXmlFragment(COLLAB_FRAGMENT).toString())) throw new Error(`${name}: 미결정 변경 제안이 있습니다. 해당 문서를 열어 기준본을 확정해 주세요.`);
      if (await exists(source, `${statePath}.meta.json`)) {
        const meta = await readJSON<{ updatedAt?: number; jsonSavedAt?: number; jsonContentHash?: string }>(source, `${statePath}.meta.json`);
        const stale = meta.jsonContentHash ? manuscriptHash(doc) !== meta.jsonContentHash : (meta.updatedAt ?? 0) > (meta.jsonSavedAt ?? 0) + 2000;
        if (stale) throw new Error(`${name}: 편집 내용이 원고 파일에 저장되지 않았습니다. 이 원고를 열어 저장한 뒤 다시 시작해 주세요.`);
      }
      collaboration.set(statePath, manuscriptHash(doc));
    } finally { doc.destroy(); }
  }
  const warnings: string[] = [];
  const collect = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (!v || typeof v !== "object") return;
    for (const [key, val] of Object.entries(v)) {
      if (typeof val === "string" && ["sourcePath", "url", "src"].includes(key) && val) {
        if (val.startsWith("data:image/")) continue;
        if (/^(figures|resources)\//.test(val)) paths.add(safeRelative(val));
        else if (!/^https?:\/\//.test(val) || key !== "url") warnings.push(`Unavailable external dependency: ${val}`);
        else warnings.push(`Remote image/link not fetched: ${val}`);
      } else collect(val);
    }
  };
  for (const path of paths) {
    if (!path.endsWith(".scholarpen.json")) continue;
    const doc: unknown = JSON.parse(await readFile(await scopedPath(source, path), "utf8"));
    if (!Array.isArray(doc)) throw new Error(`Invalid manuscript: ${path}`);
    if (/"(?:insertion|deletion|modification)"\s*:/.test(JSON.stringify(doc))) throw new Error("미결정 변경 제안을 수락 또는 거절한 뒤 시작해 주세요.");
    collect(doc);
  }
  if (await exists(source, "exports/references.bib")) paths.add("exports/references.bib");
  const originals = new Map<string, Uint8Array>();
  for (const path of paths) {
    try { originals.set(path, await readFile(await scopedPath(source, path))); }
    catch (e) { if (path.startsWith("documents/")) throw e; warnings.push(`Unavailable dependency ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const size = [...originals.values()].reduce((n, b) => n + b.byteLength, 0);
  const free = await statfs(source); if (Number(free.bavail) * Number(free.bsize) < size * 8 + 50_000_000) throw new Error("리뷰 사본을 저장할 공간이 부족합니다.");
  await mkdir(target, { recursive: true });
  for (const [path, data] of originals) await atomicWrite(target, path, data);
  for (const [path, data] of originals) if (hash(await readFile(await scopedPath(source, path))) !== hash(data)) throw new Error("원고가 저장 중 변경되었습니다. 저장 후 다시 시작해 주세요.");
  for (const [path, before] of collaboration) {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, await readFile(await scopedPath(source, path)));
      if (manuscriptHash(doc) !== before) throw new Error("스냅샷 생성 중 원고 내용이 변경되었습니다. 다시 시작해 주세요.");
    } finally { doc.destroy(); }
  }
  return manifest(target, warnings);
}
export function isReviewStoragePath(path: string) { return resolve(path).split(/[\\/]/).includes("reviews"); }
