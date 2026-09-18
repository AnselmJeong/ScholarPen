export const FIGURE_MIME_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
};

export function figureMimeType(path: string): string | undefined {
  return FIGURE_MIME_TYPES[path.split(".").at(-1)?.toLowerCase() ?? ""];
}

/** Stored links are unescaped paths relative to the project, never absolute paths. */
export function isProjectFigurePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !/[\\\0]/.test(path) &&
    !/^[a-z][a-z\d+.-]*:/i.test(path) &&
    path.split("/").every((part) => part !== ".." && part !== "." && part !== "") &&
    Boolean(figureMimeType(path));
}

export interface FigureSelection {
  sourcePath: string;
  copied: boolean;
}

/** All current Markdown/Quarto exports are written directly inside exports/. */
export function figureExportUrl(sourcePath: string): string {
  if (!isProjectFigurePath(sourcePath)) throw new Error("Invalid linked figure path.");
  return "../" + sourcePath.split("/").map((part) => encodeURIComponent(part).replace(/[()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}
