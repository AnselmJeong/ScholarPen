export const PROJECT_FILE_REFERENCE_ORIGIN = "https://scholarpen.local";
export const PROJECT_FILE_REFERENCE_PATH = "/project-file";

export interface ProjectFileReference {
  relativePath: string;
  page?: number;
}

export function normalizeProjectRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return null;
  if (/^[a-zA-Z]:\//.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

export function buildProjectFileReference(relativePath: string, page?: number): string {
  const safePath = normalizeProjectRelativePath(relativePath);
  if (!safePath) throw new Error("Project file reference must be a safe relative path.");
  const url = new URL(PROJECT_FILE_REFERENCE_PATH, PROJECT_FILE_REFERENCE_ORIGIN);
  url.searchParams.set("path", safePath);
  if (page !== undefined && Number.isInteger(page) && page > 0) {
    url.searchParams.set("page", String(page));
  }
  return url.toString();
}

export function parseProjectFileReference(value: string): ProjectFileReference | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== PROJECT_FILE_REFERENCE_ORIGIN || url.pathname !== PROJECT_FILE_REFERENCE_PATH) {
    return null;
  }
  const relativePath = normalizeProjectRelativePath(url.searchParams.get("path") ?? "");
  if (!relativePath) return null;
  const pageValue = url.searchParams.get("page");
  if (!pageValue) return { relativePath };
  const page = Number(pageValue);
  if (!Number.isInteger(page) || page < 1) return null;
  return { relativePath, page };
}
