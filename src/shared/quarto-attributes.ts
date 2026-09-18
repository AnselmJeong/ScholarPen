export function quartoAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/#([\w:.-]+)|([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g)) {
    if (match[1]) attrs.label = match[1];
    else attrs[match[2]] = (match[3] ?? match[4] ?? match[5]).replace(/&quot;/g, '"');
  }
  return attrs;
}

export function tableWidthRatios(source: string, columns: number): number[] | null {
  try {
    const values: unknown = JSON.parse(source);
    if (!Array.isArray(values) || values.length !== columns || !values.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return values.map((v) => 600 * v / sum);
  } catch { return null; }
}
