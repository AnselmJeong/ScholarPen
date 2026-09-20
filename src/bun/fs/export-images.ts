import { createHash, randomUUID } from "crypto";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "fs/promises";
import { join, relative } from "path";
import { FIGURE_MIME_TYPES, figureExportUrl } from "../../shared/figure-files";
import { markdownImageDestinations } from "./markdown-images";

function decodeImage(url: string): { bytes: Buffer; extension: string } {
  const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  const extension = match && Object.entries(FIGURE_MIME_TYPES)
    .find(([, mime]) => mime === match[1].toLowerCase())?.[0];
  if (!match || !extension) throw new Error("Cannot export an unsupported or malformed embedded image.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
    throw new Error("Cannot export a malformed base64 image.");
  }
  return { bytes, extension };
}

async function saveImage(projectPath: string, bytes: Buffer, extension: string): Promise<string> {
  const root = await realpath(projectPath);
  const figures = join(root, "figures");
  await mkdir(figures, { recursive: true });
  // Do not write through a redirected figures folder.
  if (await realpath(figures) !== figures) throw new Error("The figures folder must be inside this project.");
  const stem = `embedded-${createHash("sha256").update(bytes).digest("hex")}`;
  const temporary = join(figures, `.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    for (let suffix = 0; ; suffix++) {
      const destination = join(figures, `${stem}${suffix ? `-${suffix}` : ""}.${extension}`);
      try {
        // Publish complete bytes atomically, without replacing a file or symlink.
        await link(temporary, destination);
        return figureExportUrl(relative(root, destination));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await lstat(destination)).isFile() && (await readFile(destination)).equals(bytes)) {
          return figureExportUrl(relative(root, destination));
        }
        // An extracted file may have been edited. Preserve it and use a new name.
      }
    }
  } finally {
    await unlink(temporary);
  }
}

/** Replace only Markdown image destinations, leaving all other source text intact. */
export async function externalizeExportImages(projectPath: string, markdown: string): Promise<string> {
  if (!/data:image\//i.test(markdown)) return markdown;
  const replacements = markdownImageDestinations(markdown)
    .filter((image) => /^data:image\//i.test(image.url))
    .map((image) => ({ ...image, ...decodeImage(image.url) }));
  const saved = new Map<string, string>();
  // All images are validated before any assets or the export are written.
  for (const image of replacements) {
    if (!saved.has(image.url)) saved.set(image.url, await saveImage(projectPath, image.bytes, image.extension));
  }
  for (const image of replacements.sort((a, b) => b.start - a.start)) {
    markdown = markdown.slice(0, image.start) + saved.get(image.url)! + markdown.slice(image.end);
  }
  return markdown;
}
