import { blockLabel, LABEL_PREFIXES } from "../../shared/quarto-references";

/** Searchable source spelling only; never inspect arbitrary metadata or URLs. */
export function searchAnnotationText(type: string, props: Record<string, unknown> = {}): string {
  if (type === "citation" || type === "crossReference") {
    const key = type === "citation" ? props.citekey : props.label;
    if (typeof key !== "string" || !key) return "";
    const locator = typeof props.locator === "string" && props.locator ? `, ${props.locator}` : "";
    const text = `@${key}${locator}`;
    return type === "citation" ? `[${text}]` : text;
  }
  if (Object.hasOwn(LABEL_PREFIXES, type)) {
    const label = blockLabel({ type, props });
    return label ? `@${label}` : "";
  }
  return "";
}
