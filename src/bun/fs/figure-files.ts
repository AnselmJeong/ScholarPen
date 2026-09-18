import { constants } from "fs";
import { copyFile, mkdir, readFile, realpath, stat } from "fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "path";
import { figureMimeType, isProjectFigurePath, type FigureSelection } from "../../shared/figure-files";

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** Called only with a known project and a path returned by the native file picker. */
export async function linkSelectedFigure(projectPath: string, selectedPath: string): Promise<FigureSelection> {
  const root = await realpath(projectPath);
  const source = await realpath(selectedPath);
  if (!figureMimeType(source) || !(await stat(source)).isFile()) {
    throw new Error("Choose a PNG, JPEG, GIF, SVG, WebP, AVIF or BMP image.");
  }
  if (isInside(root, source)) {
    const sourcePath = relative(root, source);
    if (!isProjectFigurePath(sourcePath)) throw new Error("Unsupported figure path.");
    return { sourcePath, copied: false };
  }

  const figures = join(root, "figures");
  await mkdir(figures, { recursive: true });
  const targetDir = await realpath(figures);
  if (!isInside(root, targetDir)) throw new Error("The figures folder points outside this project.");
  const extension = extname(source);
  const stem = basename(source, extension);
  // COPYFILE_EXCL also protects against existing symlinks and concurrent imports.
  for (let suffix = 0; ; suffix++) {
    const destination = join(targetDir, `${stem}${suffix ? `-${suffix}` : ""}${extension}`);
    const sourcePath = relative(root, destination);
    if (!isProjectFigurePath(sourcePath)) throw new Error("Unsupported figure filename.");
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      return { sourcePath, copied: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function readLinkedFigure(projectPath: string, sourcePath: string): Promise<string> {
  if (!isProjectFigurePath(sourcePath)) throw new Error("Invalid linked figure path.");
  const root = await realpath(projectPath);
  const file = await realpath(resolve(root, sourcePath));
  if (!isInside(root, file)) throw new Error("The linked image points outside this project.");
  const bytes = await readFile(file);
  return `data:${figureMimeType(sourcePath)};base64,${bytes.toString("base64")}`;
}
