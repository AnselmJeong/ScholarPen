/**
 * BlockNote JSON with the AI-authorship style removed and the text runs it
 * split joined again, for tests that compare documents by their wording.
 */
export function withoutAuthorship<T>(blocks: T): T {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value.map(strip)) {
        const previous = out[out.length - 1] as { type?: string; text?: string; styles?: object } | undefined;
        const current = item as { type?: string; text?: string; styles?: object };
        if (previous?.type === "text" && current?.type === "text" && JSON.stringify(previous.styles) === JSON.stringify(current.styles)) {
          out[out.length - 1] = { ...previous, text: previous.text! + current.text! };
        } else out.push(item);
      }
      return out;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value).map(([key, inner]) => {
        if (key === "styles" && inner && typeof inner === "object") {
          const { aiAuthored: _ai, ...rest } = inner as Record<string, unknown>;
          return [key, rest];
        }
        return [key, strip(inner)];
      });
      return Object.fromEntries(entries);
    }
    return value;
  };
  return strip(blocks) as T;
}
