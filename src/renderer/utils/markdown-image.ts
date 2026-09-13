const imageMimeTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
};

/** Resolve local images against the document, without relying on webview URLs.
 * The existing binary-file RPC checks that the result belongs to an open project.
 */
export function resolveMarkdownImage(source: string, documentPath: string): { path: string; mime: string } | null {
  if (!source || source.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(source)) return null;
  const directory = documentPath.slice(0, documentPath.lastIndexOf("/") + 1);
  try {
    const url = new URL(source, `file://${directory.split("/").map(encodeURIComponent).join("/")}`);
    const path = decodeURIComponent(url.pathname);
    const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
    const mime = imageMimeTypes[extension];
    return mime ? { path, mime } : null;
  } catch {
    return null;
  }
}
