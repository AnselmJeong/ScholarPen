import { createHash, randomUUID } from "crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { figureMimeType, isProjectFigurePath } from "../../shared/figure-files";
import { externalizeExportImages } from "./export-images";
import { markdownImageDestinations } from "./markdown-images";

const MANIFEST = ".scholarpen-image-manifest.json";
interface ImageCopy { source: string; path: string; sha256: string }
interface Manifest { version: 1; images: ImageCopy[] }
export interface ExportDocument { path: string; content: string }
const pending = new Map<string, Promise<unknown>>();
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function isImageCopy(value: unknown): value is ImageCopy {
  if (!value || typeof value !== "object") return false;
  return "source" in value && typeof value.source === "string" && isProjectFigurePath(value.source)
    && !value.source.startsWith("exports/")
    && "path" in value && typeof value.path === "string" && isProjectFigurePath(value.path)
    && value.path.startsWith("figures/")
    && "sha256" in value && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
}

export function isInsideDirectory(root: string, path: string): boolean {
  const value = relative(root, path);
  return !!value && value !== ".." && !value.startsWith("../") && !isAbsolute(value);
}

async function entry(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Create ordinary directories only: never follow a redirected export folder. */
export async function ensureExportDirectory(root: string, directory: string): Promise<void> {
  if (directory !== root && !isInsideDirectory(root, directory)) throw new Error("Invalid export directory.");
  let current = root;
  for (const segment of relative(root, directory).split("/").filter(Boolean)) {
    current = join(current, segment);
    try { await mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!(await lstat(current)).isDirectory()) {
      throw new Error(`The export folder must be a real directory, not a symlink: ${current}`);
    }
  }
}

export async function writeExportAtomically(root: string, path: string, content: string | Buffer): Promise<void> {
  if (!isInsideDirectory(root, path)) throw new Error("Invalid export file path.");
  await ensureExportDirectory(root, dirname(path));
  const existing = await entry(path);
  if (existing && !existing.isFile()) throw new Error(`Cannot replace a symlink or directory: ${path}`);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: "wx", mode: existing?.mode });
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

async function loadManifest(exports: string): Promise<Manifest> {
  const file = join(exports, MANIFEST);
  const info = await entry(file);
  if (!info) return { version: 1, images: [] };
  if (!info.isFile()) throw new Error("The export image manifest must not be a symlink.");
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("images" in value) || !Array.isArray(value.images) || !value.images.every(isImageCopy)
    || new Set(value.images.map((item) => item.source)).size !== value.images.length
    || new Set(value.images.map((item) => item.path)).size !== value.images.length) {
    throw new Error("Invalid export image manifest. Cannot safely refresh generated figures.");
  }
  return { version: 1, images: value.images };
}

function imageUrl(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part).replace(/[()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

async function prepareBundle(projectPath: string, documents: ExportDocument[]): Promise<ExportDocument[]> {
  const root = await realpath(projectPath);
  const exports = join(root, "exports");
  await ensureExportDirectory(root, exports);
  const manifest = await loadManifest(exports);
  const before = JSON.stringify(manifest);
  const bySource = new Map(manifest.images.map((item) => [item.source, item]));
  const byCopy = new Map(manifest.images.map((item) => [item.path, item]));
  const writes = new Map<string, Buffer>();
  const preparedSources = new Map<string, string>();
  const result: ExportDocument[] = [];

  async function prepareImage(sourcePath: string): Promise<string> {
    const ready = preparedSources.get(sourcePath);
    if (ready) return ready;
    if (!isProjectFigurePath(sourcePath)) throw new Error(`Invalid project image path: ${sourcePath}`);
    let file: string;
    try { file = await realpath(join(root, sourcePath)); }
    catch { throw new Error(`Cannot find the original image: ${sourcePath}. Restore it before exporting or rendering.`); }
    if (!isInsideDirectory(root, file) || !(await lstat(file)).isFile()) {
      throw new Error(`The original image must be a file inside this project: ${sourcePath}`);
    }
    const bytes = await readFile(file);
    const sha256 = hash(bytes);
    let copy = bySource.get(sourcePath);
    if (!copy) {
      const preferred = sourcePath.startsWith("figures/") ? sourcePath : `figures/_project/${sourcePath}`;
      let path = preferred;
      for (let suffix = 0; byCopy.has(path) || await entry(join(exports, path)); suffix++) {
        const extension = extname(preferred);
        path = join(dirname(preferred), `${basename(preferred, extension)}-${hash(sourcePath).slice(0, 12)}${suffix ? `-${suffix}` : ""}${extension}`);
      }
      copy = { source: sourcePath, path, sha256 };
      manifest.images.push(copy);
      bySource.set(sourcePath, copy);
      byCopy.set(path, copy);
    }
    await ensureExportDirectory(root, dirname(join(exports, copy.path)));
    const existing = await entry(join(exports, copy.path));
    if (existing && !existing.isFile()) throw new Error(`The exported image must not be a symlink: ${copy.path}`);
    const currentHash = existing ? hash(await readFile(join(exports, copy.path))) : null;
    if (currentHash && currentHash !== copy.sha256 && currentHash !== sha256) {
      throw new Error(`The exported copy was edited: ${copy.path}. Preserve that edit and update the original ${sourcePath} before rendering.`);
    }
    if (currentHash !== sha256) writes.set(join(exports, copy.path), bytes);
    copy.sha256 = sha256;
    preparedSources.set(sourcePath, copy.path);
    return copy.path;
  }

  for (const document of documents) {
    const path = resolve(root, document.path);
    if (!isInsideDirectory(exports, path)) throw new Error("The document must be inside exports/.");
    // Existing embedded images retain their canonical, non-overwriting extraction.
    let content = await externalizeExportImages(root, document.content);
    const replacements: { start: number; end: number; url: string }[] = [];
    for (const image of markdownImageDestinations(content)) {
      if (!image.url || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(image.url)) continue;
      const match = /^([^?#]*)([?#].*)?$/.exec(image.url)!;
      let decoded: string;
      try { decoded = decodeURIComponent(match[1]); }
      catch { throw new Error(`Invalid image URL: ${image.url}`); }
      if (!figureMimeType(decoded)) continue;
      const source = resolve(dirname(path), decoded);
      if (!isInsideDirectory(root, source)) throw new Error(`The image is outside this project: ${image.url}`);
      const localCopy = byCopy.get(relative(exports, source));
      // An ordinary image already inside exports/ needs no rewriting or ownership.
      if (!localCopy && isInsideDirectory(exports, source)) continue;
      const copyPath = await prepareImage(localCopy?.source ?? relative(root, source));
      const url = imageUrl(relative(dirname(path), join(exports, copyPath))) + (match[2] ?? "");
      if (url !== image.url) replacements.push({ ...image, url });
    }
    for (const image of replacements.sort((a, b) => b.start - a.start)) {
      content = content.slice(0, image.start) + image.url + content.slice(image.end);
    }
    result.push({ path, content });
  }
  // All source reads and conflict checks finish before publishing any new copies.
  for (const [path, bytes] of writes) await writeExportAtomically(root, path, bytes);
  if (JSON.stringify(manifest) !== before) {
    await writeExportAtomically(root, join(exports, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  }
  return result;
}

/** Serialize manifest updates from concurrent chapter exports in this process. */
export async function bundleExportImages(projectPath: string, documents: ExportDocument[]): Promise<ExportDocument[]> {
  const root = await realpath(projectPath);
  const normalized = documents.map((document) => {
    if (!isInsideDirectory(resolve(projectPath), resolve(document.path))) throw new Error("Invalid export document path.");
    return { ...document, path: join(root, relative(resolve(projectPath), resolve(document.path))) };
  });
  const previous = pending.get(root) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => prepareBundle(root, normalized));
  pending.set(root, operation);
  try { return await operation; }
  finally { if (pending.get(root) === operation) pending.delete(root); }
}
